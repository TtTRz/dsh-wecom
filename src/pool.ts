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
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { BaseMessage, Logger } from '@wecom/aibot-node-sdk'
import type { ResolvedConfig } from './config.js'
import { clipUtf8, conversationId, Semaphore } from './helpers.js'
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
  /**
   * Durable image attachments produced during the turn (e.g. cards rendered by
   * the `render_card` tool), oldest first. Channels attach them to the reply.
   */
  images?: ImageAttachmentRef[]
}

/** Structural face of a workspace entity (absent outside web profiles). */
interface WorkspaceLike {
  attachSession(sessionId: string): Promise<void>
}
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
  /** Structural face of the workspace entity list, used by the deletion watcher. */
  list?(): { path?: string }[]
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

/** One pending in-chat approval, resolved through the chat or by timeout. */
interface PendingApproval {
  /** The approval id from the `approval/asked` audit event. */
  approvalId: string
  /** Full WeCom session id the requesting agent serves. */
  sessionId: string
  /** Tool name + asker reason, shown in the pushed request. */
  toolName: string
  reason: string
  resolve: (outcome: 'allowed-once' | 'rejected') => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Bridge between the harness approval waterfall and WeCom chats. When a
 * WeCom-pool agent escalates its sandbox (a tool retry with wider
 * permissions), the harness asks the composed answerers; this bridge claims
 * the request, pushes it into the chat that triggered it, and resolves from
 * the chat's reply. Registered with `prepend` so it runs BEFORE the web-UI
 * answerer — an unanswered push falls through to `next()` only when the
 * bridge is disabled or cannot reach the chat, never after it claimed the
 * ask; a web approval clicked meanwhile is simply ignored (fail-safe: no
 * double answerer, first claim wins).
 */
export class ApprovalBridge {
  /** In-chat approval wait; static so tests can shrink it. */
  static TIMEOUT_MS = 300_000

  /** Pending approvals by approval id. */
  private readonly pending = new Map<string, PendingApproval>()
  private off: (() => void) | undefined

  constructor(
    private readonly log: Logger,
    private readonly config: ResolvedConfig,
  ) {}

  /**
   * Register the waterfall listener on the plugin context. Host-level and
   * agent-scoped by the waterfall itself, so it only ever sees requests from
   * THIS pool's agents when it is registered on their shared context; the
   * sessionId guard keeps foreign sessions (a web-resumed WeCom conversation
   * triggered elsewhere) from being answered from an unrelated chat.
   */
  start(
    ctx: Context,
    ownsSession: (sessionId: string) => boolean,
    push: (sessionId: string, text: string) => Promise<void>,
  ): void {
    this.ownsSession = ownsSession
    this.push = push
    this.off = ctx.on('approval/request', (req, next) => this.onRequest(req, next), {
      prepend: true,
    })
  }

  private ownsSession: (sessionId: string) => boolean = () => false
  private push: (sessionId: string, text: string) => Promise<void> = () => Promise.resolve()

  /** Drop the listener; pending approvals resolve as rejected. */
  dispose(): void {
    this.off?.()
    this.off = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve('rejected')
    }
    this.pending.clear()
  }

  /**
   * Parse one WeCom text message as an approval reply. Returns the outcome
   * when the text is a reply word AND at least one approval is pending for
   * that sender's chat; `undefined` means "not an approval reply" (the
   * message flows into the normal agent turn).
   */
  reply(
    message: BaseMessage,
    conversationIdOf: (message: BaseMessage) => string,
  ): 'allowed-once' | 'rejected' | undefined {
    if (this.pending.size === 0) return undefined
    if (message.msgtype !== 'text') return undefined
    const text = normalizeReply(message.text?.content ?? '')
    if (text === '') return undefined
    const outcome = APPROVAL_REPLIES[text]
    if (outcome === undefined) return undefined
    if (!this.authorizedSender(message)) return undefined
    const sessionId = conversationIdOf(message)
    // Answer the newest pending approval of the SAME chat (base id): the
    // reply is meant for the chat's own escalation, and multiple chats never
    // share a conversation id.
    for (const pending of [...this.pending.values()].reverse()) {
      if (this.sameChat(pending.sessionId, sessionId)) {
        // `resolve` IS `settle`: it removes the pending entry (idempotent
        // double-settle guard), stops the timer, and resolves the ask.
        pending.resolve(outcome)
        return outcome
      }
    }
    return undefined
  }

