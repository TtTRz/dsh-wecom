import { mkdir } from 'node:fs/promises'
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

/** The text one finished turn produced. */
export interface Reply {
  text: string
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

  /** Feed one message to its conversation's agent, serialized per conversation. */
  handle(message: BaseMessage, download: MediaPort['download']): Promise<Reply> {
    const { id } = this.locate(message)
    const previous = this.chains.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.runTurn(id, message, download))
    // `.then(onFul, onRej)` — never `.finally()` — so `marker` stays resolved
    // and its rejection is not leaked as an unhandled rejection when `current`
    // rejects (e.g. a response timeout). `marker` is only a queue position.
    const marker = current.then(
      () => {
        if (this.chains.get(id) === marker) this.chains.delete(id)
      },
      () => {
        if (this.chains.get(id) === marker) this.chains.delete(id)
      },
    )
    this.chains.set(id, marker)
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

  /** Drop the current conversation; the next message starts a fresh session. */
  async forget(message: BaseMessage): Promise<void> {
    const base = conversationId(this.config.namespace, message)
    const nextEpoch = (this.epochs.get(base) ?? 0) + 1
    this.epochs.set(base, nextEpoch)
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

  private async runTurn(
    id: string,
    message: BaseMessage,
    download: MediaPort['download'],
  ): Promise<Reply> {
    const handle = await this.ensureAgent(id)
    const agent = handle.agent
    // The web sidebar hides titleless sessions (only the current one shows),
    // so name the conversation from its first message — on creation and again
    // on resume when a pre-title era session is still blank.
    await this.titleSession(agent, message)
    const release = await this.semaphore.acquire()
    try {
      const start = agent.session.events.length
      const includeImages = containsImageMedia(message) ? await this.canViewImages(agent) : false
      const content = await toContentBlocks(message, this.mediaPort(download), includeImages)
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await this.settleTurn(agent)
      return this.extractText(agent.session.events.slice(start))
    } finally {
      release()
    }
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
    if (existing !== undefined) return existing
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
