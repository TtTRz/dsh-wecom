import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { BaseMessage } from '@wecom/aibot-node-sdk'
import type { Config } from './config.js'
import { conversationId, Semaphore, timeout } from './helpers.js'
import { type MediaPort, safeFilename, saveUploadFile } from './media.js'
import { containsImageMedia, toContentBlocks } from './message.js'

/** One tool invocation observed during a turn, for the optional activity summary. */
export interface ToolCallSummary {
  name: string
  arguments: string
  ok: boolean
  error?: string
}

/** One streamed model delta: visible answer text or internal reasoning. */
export interface TurnDelta {
  kind: 'text' | 'reasoning'
  text: string
}

/** The text one finished turn produced, plus optional reasoning/tool activity. */
export interface Reply {
  text: string
  reasoning?: string
  toolCalls?: ToolCallSummary[]
}

/** Structural face of a workspace entity (absent outside web profiles). */
interface WorkspaceLike {
  attachSession(sessionId: string): Promise<void>
}
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
}

/** Structural face of the optional `sessionTitle` service. */
interface SessionTitleLike {
  get(session: unknown): unknown
  rename(session: unknown, title: string): unknown
}

/** Upper bound for auto-generated conversation titles. */
const TITLE_MAX_LENGTH = 60

/** Structural face of the optional `compaction` service (`ctx.compaction`). */
interface CompactionEngineLike {
  compactNow(
    agent: ManualCompactAgentLike,
    signal: AbortSignal,
    sourceCommandId?: unknown,
  ): Promise<CompactionResultLike | null>
}

/** Minimal agent face `compactNow` consumes; `Agent` satisfies it structurally. */
interface ManualCompactAgentLike {
  session: unknown
  options: { provider?: string; model?: string }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

interface CompactionResultLike {
  shadowedSeqs: readonly unknown[]
  shadowedTokenCount: number
}

/** Human-only outcomes for expected failures (mirrors `dsh-command-compact`). */
const COMPACT_FAILURE_TEXT: Readonly<Record<string, string>> = {
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed:
    'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
  summary:
    'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
  commit:
    'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
}

/**
 * One Harness agent per WeCom conversation: opened on first use, resumed from
 * persistence after restarts, and closed with the plugin. Each agent mounts a
 * preset in its scoped setup so it inherits the preset's tools and persona.
 */
export class AgentPool {
  private readonly log
  private readonly agents = new Map<string, AgentHandle>()
  private readonly pending = new Map<string, Promise<AgentHandle>>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly epochs = new Map<string, number>()
  private readonly semaphore: Semaphore
  private persisted = new Set<string>()
  private workspacePromise: Promise<WorkspaceLike | undefined> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    this.log = ctx.logger('dsh-wecom')
    this.semaphore = new Semaphore(config.maxConcurrent)
  }

  /**
   * Load persisted session ids, make sure the agent cwd exists, and try to
   * claim the grouping workspace. The workspace registry may not be mounted
   * yet while this plugin activates, so retry briefly here; the lazy path in
   * `groupSession` covers any later first message regardless.
   */
  async start(): Promise<void> {
    const headers = await this.ctx.sessionPersistence.list()
    this.persisted = new Set(headers.map((header) => String(header.id)))
    await mkdir(this.config.cwd, { recursive: true })
    this.loadEpochs()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if ((await this.ensureWorkspace()) !== undefined) break
      } catch {
        // Transient registry race; retried below and lazily per message.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // Re-attach every conversation persisted by this plugin so conversations
    // that predate a workspace-path change still regroup after a restart.
    const workspace = await this.ensureWorkspace().catch(() => undefined)
    if (workspace !== undefined) {
      for (const id of this.persisted) {
        if (id.startsWith('dsh-wecom-')) await this.groupSession(id)
      }
    }
  }