  /** An unauthorized sender's reply words are ignored (not treated as approval answers). */
  private authorizedSender(message: BaseMessage): boolean {
    if (this.config.approvalAllowlist.length === 0) return true
    return this.config.approvalAllowlist.includes(message.from.userid)
  }

  /** Two WeCom session ids belong to one chat when their base ids match. */
  private sameChat(a: string, b: string): boolean {
    return stripEpoch(a) === stripEpoch(b)
  }

  private async onRequest(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcomeLike>,
  ): Promise<ApprovalOutcomeLike> {
    const sessionId = String(req.agent.session.id)
    if (this.config.approvalMode === 'off' || this.config.approvalMode === 'notify') {
      if (this.config.approvalMode === 'notify' && this.ownsSession(sessionId)) {
        // Notification-only: surface the ask, decide nothing.
        void this.push(sessionId, this.renderAsk(req.toolName, req.reason ?? '')).catch(
          () => undefined,
        )
      }
      return next()
    }
    if (!this.ownsSession(sessionId)) return next()
    if (req.signal?.aborted === true) return 'cancelled'
    const approvalId = this.approvalIdOf(req)
    if (approvalId === undefined) return next()

    return new Promise<ApprovalOutcomeLike>((resolve) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(
        () => settle('cancelled'),
        ApprovalBridge.TIMEOUT_MS,
      )
      const settle = (outcome: 'allowed-once' | 'rejected' | 'cancelled'): void => {
        if (this.pending.delete(approvalId)) {
          clearTimeout(timer)
          resolve(outcome)
        }
      }
      timer.unref?.()
      this.pending.set(approvalId, {
        approvalId,
        sessionId,
        toolName: req.toolName,
        reason: req.reason ?? '',
        resolve: settle,
        timer,
      })
      const ask = this.renderAsk(req.toolName, req.reason ?? '')
      const push = this.push
      void push(sessionId, ask).catch((error) => {
        this.log.warn('WeCom approval push failed (waiting in chat anyway): %s', String(error))
      })
      const signal = req.signal
      const onAbort = (): void => settle('cancelled')
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /** The audit `approval/asked` id for this ask, from the session log tail. */
  private approvalIdOf(req: ApprovalRequestLike): string | undefined {
    const events = req.agent.session.events as readonly {
      type?: string
      data?: { id?: unknown; callId?: unknown }
    }[]
    const decided = new Set<unknown>()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined) continue
      if (event.type === 'approval/decided') decided.add(event.data?.id)
      else if (event.type === 'approval/asked') {
        const id = event.data?.id
        if (id !== undefined && !decided.has(id)) return String(id)
      }
    }
    return undefined
  }

  private renderAsk(toolName: string, reason: string): string {
    const clipped = reason.trim() ? `\n${clipUtf8(reason, 500, '…')}` : ''
    return `⚠️ 需要审批（工具 ${toolName}）${clipped}\n${this.config.approvalHint}`
  }
}

/** Reply words → outcome; normalized (trimmed, lowercased, full/half width). */
const APPROVAL_REPLIES: Readonly<Record<string, 'allowed-once' | 'rejected'>> = {
  批准: 'allowed-once',
  同意: 'allowed-once',
  允许: 'allowed-once',
  ok: 'allowed-once',
  yes: 'allowed-once',
  y: 'allowed-once',
  拒绝: 'rejected',
  不批准: 'rejected',
  不同意: 'rejected',
  no: 'rejected',
  n: 'rejected',
}

