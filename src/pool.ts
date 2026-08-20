import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  type Agent,
  type AgentHandle,
  type AgentSetup,
  installModelSelection,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { BaseMessage } from '@wecom/aibot-node-sdk'
import type { ResolvedConfig } from './config.js'
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
  rename(session: unknown, title: string): unknown
}

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
  /** Title prefix per conversation: the userid for single chats, the chatid for groups. */
  private readonly titlePrefixes = new Map<string, string>()
  /** Persisted peer per conversation BASE id (survives restarts), see {@link loadState}. */
  private readonly peers = new Map<string, string>()
  /** Canonical title per conversation, enforced against manual renames. */
  private readonly canonicalTitles = new Map<string, string>()
  /** Optional fixed model route from the plugin config (`provider` + `model`). */
  private readonly configuredModel: ModelSelection | undefined
  private workspacePromise: Map<string, Promise<WorkspaceLike | undefined>> | undefined
  /** Stored session cwd per conversation id, loaded at start and updated on create. */
  private headerCwds = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    this.log = ctx.logger('dsh-wecom')
    this.semaphore = new Semaphore(config.maxConcurrent)
    const provider = config.provider
    const model = config.model
    if ((provider === undefined) !== (model === undefined)) {
      throw new Error('dsh-wecom: provider and model must be configured together')
    }
    this.configuredModel =
      provider !== undefined && model !== undefined ? { provider, model } : undefined
    // Lock WeCom session titles host-wide: observe every title event, prefix
    // harness-generated LLM titles, and revert manual renames. A host-level
    // listener (not per-agent) covers sessions resumed outside this pool —
    // e.g. the web UI opening a conversation or the API renaming a closed
    // session. Cordis disposes it with the plugin fiber.
    ctx.on('session/event', (session, event) => {
      this.enforceSessionTitle(session, event)
    })
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
    for (const header of headers) {
      const cwd = (header as { cwd?: string }).cwd
      if (cwd !== undefined) this.headerCwds.set(String(header.id), cwd)
    }
    await mkdir(this.config.cwd, { recursive: true })
    this.loadState()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (this.ctx.get('workspaceRegistry') !== undefined) break
      } catch {
        // Transient registry race; retried below and lazily per message.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // Re-attach conversations whose session cwd already matches their
    // per-chat directory, so they regroup after a restart. Sessions with a
    // different stored cwd (legacy shared-base sessions) keep their existing
    // grouping and never mint empty per-chat rows. The registry probe above
    // gates the retry loop only; workspaces resolve inside groupSession.
    if (this.ctx.get('workspaceRegistry') !== undefined) {
      for (const header of headers) {
        const id = String(header.id)
        const cwd = (header as { cwd?: string }).cwd
        if (id.startsWith('dsh-wecom-') && cwd !== undefined) {
          await this.groupSession(id, cwd)
        }
      }
    }
  }

  /**
   * Resolve one conversation's grouping workspace. Failures (including a
   * not-yet-mounted registry) are forgotten so the next call retries instead of
   * caching the miss forever.
   */
  private ensureWorkspace(id: string): Promise<WorkspaceLike | undefined> {
    // Keyed by the per-chat directory, not the conversation id: every epoch
    // of one chat resolves to the same workspace row and one create() call.
    const dir = this.conversationDir(id)
    this.workspacePromise ??= new Map()
    const cached = this.workspacePromise.get(dir)
    if (cached !== undefined) return cached
    const current = this.openWorkspace(id).then(
      (workspace) => {
        if (workspace === undefined) this.forgetWorkspace(dir, current)
        return workspace
      },
      (error) => {
        this.forgetWorkspace(dir, current)
        throw error
      },
    )
    this.workspacePromise.set(dir, current)
    return current
  }

  private forgetWorkspace(dir: string, current: Promise<WorkspaceLike | undefined>): void {
    if (this.workspacePromise?.get(dir) === current) {
      this.workspacePromise.delete(dir)
    }
  }

  private async openWorkspace(id: string): Promise<WorkspaceLike | undefined> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined) return undefined
    // Workspace membership is validated by canonical cwd (the session cwd must
    // equal the workspace path), and every conversation now runs in its own
    // subdirectory (see conversationDir), so the grouping workspace is
    // per-conversation too — one sidebar row per WeCom chat.
    const cwd = this.conversationDir(id)
    await mkdir(cwd, { recursive: true })
    return registry.create(cwd, `${this.config.workspaceTitle} · ${this.shortId(id)}`)
  }

  /** Short, human-readable suffix for per-conversation workspace titles. */
  private shortId(id: string): string {
    const base = this.baseId(id)
    return `${base.startsWith('dsh-wecom-group-') ? 'group' : 'chat'}·${base.slice(-6)}`
  }

  /**
   * Per-chat sandbox cwd: every WeCom chat gets its own subdirectory under the
   * configured base, so the harness sandbox fence (workspace-write against
   * SessionHeader.cwd) isolates each chat's filesystem — uploads and
   * intermediate files from one chat are unreachable from another. The
   * directory is keyed by the epoch-free base id: every /reset epoch of one
   * chat shares it, so the sidebar shows ONE workspace row per chat and the
   * security boundary stays "between chats", which is the real boundary.
   * State and epoch data stay in the shared base directory.
   *
   * Directory naming: `{Chat|Group}_{peerId}_{firstSeen}_{hash6}` — readable
   * peer id and the chat's first-seen timestamp, suffixed with 6 hash chars
   * of the stable base id so renames and peer-id collisions can never merge
   * or split a chat's identity. Pre-readable dirs (raw base id) are adopted
   * as-is once a chat already has one, so live sessions never move.
   */
  private conversationDir(id: string): string {
    const base = this.baseId(id)
    const legacy = join(this.config.cwd, base)
    if (existsSync(legacy)) return legacy
    const hash6 = base.slice(-6)
    const pattern = new RegExp(`^(Chat|Group)_.*_${hash6}$`)
    try {
      const hit = readdirSync(this.config.cwd).find((name) => pattern.test(name))
      if (hit !== undefined) return join(this.config.cwd, hit)
    } catch {
      // base not readable yet — fall through to mint a new name
    }
    return join(this.config.cwd, `${this.chatScope(id)}_${this.peerTag(id)}_${this.firstSeenStamp()}_${hash6}`)
  }

  /** 'Chat' for single chats, 'Group' for group chats, from the id prefix. */
  private chatScope(id: string): string {
    return this.baseId(id).startsWith('dsh-wecom-group-') ? 'Group' : 'Chat'
  }

  /** Readable, filesystem-safe peer tag for the directory name. */
  private peerTag(id: string): string {
    const peer = this.peers.get(this.baseId(id)) ?? this.baseId(id)
    return peer.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'peer'
  }

  /** Lexically sortable first-seen stamp for directory names. */
  private firstSeenStamp(): string {
    const d = new Date()
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  /**
   * Attach one conversation session to the grouping workspace, when claimed.
   * Best-effort by design: a session whose stored cwd predates the workspace
   * path (or any registry hiccup) must never fail the message itself — it
   * simply stays Ungrouped.
   */
  private async groupSession(id: string, headerCwd?: string): Promise<void> {
    // Workspace membership validates the session cwd against the workspace
    // path. Creating the row for a session whose header cwd differs (legacy
    // sessions under the shared base, or pre-fix epoch dirs) would persist an
    // empty row, so skip those entirely — they stay wherever they already sit.
    if (headerCwd !== undefined && headerCwd !== this.conversationDir(id)) return
    try {
      const workspace = await this.ensureWorkspace(id)
      await workspace?.attachSession(id)
    } catch (error) {
      this.log.error('WeCom workspace attach failed for %s: %s', id, String(error))
    }
  }

  /**
   * Remember the title prefix of a conversation. The harness generates
   * session titles automatically (an LLM short title); the prefix becomes the
   * sidebar prefix ("前缀：标题") — the sender userid for single chats, the
   * group chatid for group chats. Recorded before the message is delivered so
   * the session-title watcher always has a prefix once a title event lands,
   * and persisted under the conversation's base id so the status panel can
   * show the peer right after a restart.
   */
  private rememberTitlePrefix(id: string, message: BaseMessage): void {
    if (this.titlePrefixes.has(id)) return
    const prefix =
      message.chattype === 'group' ? (message.chatid ?? message.from.userid) : message.from.userid
    this.titlePrefixes.set(id, prefix)
    const base = this.baseId(id)
    if (this.peers.get(base) !== prefix) {
      this.peers.set(base, prefix)
      this.saveState()
    }
  }

  /**
   * Enforce the canonical title of one WeCom session. Harness-generated
   * titles (deterministic fallback and LLM provider) are tracked; the LLM one
   * is rewritten as "prefix：标题" (userid for single chats, chatid for
   * groups). Manual renames in the web UI append a user-sourced title that
   * differs from the canonical one — those are reverted, so WeCom sessions
   * cannot be renamed. Our own rewrites carry the canonical text and pass
   * through untouched. All rewrites are deferred off the append broadcast and
   * best-effort: a missing service or rename failure never fails the turn.
   */
  private enforceSessionTitle(session: Session, event: SessionEvent): void {
    const id = session.id
    if (!id.startsWith('dsh-wecom-')) return
    const type = event.type as string
    if (type !== 'session/title') return
    const { title, source } = event.data as {
      title?: unknown
      source?: { kind?: unknown }
    }
    if (typeof title !== 'string') return
    const kind = source?.kind
    if (kind === 'provider') {
      const prefix = this.peerOf(id)
      const canonical = prefix === undefined ? title : `${prefix}：${title}`
      this.canonicalTitles.set(id, canonical)
      if (prefix !== undefined) this.renameSession(session, canonical)
      return
    }
    if (kind === 'fallback') {
      this.canonicalTitles.set(id, title)
      return
    }
    if (kind === 'user') {
      let canonical = this.canonicalTitles.get(id)
      if (canonical === undefined) {
        canonical = this.previousTitle(session.events, event.seq) ?? title
      }
      this.canonicalTitles.set(id, canonical)
      if (title !== canonical) this.renameSession(session, canonical)
    }
  }

  /** Latest `session/title` text strictly before one event seq, if any. */
  private previousTitle(events: readonly SessionEvent[], seq: number): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined) continue
      if (event.seq >= seq) continue
      const type = event.type as string
      if (type !== 'session/title') continue
      const { title } = event.data as { title?: unknown }
      return typeof title === 'string' ? title : undefined
    }
    return undefined
  }

  /** Best-effort deferred rename of a live WeCom session. */
  private renameSession(session: Session, title: string): void {
    void Promise.resolve().then(() => {
      try {
        const sessionTitle = this.ctx.get('sessionTitle') as SessionTitleLike | undefined
        if (sessionTitle === undefined) return
        sessionTitle.rename(session, title)
      } catch (error) {
        this.log.error('WeCom session title enforcement failed: %s', String(error))
      }
    })
  }

  /** Number of live conversation agents currently held. */
  size(): number {
    return this.agents.size
  }

  /**
   * Identifying peer of one conversation for display: the sender userid for
   * single chats, the group chatid for group chats. Resolved from the
   * in-memory map first, then from the persisted base-id map loaded from
   * `.dsh-wecom-state.json` — so the panel shows the peer right after a
   * restart, before the conversation's next message.
   */
  peerOf(sessionId: string): string | undefined {
    return this.titlePrefixes.get(sessionId) ?? this.peers.get(this.baseId(sessionId))
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
    this.saveState()
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

  /** The epoch-free base conversation id of any (possibly epoch-suffixed) id. */
  private baseId(id: string): string {
    return id.replace(/~g\d+$/, '')
  }

  /** Where the durable per-conversation state lives (one hidden file in the agent cwd). */
  private epochStateFile(): string {
    return join(this.config.cwd, '.dsh-wecom-state.json')
  }

  /**
   * Restore the durable per-conversation state from disk: the reset epoch map
   * (so `/new` survives restarts) and the display peer per base conversation
   * id (so the status panel shows chatid/userid before the next message).
   * Accepts both the current `{ epochs, peers }` shape and the legacy flat
   * epoch map written by earlier versions.
   */
  private loadState(): void {
    try {
      const file = this.epochStateFile()
      if (!existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const record = parsed as Record<string, unknown>
      const legacy = record.epochs === undefined
      const epochEntries = legacy ? Object.entries(record) : Object.entries(record.epochs ?? {})
      for (const [base, epoch] of epochEntries) {
        if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0) {
          this.epochs.set(base, epoch)
        }
      }
      if (!legacy) {
        for (const [base, peer] of Object.entries(record.peers ?? {})) {
          if (typeof peer === 'string' && peer.length > 0) this.peers.set(base, peer)
        }
      }
    } catch (error) {
      this.log.warn('dsh-wecom state load failed: %s', String(error))
    }
  }

  /** Persist epochs and peers so conversation state survives a restart. */
  private saveState(): void {
    try {
      const state = {
        epochs: Object.fromEntries(this.epochs),
        peers: Object.fromEntries(this.peers),
      }
      writeFileSync(this.epochStateFile(), JSON.stringify(state), 'utf8')
    } catch (error) {
      this.log.warn('dsh-wecom state save failed: %s', String(error))
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
      this.saveState()
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
    // Record the peer BEFORE ensuring the agent: the per-chat directory name
    // (minted inside ensureAgent) wants the readable peer id, and this is the
    // only place the raw message is in hand.
    this.rememberTitlePrefix(id, message)
    for (;;) {
      const agent = (await this.ensureAgent(id)).agent
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
      const content = await toContentBlocks(
        message,
        this.mediaPort(download, String(agent.session.id)),
        includeImages,
      )
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
      this.inheritModelSelection(handle.agent)
      await this.groupSession(id, this.headerCwds.get(id))
      return handle
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.conversationDir(id), agentPreset: resolvedPreset },
      agentOptions,
      setup,
    })
    this.inheritModelSelection(handle.agent)
    this.persisted.add(id)
    this.headerCwds.set(id, this.conversationDir(id))
    await this.groupSession(id, this.conversationDir(id))
    return handle
  }

  /**
   * Install the pool's model policy on one pool-owned agent: an explicit
   * `provider`/`model` config wins; otherwise a resumed conversation keeps
   * the model logged in its session header (so a web-UI model switch
   * survives restarts); otherwise the harness default carried by
   * {@link modelOptions} applies. Mirrors the harness's own per-agent
   * selection, so a later web-UI switch still overrides it.
   */
  private inheritModelSelection(agent: Agent): void {
    installModelSelection(agent.ctx, this.selectionFor(agent))
  }

  /** Mutable model-selection policy for one pool-owned agent. */
  selectionFor(agent: Agent): ModelSelectionRef {
    const configured = this.configuredModel
    return {
      get current(): ModelSelection | undefined {
        if (configured !== undefined) return configured
        const header = agent.session.requestHeader()
        const config = header?.config
        if (config?.provider !== undefined && config?.model !== undefined) {
          return {
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: config.reasoningEffort }),
          }
        }
        return undefined
      },
      assembled: undefined,
    }
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

  private mediaPort(download: MediaPort['download'], sessionId: string): MediaPort {
    const attachments = this.ctx.attachments
    // Uploads land inside the conversation's own sandbox directory, so files
    // shared by one chat are unreachable from another (see conversationDir).
    const cwd = this.conversationDir(sessionId)
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
    if (this.configuredModel !== undefined) {
      return { provider: this.configuredModel.provider, model: this.configuredModel.model }
    }
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
