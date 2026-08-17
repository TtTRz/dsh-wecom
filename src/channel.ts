import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  type BaseMessage,
  type EnterChatEvent,
  type EventMessageWith,
  generateReqId,
  type Logger,
  WSAuthFailureError,
  WSClient,
  type WSClientOptions,
  WSReconnectExhaustedError,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
import type { Config } from './config.js'
import { clipUtf8, Dedupe, timeout } from './helpers.js'
import { AgentPool, type Reply } from './pool.js'

/** The subset of the official SDK this channel calls (kept minimal for test doubles). */
export interface BotClient {
  readonly isConnected: boolean
  on(event: 'connected' | 'authenticated', handler: () => void): this
  on(event: 'disconnected', handler: (reason: string) => void): this
  on(event: 'reconnecting', handler: (attempt: number) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'message', handler: (frame: WsFrame<BaseMessage>) => void | Promise<void>): this
  on(
    event: 'event.enter_chat',
    handler: (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => void | Promise<void>,
  ): this
  on(event: 'event.disconnected_event', handler: () => void): this
  connect(): this
  disconnect(): void
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>
  replyWelcome(
    frame: WsFrameHeaders,
    body: { msgtype: 'text'; text: { content: string } },
  ): Promise<unknown>
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Uint8Array; filename?: string }>
}

export type BotClientFactory = (options: WSClientOptions) => BotClient

/** JSON-safe point-in-time health of the WeCom channel. */
export interface ChannelStatus {
  /** Whether the long connection is currently open. */
  connected: boolean
  /** Whether the channel is tearing down. */
  stopping: boolean
  /** Number of live conversation agents held by the pool. */
  conversations: number
  /** Epoch ms of the last successful authentication, or null before it. */
  authenticatedAt: number | null
  /** Message of the most recent connection error, or null when none. */
  lastError: string | null
}

/** Status access consumed by dashboards and other UI surfaces. */
export interface ChannelStatusService {
  snapshot(): ChannelStatus
}

const COMMANDS = new Set(['/ping', '/help', '/status', '/stop', '/compact', '/new', '/clear'])

/**
 * Assemble one WeCom stream frame from reasoning and visible text. The WeCom
 * client converts the FIRST `<think>…</think>` block into its native
 * "思考过程" card, so reasoning rides inside the tag: while only reasoning
 * exists the tag stays OPEN (the client shows the thinking state); it closes
 * once visible text arrives or the stream finishes. Nested/foreign think tags
 * in the model output are stripped so the client always sees exactly one.
 */
export function buildStreamContent(
  reasoningText: string,
  visibleText: string,
  finish: boolean,
): string {
  const reasoning = reasoningText
    .replace(/<\s*\/?\s*(?:think(?:ing)?|thought)\b[^<>]*>/gi, '')
    .trim()
  const visible = visibleText.trim()
  if (!reasoning) return visible
  const think = finish || visible ? `<think>${reasoning}</think>` : `<think>${reasoning}`
  return visible ? `${think}\n${visible}` : think
}

/**
 * Accumulates streamed model deltas (visible text + reasoning) and flushes the
 * growing full content to WeCom on a throttle. WeCom's stream reply REPLACES
 * the message content on every frame (same stream id), so each flush sends the
 * complete accumulated content, never a delta. The final `finish: true` frame
 * is sent separately by the caller and carries the authoritative reply text.
 */
class StreamSink {
  private text = ''
  private reasoning = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastSent = ''

  constructor(
    private readonly send: (content: string, finish: boolean) => Promise<void>,
    private readonly flushMs: number,
    private readonly limitBytes: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(kind: 'text' | 'reasoning', delta: string): void {
    if (!delta) return
    if (kind === 'reasoning') this.reasoning += delta
    else this.text += delta
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush(false).catch(this.onError)
      }, this.flushMs)
    }
  }

  async flush(finish: boolean): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const content = clipUtf8(buildStreamContent(this.reasoning, this.text, finish), this.limitBytes)
    if (!finish && (content === '' || content === this.lastSent)) return
    this.lastSent = content
    await this.send(content, finish)
  }
}