/** Normalize one reply word: trim, lowercase, fold full-width latin. */
function normalizeReply(text: string): string {
  return text
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** Strip the epoch suffix (`~gN`) from a WeCom session id. */
function stripEpoch(id: string): string {
  return id.replace(/~g\d+$/, '')
}

/** Structural face of the harness approval request (agent, tool, signal). */
interface ApprovalRequestLike {
  agent: { session: { id: unknown; events: unknown } }
  toolName: string
  reason?: string
  signal?: {
    aborted?: boolean
    addEventListener?: (type: string, fn: () => void, options?: { once?: boolean }) => void
  }
}

type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * One Harness agent per WeCom conversation: opened on first use, resumed from
 * persistence after restarts, and closed with the plugin. Each agent mounts a
 * preset in its scoped setup so it inherits the preset's tools and persona.
 */
export class AgentPool {
  /** Deletion-watcher poll interval; static so tests can shrink it. */
  static DELETION_POLL_MS = 5_000

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
  /**
   * Per-chat directories whose workspace row the user deleted in the web UI.
   * Tombstones are recorded by a runtime watcher and persisted in the state
   * file; `start()` regrouping skips them so deleted rows stay deleted across
   * restarts. A new message on the conversation clears its tombstone, so a
   * chat that becomes active again gets its row back.
   */
  private readonly deletedDirs = new Set<string>()
  /** Disposer for the deletion watcher interval, owned by this pool. */
  private watcherDisposer: (() => void) | undefined
  /** In-chat approval bridge; answers WeCom-agent escalations from the chat. */
  private readonly approvals: ApprovalBridge
  /**
   * Push callback handed to the approval bridge by the channel: delivers one
   * proactive text into the chat that triggered the escalation. Assigned in
   * `wireApprovals` before any turn can run.
   */
  private approvalPush: ((sessionId: string, text: string) => Promise<void>) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    this.log = ctx.logger('dsh-wecom')
    this.approvals = new ApprovalBridge(this.log, config)
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
    this.startDeletionWatcher()
    this.approvals.start(
      this.ctx,
      (sessionId) => this.ownsWeComSession(sessionId),
      (sessionId, text) => this.approvalPush?.(sessionId, text) ?? Promise.resolve(),
    )
  }

  /**
   * Hand the channel its two approval seams: the proactive push (delivering
   * the ask into the chat) and the reply interceptor (answering pending
   * approvals from chat messages). Called by the channel before `start()`
   * completes so no message can race the wiring.
   */
  wireApprovals(
    push: (sessionId: string, text: string) => Promise<void>,
  ): (message: BaseMessage) => 'allowed-once' | 'rejected' | undefined {
    this.approvalPush = push
    return (message) => this.approvals.reply(message, (m) => this.locate(m).id)
  }

  /**
   * Whether one session id belongs to this pool: any epoch of a WeCom
   * conversation this pool tracks (live agents and persisted ids both
   * count — an escalation can fire on a just-resumed session).
   */
  private ownsWeComSession(sessionId: string): boolean {
    if (sessionId.startsWith('dsh-wecom-') === false) return false
    if (this.agents.has(sessionId)) return true
    for (const id of this.persisted) {
      if (id === sessionId || stripEpoch(id) === stripEpoch(sessionId)) return true
    }
    return false
  }

  /**
   * Watch the workspace registry while running: when a workspace row whose
   * path lives under this pool's base cwd disappears (the user deleted it in
   * the web UI — the registry emits no event, so this is polled), record the
   * directory as a tombstone so `start()` regrouping skips it after a
   * restart. Directories outside `config.cwd` (the admin workspaces, the
   * ungrouped bucket) are ignored. The first snapshot primes the baseline
   * without recording anything, so rows deleted before this boot (and
   * already recreated by `start()` regrouping) are never spuriously
   * tombstoned.
   */
  private startDeletionWatcher(): void {
    if (this.watcherDisposer !== undefined) return
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined || registry.list === undefined) return
    const listNow = registry.list.bind(registry)
    const baseline = new Set<string>()
    for (const workspace of listNow()) {
      const path = workspace.path
      if (path?.startsWith(this.config.cwd)) baseline.add(path)
    }
    const timer = setInterval(() => {
      const current = new Set<string>()
      for (const workspace of listNow()) {
        const path = workspace.path
        if (path?.startsWith(this.config.cwd)) current.add(path)
      }
      let changed = false
      for (const path of baseline) {
        if (!current.has(path) && !this.deletedDirs.has(path)) {
          this.deletedDirs.add(path)
          changed = true
          this.log.info(
            'workspace row deleted in web UI; tombstoning %s (row stays deleted across restarts)',
            path,
          )
        }
      }
      if (changed) this.saveState()
      baseline.clear()
      for (const path of current) baseline.add(path)
    }, AgentPool.DELETION_POLL_MS)
    timer.unref?.()
    this.watcherDisposer = () => {
      clearInterval(timer)
      this.watcherDisposer = undefined
    }
  }

  /**
   * Resolve one conversation's grouping workspace. Failures (including a
   * not-yet-mounted registry) are forgotten so the next call retries instead of
   * caching the miss forever. A skipped (tombstoned) resolution is likewise
   * never cached, so the revive path can succeed on a later message.
   */
  private ensureWorkspace(
    id: string,
    options: { revive?: boolean } = {},
  ): Promise<WorkspaceLike | undefined> {
    // Keyed by the per-chat directory, not the conversation id: every epoch
    // of one chat resolves to the same workspace row and one create() call.
    const dir = this.conversationDir(id)
    this.workspacePromise ??= new Map()
    const cached = this.workspacePromise.get(dir)
    if (cached !== undefined) return cached
    const current = this.openWorkspace(id, options).then(
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

  private async openWorkspace(
    id: string,
    options: { revive?: boolean } = {},
  ): Promise<WorkspaceLike | undefined> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined) return undefined
    // Workspace membership is validated by canonical cwd (the session cwd must
    // equal the workspace path), and every conversation now runs in its own
    // subdirectory (see conversationDir), so the grouping workspace is
    // per-conversation too — one sidebar row per WeCom chat.
    const cwd = this.conversationDir(id)
    // A tombstoned directory's row was deleted in the web UI. Restart
    // regrouping (revive: false) honors the deletion — the session stays
    // ungrouped. A fresh user message (revive: true) clears the tombstone and
    // recreates the row, so a chat that becomes active again is visible once
    // more.
    if (this.deletedDirs.has(cwd)) {
      if (options.revive !== true) return undefined
      this.reviveTombstone(id)
    }
    await mkdir(cwd, { recursive: true })
    return registry.create(cwd, `${this.config.workspaceTitle} · ${this.shortId(id)}`)
  }

  /**
   * Fresh activity on a tombstoned conversation: drop every tombstone that
   * matches this conversation's directory (dir identity is the tombstone
   * key, so future epochs of the same chat regroup normally) and persist the
   * change. Called only from the revive path of openWorkspace, i.e. exactly
   * when a new user message wants its workspace row back.
   */
  private reviveTombstone(id: string): void {
    const cwd = this.conversationDir(id)
    if (!this.deletedDirs.has(cwd)) return
    this.deletedDirs.delete(cwd)
    this.saveState()
    this.log.info('fresh activity on tombstoned chat %s; its workspace row will be recreated', cwd)
  }

  /**
   * Human-readable suffix for per-session workspace titles, derived from the
   * minted directory name (the persistent fact): 'WeCom-{peer}-0821-143025-x'
   * yields '{peer} 08-21 14:30:25'. Concurrent sessions of one peer are
   * distinguished by their timestamps alone.
   */
  private shortId(id: string): string {
    const dir = this.conversationDir(id).split('/').pop() ?? ''
    const stripped = dir.replace(/^WeCom-/, '').replace(/-[^-]*$/, '')
    const m = /^(.+)-(\d{4})-(\d{2})(\d{2})(\d{2})$/.exec(stripped)
    const pretty =
      m !== null &&
      m[1] !== undefined &&
      m[2] !== undefined &&
      m[3] !== undefined &&
      m[4] !== undefined &&
      m[5] !== undefined
        ? `${m[1]} ${m[2].slice(0, 2)}-${m[2].slice(2)} ${m[3]}:${m[4]}:${m[5]}`
        : stripped
    return pretty
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
    // Keyed by the FULL session id: each /reset epoch (its own session id,
    // ~gN suffix) mints a distinct directory, so every session gets its own
    // sandbox cwd and its own workspace row.
    const tail6 = id.slice(-6)
    const escaped = tail6.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^WeCom-.*-${escaped}$`)
    try {
      const hit = readdirSync(this.config.cwd).find((name) => pattern.test(name))
      if (hit !== undefined) return join(this.config.cwd, hit)
    } catch {
      // base not readable yet — fall through to mint a new name
    }
    return join(this.config.cwd, `WeCom-${this.peerTag(id)}-${this.firstSeenStamp()}-${tail6}`)
  }

  /** Readable, filesystem-safe peer tag for the directory name. */
  private peerTag(id: string): string {
    const peer = this.peers.get(this.baseId(id)) ?? this.baseId(id)
    return peer.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24) || 'peer'
  }

  /** First-seen stamp (MMDD-HHmmss) for directory names. */
  private firstSeenStamp(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  /**
   * Attach one conversation session to the grouping workspace, when claimed.
   * Best-effort by design: a session whose stored cwd predates the workspace
   * path (or any registry hiccup) must never fail the message itself — it
   * simply stays Ungrouped.
   */
  private async groupSession(
    id: string,
    headerCwd?: string,
    options: { revive?: boolean } = {},
  ): Promise<void> {
    // Workspace membership validates the session cwd against the workspace
    // path. Creating the row for a session whose header cwd differs (legacy
    // sessions under the shared base, or another chat's dir) would persist an
    // empty row, so skip those entirely — they stay wherever they already sit.
    // Identity anchor: the dir's last dash-segment equals the FULL session
    // id's last 6 chars (epoch marker included — each epoch anchors its row).
    if (headerCwd !== undefined) {
      const tail6 = id.slice(-6)
      const tail = headerCwd.split('/').pop() ?? ''
      if (!tail.endsWith(`-${tail6}`)) return
    }
    try {
      const workspace = await this.ensureWorkspace(id, options)
      await workspace?.attachSession(id)
    } catch (error) {
      this.log.error('WeCom workspace attach failed for %s: %s', id, String(error))
    }
  }

  /**
   * Remember the title prefix of a conversation. The harness generates
   * session titles automatically (an LLM short title); the prefix becomes the
   * per-chat directory name (see conversationDir). Recorded before the
   * message is delivered, and persisted under the conversation's base id so
   * the status panel can show the peer right after a restart.
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
      // Session titles stay topic-only: the caller identity is carried by the
      // per-chat workspace row (directory), not by a per-session prefix.
      this.canonicalTitles.set(id, title)
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
    // Deliberately NOT disposing the old agent: a disposed session leaves the
    // host's live-session projection (host/session-removed), which erases its
    // row content from the sidebar even though the log and workspace row are
    // intact. Keeping the agent live keeps the previous conversation visible
    // and resumable while the fresh epoch starts clean; the handle's own
    // dispose stays wired into the pool's teardown for shutdown.
  }

  /** Tear down every agent once queued turns have settled. */
  async dispose(): Promise<void> {
    this.watcherDisposer?.()
    this.approvals.dispose()
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
   * (so `/new` survives restarts), the display peer per base conversation
   * id (so the status panel shows chatid/userid before the next message), and
   * the deleted-workspace tombstones (so UI deletions survive restarts).
   * Accepts both the current `{ epochs, peers, deletedWorkspaces }` shape and
   * the legacy flat epoch map written by earlier versions.
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
        for (const dir of (record.deletedWorkspaces as unknown[]) ?? []) {
          if (typeof dir === 'string' && dir.length > 0) this.deletedDirs.add(dir)
        }
      }
    } catch (error) {
      this.log.warn('dsh-wecom state load failed: %s', String(error))
    }
  }

  /** Persist epochs, peers, and deletion tombstones so conversation state survives a restart. */
  private saveState(): void {
    try {
      const state = {
        epochs: Object.fromEntries(this.epochs),
        peers: Object.fromEntries(this.peers),
        deletedWorkspaces: [...this.deletedDirs],
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
    const images: ImageAttachmentRef[] = []
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
        // Cards rendered by tools (e.g. render_card) arrive as image blocks in
        // the tool-result content; collect their durable refs for the reply.
        for (const block of event.data.message.content ?? []) {
          if (block.type !== 'tool-result') continue
          for (const inner of block.content) {
            if (inner.type === 'image') {
              images.push(inner.attachment)
            }
          }
        }
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
    if (images.length > 0) reply.images = images
    return reply
  }

  /**
   * Wait for the agent's turn to settle with a NO-PROGRESS timeout: the
   * deadline resets on every session event (thinking deltas, tool calls,
   * assistant text), so a long reasoning pass or a slow tool loop keeps the
   * turn alive as long as it is demonstrably moving. Only a turn that goes
   * silent for turnTimeoutMs is treated as stuck — cancelled so the next
   * message is not queued behind work that will never finish.
   */
  private async settleTurn(agent: Agent): Promise<void> {
    const limitMs = this.config.turnTimeoutMs
    let timedOut = false
    let settle: (() => void) | undefined
    const idle = new Promise<void>((resolve) => {
      settle = resolve
    })
    let timer: NodeJS.Timeout | undefined
    const arm = (): void => {
      if (timedOut) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        if (agent.status !== 'idle') agent.cancel({ kind: 'user' })
        settle?.()
      }, limitMs)
    }
    const off = agent.ctx.on('session/event', () => {
      arm()
    })
    arm()
    const watchIdle = agent.whenIdle().then(() => {
      if (!timedOut) settle?.()
    })
    try {
      await idle
    } finally {
      off()
      if (timer !== undefined) clearTimeout(timer)
      void watchIdle.catch(() => undefined)
    }
    // A silent no-progress timeout still surfaces as an error so the user
    // knows to retry — only the timer semantics changed (progress resets it).
    if (timedOut) throw new Error('agent response timed out')
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
      await this.groupSession(id, this.headerCwds.get(id), { revive: true })
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
    await this.groupSession(id, this.conversationDir(id), { revive: true })
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