  /**
   * Resolve the grouping workspace once. Failures (including a not-yet-mounted
   * registry) are forgotten so the next call retries instead of caching the
   * miss forever.
   */
  private ensureWorkspace(): Promise<WorkspaceLike | undefined> {
    if (this.workspacePromise !== undefined) return this.workspacePromise
    const current = this.openWorkspace().then(
      (workspace) => {
        if (workspace === undefined) this.forgetWorkspace(current)
        return workspace
      },
      (error) => {
        this.forgetWorkspace(current)
        throw error
      },
    )
    this.workspacePromise = current
    return current
  }

  private forgetWorkspace(current: Promise<WorkspaceLike | undefined>): void {
    if (this.workspacePromise === current) this.workspacePromise = undefined
  }

  private async openWorkspace(): Promise<WorkspaceLike | undefined> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined) return undefined
    // Workspace membership is validated by canonical cwd, so the workspace
    // owns `cwd` itself and every agent runs there.
    return registry.create(this.config.cwd, this.config.workspaceTitle)
  }

  /**
   * Attach one conversation session to the grouping workspace, when claimed.
   * Best-effort by design: a session whose stored cwd predates the workspace
   * path (or any registry hiccup) must never fail the message itself — it
   * simply stays Ungrouped.
   */
  private async groupSession(id: string): Promise<void> {
    try {
      const workspace = await this.ensureWorkspace()
      await workspace?.attachSession(id)
    } catch (error) {
      this.log.error('WeCom workspace attach failed for %s: %s', id, String(error))
    }
  }

  /** First plain-text fragment of an inbound message, for session titling. */
  private firstTextOf(message: BaseMessage): string {
    if (message.msgtype === 'text') return message.text?.content ?? ''
    if (message.msgtype === 'mixed') {
      const mixed = message.mixed as
        | { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> }
        | undefined
      for (const item of mixed?.msg_item ?? []) {
        if (item.msgtype === 'text' && item.text?.content) return item.text.content
      }
    }
    return ''
  }

  /**
   * Name a still-untitled conversation from its first message. The web
   * sidebar hides titleless sessions (only the currently open one shows), so
   * this runs on creation and again on resume for pre-title era sessions.
   * Best-effort: a missing service or rename failure never fails the turn.
   */
  private async titleSession(agent: Agent, message: BaseMessage): Promise<void> {
    const sessionTitle = this.ctx.get('sessionTitle') as SessionTitleLike | undefined
    if (sessionTitle === undefined) return
    const session = agent.session
    if (sessionTitle.get(session) !== undefined) return
    const raw = this.firstTextOf(message).replace(/\s+/g, ' ').trim()
    if (raw === '') return
    const title = raw.length <= TITLE_MAX_LENGTH ? raw : `${raw.slice(0, TITLE_MAX_LENGTH - 1)}…`
    try {
      sessionTitle.rename(session, title)
    } catch (error) {
      this.log.error('WeCom session title failed: %s', String(error))
    }
  }

  /** Number of live conversation agents currently held. */
  size(): number {
    return this.agents.size
  }

  /**
   * Feed one message to its conversation's agent, serialized per conversation.
   * `onDelta` receives streamed model text and reasoning deltas as they are
   * produced (for incremental WeCom replies); it is optional and never called
   * when absent.
   */
  handle(
    message: BaseMessage,
    download: MediaPort['download'],
    onDelta?: (delta: TurnDelta) => void,
  ): Promise<Reply> {
    const { base, id } = this.locate(message)
    const target = this.skipArchived(base, id)
    const previous = this.chains.get(target) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.runTurn(target, message, download, onDelta))
    // `.then(onFul, onRej)` — never `.finally()` — so `marker` stays resolved
    // and its rejection is not leaked as an unhandled rejection when `current`
    // rejects (e.g. a response timeout). `marker` is only a queue position.
    const marker = current.then(
      () => {
        if (this.chains.get(target) === marker) this.chains.delete(target)
      },
      () => {
        if (this.chains.get(target) === marker) this.chains.delete(target)
      },
    )
    this.chains.set(target, marker)
    return current
  }

  /** Interrupt the conversation's running turn, if any. */
  cancel(message: BaseMessage): boolean {
    const { id } = this.locate(message)
    const agent = this.agents.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent === undefined || agent.status === 'idle') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /**
   * Compact the conversation's older history into a summary via the optional
   * `ctx.compaction` seam. The engine runs it as an idle-session maintenance
   * task, so the harness withholds waking input until the summary settles.
   */
  async compact(message: BaseMessage): Promise<string> {
    const compaction = this.ctx.get('compaction') as CompactionEngineLike | undefined
    if (compaction === undefined) return 'Compaction is not available in this harness build.'
    const { id } = this.locate(message)
    const agent = this.agents.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent === undefined) return 'No conversation yet — send a message first, then try /compact.'
    const signal = AbortSignal.timeout(this.config.turnTimeoutMs)
    try {
      const result = await compaction.compactNow(agent, signal)
      if (result === null) return 'No compactable history yet.'
      return `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`
    } catch (error) {
      if (signal.aborted) {
        return `Compaction timed out after ${Math.round(this.config.turnTimeoutMs / 1000)}s.`
      }
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string') {
        const text = COMPACT_FAILURE_TEXT[code]
        if (text !== undefined) return text
      }
      throw error
    }
  }

  /** Drop the current conversation; the next message starts a fresh session. */
  async forget(message: BaseMessage): Promise<void> {
    const base = conversationId(this.config.namespace, message)
    const nextEpoch = (this.epochs.get(base) ?? 0) + 1
    this.epochs.set(base, nextEpoch)
    this.saveEpochs()
    const oldId = this.withEpoch(base, nextEpoch - 1)
    const handle = this.agents.get(oldId)
    if (handle === undefined) return
    this.agents.delete(oldId)
    await handle.dispose()
  }

  /** Tear down every agent once queued turns have settled. */
  async dispose(): Promise<void> {
    await Promise.allSettled(this.chains.values())
    await Promise.allSettled([...this.agents.values()].map((handle) => handle.dispose()))
    this.agents.clear()
  }

  private locate(message: BaseMessage): { base: string; id: string } {
    const base = conversationId(this.config.namespace, message)
    return { base, id: this.withEpoch(base, this.epochs.get(base) ?? 0) }
  }

  private withEpoch(base: string, epoch: number): string {
    return epoch === 0 ? base : `${base}~g${epoch}`
  }

  /** Where the durable per-conversation epoch map lives (one hidden file in the agent cwd). */
  private epochStateFile(): string {
    return join(this.config.cwd, '.dsh-wecom-state.json')
  }

  /**
   * Restore the conversation epoch map from disk. `/new` (and the archived-id
   * skip) bump this map; without persisting it a process restart forgets the
   * reset, and the next message resumes the ORIGINAL session with its full
   * history. Loading here makes the reset survive restarts.
   */
  private loadEpochs(): void {
    try {
      const file = this.epochStateFile()
      if (!existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [base, epoch] of Object.entries(parsed)) {
        if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) {
          this.epochs.set(base, epoch)
        }
      }
    } catch (error) {
      this.log.warn('dsh-wecom epoch state load failed: %s', String(error))
    }
  }

  /** Persist the epoch map so conversation resets survive a restart. */
  private saveEpochs(): void {
    try {
      writeFileSync(this.epochStateFile(), JSON.stringify(Object.fromEntries(this.epochs)), 'utf8')
    } catch (error) {
      this.log.warn('dsh-wecom epoch state save failed: %s', String(error))
    }
  }

  /**
   * An archived session stays hidden in the web UI even when WeCom activity
   * resumes it, and the harness has no unarchive API — so skip archived ids by
   * bumping the conversation epoch until the candidate is visible again. The
   * fresh session appears in the sidebar once the first message lands.
   */
  private skipArchived(base: string, id: string): string {
    let candidate = id
    let epoch = this.epochs.get(base) ?? 0
    while (this.isArchived(candidate)) {
      epoch += 1
      candidate = this.withEpoch(base, epoch)
    }
    if (candidate !== id) {
      this.epochs.set(base, epoch)
      this.saveEpochs()
    }
    return candidate
  }

  private isArchived(id: string): boolean {
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | { archivedSessionIds?: readonly string[] }
        | undefined
      return registry?.archivedSessionIds?.includes(id) ?? false
    } catch {
      // The workspace service may not be mounted (or its state not yet
      // initialized); treat the session as visible rather than failing.
      return false
    }
  }

  private async runTurn(
    id: string,
    message: BaseMessage,
    download: MediaPort['download'],
    onDelta?: (delta: TurnDelta) => void,
  ): Promise<Reply> {
    const release = await this.semaphore.acquire()
    try {
      const agent = await this.liveAgentForTurn(id, message)
      return await this.driveTurn(agent, message, download, onDelta)
    } finally {
      release()
    }
  }

  /**
   * Resolve a LIVE agent for the turn. The pool may have tracked an agent that
   * its owner disposed while we waited on the semaphore (a `/new`/`/clear`, or
   * the user closing the session in the web UI); driving that agent's now
   * inactive scoped context (e.g. `agent.ctx.on`) throws, so re-open instead.
   */
  private async liveAgentForTurn(id: string, message: BaseMessage): Promise<Agent> {
    for (;;) {
      const agent = (await this.ensureAgent(id)).agent
      await this.titleSession(agent, message)
      if (this.ctx.agents.get(SessionId(id)) === agent) return agent
      this.agents.delete(id)
    }
  }

  private async driveTurn(
    agent: Agent,
    message: BaseMessage,
    download: MediaPort['download'],
    onDelta?: (delta: TurnDelta) => void,
  ): Promise<Reply> {
    const start = agent.session.events.length
    const reasoning: string[] = []
    const pendingCalls = new Map<string, { name: string; arguments: string }>()
    const toolCalls: ToolCallSummary[] = []
    // Observe this agent's session firehose for the duration of the turn:
    // forward text deltas for streaming and collect reasoning + tool activity
    // for the optional final summary. Scoped to the agent, so we see only its
    // events and the listener is torn down with `off()` after the turn.
    const off = agent.ctx.on('session/event', (_session, event: SessionEvent) => {
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta' && chunk.text) {
          onDelta?.({ kind: 'text', text: chunk.text })
        } else if (chunk.type === 'reasoning-delta' && chunk.text) {
          reasoning.push(chunk.text)
          onDelta?.({ kind: 'reasoning', text: chunk.text })
        }
      } else if (event.type === 'tool/call') {
        pendingCalls.set(event.data.callId, {
          name: event.data.name,
          arguments: event.data.arguments,
        })
      } else if (event.type === 'tool/result') {
        const call = pendingCalls.get(event.data.message.source.callId)
        toolCalls.push({
          name: call?.name ?? event.data.message.source.callId,
          arguments: call?.arguments ?? '',
          ok: event.data.error === undefined,
          error: event.data.error?.code,
        })
      }
    })
    try {
      const includeImages = containsImageMedia(message) ? await this.canViewImages(agent) : false
      const content = await toContentBlocks(message, this.mediaPort(download), includeImages)
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await this.settleTurn(agent)
    } finally {
      off()
    }
    const reply = this.extractText(agent.session.events.slice(start))
    if (reasoning.length > 0) reply.reasoning = reasoning.join('')
    if (toolCalls.length > 0) reply.toolCalls = toolCalls
    return reply
  }

  private async settleTurn(agent: Agent): Promise<void> {
    try {
      await timeout(agent.whenIdle(), this.config.turnTimeoutMs, 'agent response')
    } catch (error) {
      // A timeout must not leave a zombie turn: cancel it so the next message
      // is not queued behind work that will never finish.
      if (agent.status !== 'idle') agent.cancel({ kind: 'user' })
      throw error
    }
  }

  private async ensureAgent(id: string): Promise<AgentHandle> {
    const existing = this.agents.get(id)
    if (existing !== undefined) {
      // The tracked agent may have been disposed by its real owner (e.g. the
      // user closed the session in the web UI); drop stale entries and re-open.
      if (this.ctx.agents.get(SessionId(id)) === existing.agent) return existing
      this.agents.delete(id)
    }
    const pending = this.pending.get(id)
    if (pending !== undefined) return pending

    const creation = this.openAgent(id).finally(() => this.pending.delete(id))
    this.pending.set(id, creation)
    const handle = await creation
    this.agents.set(id, handle)
    return handle
  }

  private async openAgent(id: string): Promise<AgentHandle> {
    const sessionId = SessionId(id)
    // The session can already be live — e.g. the user opened this conversation
    // in the web UI, which resumes the persisted session. Preparing it a second
    // time throws "cannot prepare session ... while it is live", so adopt the
    // live agent instead of fighting for the session. It was resumed with the
    // same stored preset, so it answers WeCom messages identically. We don't
    // own it: disposal is a no-op so the UI keeps its session.
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      this.mountWecomInstructions(live)
      return { agent: live, dispose: async () => undefined }
    }

    const agentOptions = this.modelOptions()
    const resolvedPreset = (await this.ctx.agentPresets.resolve(this.config.preset)).id
    const setup = this.mountPreset(resolvedPreset)

    if (this.persisted.has(id)) {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
      await this.groupSession(id)
      return handle
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.config.cwd, agentPreset: resolvedPreset },
      agentOptions,
      setup,
    })
    this.persisted.add(id)
    await this.groupSession(id)
    return handle
  }

  /**
   * Mount the WeCom instruction section on an agent we adopted from elsewhere
   * (the web UI resume mounts the stored preset but not this section). The
   * registration throws on a duplicate name, which simply means we adopted
   * this agent before — the section is already in place.
   */
  private mountWecomInstructions(agent: Agent): void {
    try {
      agent.ctx.systemPrompt.section({
        name: 'wecom-instructions',
        order: 50,
        text: this.config.instructions,
      })
    } catch (error) {
      this.log.debug('WeCom instruction section already registered: %s', String(error))
    }
  }

  private mountPreset(presetId: string): AgentSetup {
    const instructions = this.config.instructions
    const presets = this.ctx.agentPresets
    return async (agentCtx: Context) => {
      await presets.mount(agentCtx, presetId)
      // Persistent (not one-shot) WeCom instruction, rendered on every turn.
      agentCtx.systemPrompt.section({
        name: 'wecom-instructions',
        order: 50,
        text: instructions,
      })
    }
  }

  private mediaPort(download: MediaPort['download']): MediaPort {
    const attachments = this.ctx.attachments
    const cwd = this.config.cwd
    return {
      download,
      saveImage: async (data, mediaType, name) => {
        const ref = await attachments.saveImage({
          data,
          mediaType,
          ...(name ? { name } : {}),
        })
        return { type: 'image', attachment: ref }
      },
      saveUpload: (data, filename) =>
        saveUploadFile(cwd, data, safeFilename(filename, 'upload.bin')),
      limits: {
        maxImages: attachments.imageLimits.maxImagesPerMessage,
        maxBytes: attachments.imageLimits.maxMessageImageBytes,
      },
    }
  }

  private async canViewImages(agent: Agent): Promise<boolean> {
    if (this.config.imageMode === 'always') return true
    if (this.config.imageMode === 'never') return false
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') ?? false
  }

  private modelOptions(): { provider: string; model: string } {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return { provider: selection.provider, model: selection.model }
  }

  private extractText(events: readonly SessionEvent[]): Reply {
    const texts: string[] = []
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim())
      }
    }

    const finalTurn = [...events].reverse().find((event) => event.type === 'turn/end')
    if (
      texts.length === 0 &&
      finalTurn?.type === 'turn/end' &&
      finalTurn.data.reason.kind === 'error'
    ) {
      return { text: `Failed (${finalTurn.data.reason.error.code}). Please try again.` }
    }
    if (texts.length === 0) {
      return { text: 'Done, but nothing sendable was produced.' }
    }
    return { text: texts.join('\n\n') }
  }
}