/** Truncate to at most `max` characters, keeping the head. */
function elideHead(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** Truncate to at most `max` characters, keeping the tail (most recent reasoning). */
function elideTail(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`
}

/**
 * A compact, readable preview of one tool call's arguments: the most
 * informative scalar field when the JSON parses, otherwise the raw string,
 * flattened and truncated.
 */
function toolArgPreview(argumentsJson: string, max: number): string {
  let value = ''
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'name', 'query', 'text']) {
      const candidate = parsed[key]
      if (typeof candidate === 'string' && candidate.trim()) {
        value = candidate
        break
      }
    }
  } catch {
    // Not JSON — fall back to the raw string below.
  }
  return elideHead((value || argumentsJson).replace(/\s+/g, ' '), max)
}

/** Owns the WeCom WebSocket and funnels each message into a Harness agent. */
export class WecomChannel {
  private readonly log
  private readonly pool: AgentPool
  private readonly dedupe: Dedupe
  private client: BotClient | undefined
  private stopping = false
  private authenticatedAt: number | null = null
  private lastError: string | null = null
  /** Resolved when the connection is unrecoverable or the channel stops. */
  private dead = Promise.withResolvers<void>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly clientFactory: BotClientFactory = (options) => new WSClient(options),
  ) {
    if (!isAbsolute(config.cwd)) {
      throw new Error(`dsh-wecom: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    }
    this.log = ctx.logger('dsh-wecom')
    this.pool = new AgentPool(ctx, config)
    this.dedupe = new Dedupe(config.dedupeLimit)
  }

  /** Connect and authenticate before accepting any traffic. */
  async start(): Promise<void> {
    this.dead = Promise.withResolvers<void>()
    await this.pool.start()
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialName))
    if (resolved === undefined) {
      throw new Error(
        `dsh-wecom: credential ${JSON.stringify(this.config.credentialName)} is not configured`,
      )
    }
    const client = this.openClient(resolved.value)
    this.client = client

    const ready = Promise.withResolvers<void>()
    let readySettled = false
    const resolveReady = (): void => {
      if (readySettled) return
      readySettled = true
      ready.resolve()
    }
    const rejectReady = (error: Error): void => {
      if (readySettled) return
      readySettled = true
      ready.reject(error)
    }

    client.on('connected', () => this.log.info('WeCom WebSocket connected; authenticating'))
    client.on('authenticated', () => {
      this.authenticatedAt = Date.now()
      // A successful (re)connect clears the sticky error: the panel must not
      // keep showing a failure the channel already recovered from. The
      // recovered message is logged first so the incident stays traceable.
      if (this.lastError !== null) {
        this.log.info('WeCom recovered after: %s', this.lastError)
        this.lastError = null
      }
      resolveReady()
    })
    client.on('disconnected', (reason) => {
      if (!this.stopping) this.log.warn('WeCom WebSocket disconnected: %s', reason)
    })
    client.on('reconnecting', (attempt) =>
      this.log.warn('WeCom WebSocket reconnect attempt %d', attempt),
    )
    client.on('error', (error) => {
      if (!this.stopping) {
        this.lastError = error.message
        this.log.error('WeCom WebSocket error: %s', error.message)
      }
      if (error instanceof WSAuthFailureError || error instanceof WSReconnectExhaustedError) {
        rejectReady(error)
        this.dead.resolve()
      }
    })
    client.on('event.disconnected_event', () => {
      if (!this.stopping) {
        this.lastError = 'Connection replaced by another client for this Bot ID'
        this.log.error(this.lastError)
      }
      // Another client took the bot. Reclaim it: the owning loop restarts us.
      this.dead.resolve()
    })
    client.on('message', async (frame) => this.onMessage(frame))
    client.on('event.enter_chat', async (frame) => this.greet(frame))

    try {
      client.connect()
      await timeout(ready.promise, this.config.connectTimeoutMs, 'WeCom authentication')
      this.log.info('WeCom AI Bot authenticated for Bot ID %s', this.config.botId)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** Drop the socket and shut down the agent pool. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.dead.resolve()
    this.client?.disconnect()
    await this.pool.dispose()
  }

  /**
   * Force an immediate reconnect: drop the current socket and wake the owning
   * restart loop, which re-runs {@link start} after `restartIntervalMs`. The
   * channel stays non-stopping, so the bot comes back on its own — this is the
   * "restart the long connection now" control, not a shutdown. A no-op while
   * stopping.
   */
  reconnect(): void {
    if (this.stopping) return
    this.client?.disconnect()
    this.dead.resolve()
  }

  /** Resolves when the connection becomes unrecoverable or `stop()` runs. */
  untilDead(): Promise<void> {
    return this.dead.promise
  }

  /** Point-in-time health for dashboards; scalar fields only, no live objects. */
  snapshot(): ChannelStatus {
    return {
      connected: this.client?.isConnected ?? false,
      stopping: this.stopping,
      conversations: this.pool.size(),
      authenticatedAt: this.authenticatedAt,
      lastError: this.lastError,
    }
  }

  private openClient(secret: string): BotClient {
    const sdkLogger: Logger = {
      debug: (message, ...args) => this.log.debug(message, ...args),
      info: (message, ...args) => this.log.info(message, ...args),
      warn: (message, ...args) => this.log.warn(message, ...args),
      error: (message, ...args) => this.log.error(message, ...args),
    }
    return this.clientFactory({
      botId: this.config.botId,
      secret,
      wsUrl: this.config.wsUrl,
      logger: sdkLogger,
      reconnectInterval: this.config.reconnectIntervalMs,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      maxAuthFailureAttempts: this.config.maxAuthFailureAttempts,
      requestTimeout: this.config.sendTimeoutMs,
    })
  }

  private async greet(frame: WsFrame<EventMessageWith<EnterChatEvent>>): Promise<void> {
    if (!this.config.greeting.trim()) return
    try {
      await timeout(
        this.liveClient().replyWelcome(frame, {
          msgtype: 'text',
          text: { content: clipUtf8(this.config.greeting, this.config.replyLimitBytes) },
        }),
        this.config.sendTimeoutMs,
        'WeCom welcome reply',
      )
    } catch (error) {
      this.log.error('WeCom welcome reply failed: %s', String(error))
    }
  }

  private async onMessage(frame: WsFrame<BaseMessage>): Promise<void> {
    const message = frame.body
    if (message === undefined || this.dedupe.seen(message.msgid) || !this.permits(message)) return

    const command = commandOf(message)
    if (COMMANDS.has(command)) {
      await this.onCommand(frame, message, command)
      return
    }

    const streamId = generateReqId('dsh')
    const sink = this.config.streaming
      ? new StreamSink(
          (content, finish) => this.sendStreamBestEffort(frame, streamId, content, finish),
          this.config.streamFlushMs,
          this.config.replyLimitBytes,
          (error) => this.log.error('WeCom stream flush failed: %s', String(error)),
        )
      : undefined
    try {
      await this.sendStream(frame, streamId, 'Working…', false)
      const reply = await this.pool.handle(
        message,
        (url, aesKey) =>
          this.liveClient()
            .downloadFile(url, aesKey)
            .then((result) => ({ data: result.buffer, filename: result.filename })),
        sink
          ? (delta) => {
              if (delta.kind === 'reasoning' && !this.config.showReasoning) return
              sink.push(delta.kind, delta.text)
            }
          : undefined,
      )
      await sink?.flush(false)
      await this.sendStream(
        frame,
        streamId,
        clipUtf8(this.renderReply(reply), this.config.replyLimitBytes),
        true,
      )
    } catch (error) {
      this.log.error('WeCom message %s failed: %s', message.msgid, String(error))
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await this.sendStream(
          frame,
          streamId,
          clipUtf8(`Something went wrong: ${detail}`, this.config.replyLimitBytes),
          true,
        )
      } catch (sendError) {
        this.log.error('WeCom error reply failed: %s', String(sendError))
      }
    }
  }

  private async onCommand(
    frame: WsFrame<BaseMessage>,
    message: BaseMessage,
    command: string,
  ): Promise<void> {
    const streamId = generateReqId('dsh')
    if (command === '/ping') {
      await this.sendStream(frame, streamId, 'pong — dsh-wecom connected.', true)
      return
    }
    if (command === '/help') {
      await this.sendStream(
        frame,
        streamId,
        [
          'dsh-wecom bot',
          '/ping — connectivity check',
          '/help — list commands',
          '/status — session status',
          '/stop — cancel the current generation',
          '/compact — summarize older history to save context',
          '/new — start a fresh conversation (history is kept)',
          '/clear — alias of /new (clear context, start fresh)',
          'Anything else goes to the current Harness default model.',
        ].join('\n'),
        true,
      )
      return
    }
    if (command === '/status') {
      await this.sendStream(
        frame,
        streamId,
        'Long connection healthy; sessions are persisted per single/group chat.',
        true,
      )
      return
    }
    if (command === '/stop') {
      const cancelled = this.pool.cancel(message)
      await this.sendStream(
        frame,
        streamId,
        cancelled ? 'Cancellation requested.' : 'No generation in progress.',
        true,
      )
      return
    }
    if (command === '/compact') {
      const text = await this.pool.compact(message)
      await this.sendStream(frame, streamId, text, true)
      return
    }
    if (command === '/new' || command === '/clear') {
      await this.pool.forget(message)
      await this.sendStream(frame, streamId, 'Started a new conversation.', true)
    }
  }

  private permits(message: BaseMessage): boolean {
    if (message.chattype === 'group') {
      if (this.config.groupPolicy === 'disabled') return false
      if (this.config.groupPolicy === 'open') return true
      // Allowlist is scoped by group chatid, not sender userid, so a bot added
      // to an unwanted group stays silent regardless of who mentions it.
      return message.chatid !== undefined && this.config.groupAllowlist.includes(message.chatid)
    }
    if (this.config.dmPolicy === 'disabled') return false
    if (this.config.dmPolicy === 'open') return true
    return this.config.dmAllowlist.includes(message.from.userid)
  }

  private async sendStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<void> {
    await this.retry(async () =>
      timeout(
        this.liveClient().replyStream(frame, streamId, content, finish),
        this.config.sendTimeoutMs,
        'WeCom reply send',
      ),
    )
  }

  /**
   * Best-effort stream frame for intermediate text: a dropped or failed frame
   * is fine because the authoritative `finish: true` frame carries everything.
   */
  private async sendStreamBestEffort(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<void> {
    try {
      await timeout(
        this.liveClient().replyStream(frame, streamId, content, finish),
        this.config.sendTimeoutMs,
        'WeCom stream reply',
      )
    } catch (error) {
      this.log.error('WeCom stream reply failed: %s', String(error))
    }
  }

  /**
   * The final reply: the native `<think>` card carrying the whole process
   * (reasoning plus tool-call activity), then the clean answer text. The
   * answer gets priority under the WeCom byte cap; the process content is
   * budgeted out of what remains.
   */
  private renderReply(reply: Reply): string {
    const process = this.renderProcess(reply)
    const processBytes = Buffer.byteLength(process) + 16
    const textBudget = Math.max(0, this.config.replyLimitBytes - processBytes)
    return buildStreamContent(process, clipUtf8(reply.text, textBudget), true)
  }

  /**
   * Everything that belongs inside the think card: the model reasoning and a
   * compact tool-call activity list. WeCom has no native tool-call element, so
   * tool activity rides inside the think block instead of polluting the reply
   * body.
   */
  private renderProcess(reply: Reply): string {
    const parts: string[] = []
    if (this.config.showReasoning && reply.reasoning) {
      parts.push(elideTail(reply.reasoning, 2_000))
    }
    const tools = this.renderToolCalls(reply)
    if (tools !== '') parts.push(tools)
    return parts.join('\n\n')
  }

  private renderToolCalls(reply: Reply): string {
    if (
      !this.config.showToolCalls ||
      reply.toolCalls === undefined ||
      reply.toolCalls.length === 0
    ) {
      return ''
    }
    const lines = reply.toolCalls.map((call) => {
      const args = toolArgPreview(call.arguments, 80)
      const status = call.ok ? '' : ` (失败${call.error ? `: ${call.error}` : ''})`
      return `- ${call.name}${args ? `: ${args}` : ''}${status}`
    })
    return `工具调用:\n${lines.join('\n')}`
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.sendAttempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt < this.config.sendAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
    }
    throw lastError
  }

  private liveClient(): BotClient {
    if (this.client === undefined || !this.client.isConnected) {
      throw new Error('dsh-wecom: client is not connected')
    }
    return this.client
  }
}

function commandOf(message: BaseMessage): string {
  if (message.msgtype === 'text') return message.text?.content?.trim().toLowerCase() ?? ''
  if (message.msgtype !== 'mixed') return ''
  const mixed = message.mixed as
    | {
        msg_item?: Array<{ msgtype?: string; text?: { content?: string } }>
      }
    | undefined
  return (mixed?.msg_item ?? [])
    .filter((item) => item.msgtype === 'text')
    .map((item) => item.text?.content ?? '')
    .join('')
    .trim()
    .toLowerCase()
}
