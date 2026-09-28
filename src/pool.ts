import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import type {
  ResolvedConfig,
  WecomIdentity,
  WecomIdentityEnricher,
  WecomIdentityService,
} from './config.js'
import { wecomIdentityEnricherServiceName } from './config.js'
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

/**
 * One historical session of a WeCom conversation, projected for the `/session`
 * and `/current` commands. Every `/new` mints the next epoch (`base~gN`) while
 * the older sessions stay persisted, so a chat accumulates one row per epoch.
 */
export interface SessionView {
  /** Epoch number: 0 is the original session, N the `~gN` reset epoch. */
  epoch: number
  /** Full session id (base or `base~gN`). */
  sessionId: string
  /** Creation time (epoch ms) from the persisted header, null when unknown. */
  createdAt: number | null
  /** Latest session title, when the log could be read. */
  title?: string
  /** Completed turns in the log, null when the log could not be read. */
  turns: number | null
  /** Whether new messages of this chat currently route to this session. */
  current: boolean
}

/** Structural face of a workspace entity (absent outside web profiles). */
interface WorkspaceLike {
  attachSession(sessionId: string): Promise<void>
  /** Canonical directory of the row (present on the harness's entity). */
  path?: string
  /** Durable sidebar title; may be absent on a minimal structural registry. */
  title?: string
  /** Refresh the durable title (present on the harness's workspace entity). */
  setTitle?(title: string): Promise<unknown>
}
interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
  /** The workspace entity list (the deletion watcher and title reconcile read it). */
  list?(): WorkspaceLike[]
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
    const events = liveEvents(req.agent.session) as readonly {
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

/**
 * The epoch number of one session id within one conversation base, when it
 * belongs to it: the bare base id is epoch 0, `base~gN` is epoch N, anything
 * else (another chat, another scope) is `undefined`.
 */
function epochOfId(base: string, id: string): number | undefined {
  if (id === base) return 0
  if (!id.startsWith(`${base}~g`)) return undefined
  const suffix = id.slice(base.length + 2)
  if (!/^\d+$/.test(suffix)) return undefined
  return Number(suffix)
}

/**
 * Derive the human-readable sidebar suffix from one per-chat directory name:
 * `WeCom-{peer}-{MMDD}-{HHmmss}-{tail6}[~gN]` → `{peer} MM-DD HH:mm:ss`. Used
 * for both the canonical title of a live conversation and the reconcile pass
 * that repairs a row whose stored title predates a peer-label change.
 */
function shortIdOfDir(dir: string): string {
  const stripped = dir.replace(/^WeCom-/, '').replace(/-[^-]*$/, '')
  const m = /^(.+)-(\d{4})-(\d{2})(\d{2})(\d{2})$/.exec(stripped)
  if (
    m === null ||
    m[1] === undefined ||
    m[2] === undefined ||
    m[3] === undefined ||
    m[4] === undefined ||
    m[5] === undefined
  ) {
    return stripped
  }
  return `${m[1]} ${m[2].slice(0, 2)}-${m[2].slice(2)} ${m[3]}:${m[4]}:${m[5]}`
}

/**
 * Upper bound on the pre-mint RTX lookup for a brand-new conversation. The
 * identity enricher's own request timeout is much longer (10s default); a chat
 * must not wait that long for its first reply, so the lookup is raced against
 * this cap and the message proceeds with the raw userid on a slow resolver
 * (the in-flight resolution still warms the cache for the next message).
 */
const PEER_RESOLVE_TIMEOUT_MS = 2_500

/** Await `promise` for at most `ms`; a late result/rejection is ignored. */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read a LIVE session's events across harness versions.
 *
 * The harness renamed the accessor: `@deepseek-ai/dsh-session` 0.1.0-rc.6
 * exposed a `session.events` getter; 0.1.5-rc.2 replaced it with
 * `session.snapshotEvents()`. This package's pinned types are the OLDER ones,
 * so `session.events` still type-checks while the RUNTIME (the deployment's
 * newer package) answers `undefined` — the source of the
 * "Cannot read properties of undefined (reading 'length')" crash on the first
 * turn of every conversation after the 2026-09-11 harness upgrade. Prefer the
 * new accessor and fall back to the old getter, so either runtime works.
 */
export function liveEvents(session: unknown): readonly SessionEvent[] {
  const target = session as
    | {
        snapshotEvents?: () => readonly SessionEvent[]
        events?: readonly SessionEvent[]
      }
    | null
    | undefined
  if (target === null || target === undefined) return []
  if (typeof target.snapshotEvents === 'function') return target.snapshotEvents()
  return target.events ?? []
}

/**
 * Subscribe to one agent-scoped harness event whose NAME this package's pinned
 * types do not know yet — the same version-lag situation {@link liveEvents}
 * handles, applied to the event map instead of the session accessor.
 *
 * `agent/assistant-stream` (the live model-delta feed) arrived in
 * `@deepseek-ai/dsh-agent` 0.1.5-rc.2, while this package pins 0.1.0-rc.6, so
 * `ctx.on('agent/assistant-stream', …)` is rejected as an unknown `keyof
 * Events` even though the running harness emits it. The subscription therefore
 * goes through a structural shape rather than the typed map. Returns a
 * disposer; a context without `on` yields a no-op one.
 */
function onAgentEvent(
  ctx: unknown,
  event: string,
  handler: (payload: unknown) => void,
): () => void {
  const target = ctx as
    | { on?: (name: string, fn: (payload: unknown) => void) => () => void }
    | null
    | undefined
  if (typeof target?.on !== 'function') return () => undefined
  return target.on(event, handler)
}

/**
 * Whether an error is the "session identity already taken" collision raised by
 * the session store (a plain message) or the persistence backend (a named
 * `SessionAlreadyExistsError`). Used to fall back from `create` to `resume`
 * instead of failing the turn.
 */
function isAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  if (name === 'SessionAlreadyExistsError') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /already exists/i.test(message)
}

/**
 * Whether an error is the CROSS-DRIVER contention window, not a real failure.
 *
 * `dsh-agent-loop`'s `resume` opens the persisted session for WRITE first and
 * only registers the agent afterwards (`open(id,'write')` → cold read →
 * prepare → `setupAndPublish`). Every driver's "adopt the live agent" guard is
 * `ctx.agents.get(sessionId)`, so while one driver sits inside that window the
 * guard misses for ALL of them and the next `open(id,'write')` throws
 * `SessionAlreadyOwnedError` (the persistence backend's in-process writer map).
 * A same-session `prepare` can also report "cannot prepare … while it is live".
 * Both mean "someone else is opening it right now" — retry, do not fail.
 */
function isSessionContentionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { name?: unknown }).name === 'SessionAlreadyOwnedError') return true
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return (
    /already owned by an active write handle/i.test(message) || /while it is live/i.test(message)
  )
}

/** Backoff before re-attempting a session open that lost the cross-driver race. */
const SESSION_CONTENTION_RETRY_MS = [150, 300, 600, 1_200]

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Fold one session log to its display facts: the latest non-empty title and
 * the completed-turn count. Events are read structurally (the title event is
 * contributed by the session-title plugin, not the core event map).
 */
function summarizeSessionLog(events: readonly unknown[]): { title?: string; turns: number } {
  let title: string | undefined
  let turns = 0
  for (const raw of events) {
    const type = (raw as { type?: unknown }).type
    if (type === 'turn/end') {
      turns += 1
    } else if (type === 'session/title') {
      const value = (raw as { data?: { title?: unknown } }).data?.title
      if (typeof value === 'string' && value.trim() !== '') title = value
    }
  }
  return title === undefined ? { turns } : { title, turns }
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
   * Directory minted for a conversation id, keyed by the FULL session id.
   * `conversationDir` mints from the wall clock, and nothing creates the
   * directory until `openWorkspace` runs later in the same turn — so without
   * this cache a second call after the clock ticks would name a DIFFERENT
   * directory than the session's header cwd (the session then matches no
   * workspace and lands in Ungrouped, with an empty workspace row).
   */
  private readonly dirCache = new Map<string, string>()
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
  /**
   * Sender identity of the WeCom turn currently running on each conversation
   * session id, present only for the duration of {@link driveTurn}. Read by
   * the agent-scoped `wecomIdentity` service and the identity prompt
   * section — both see the CURRENT turn's facts. A
   * web-UI follow-up or a resumed session driven outside this pool has no
   * entry, so identity-dependent behavior fails closed there.
   */
  private readonly turnIdentities = new Map<string, WecomIdentity>()
  /** Agent contexts already carrying the identity seams (guard + section + service). */
  private readonly identitySeams = new WeakSet<object>()

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
    // Repair stale sidebar titles for EVERY row — including historical `/new`
    // epochs that will never receive another message, which `openWorkspace`
    // (reached only for the session currently being messaged) cannot touch.
    // The workspace registry may mount AFTER this plugin, so the bounded retry
    // below is not a reliable trigger; `ctx.inject` runs the pass whenever the
    // service appears.
    // A minimal structural context (test doubles) may omit `inject`; the real
    // cordis Context always has it.
    if (typeof this.ctx.inject === 'function') {
      this.ctx.inject(['workspaceRegistry'], () => {
        void this.reconcileWorkspaceTitles().catch((error) => {
          this.log.debug('WeCom workspace title reconcile failed: %s', String(error))
        })
      })
    }
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
    const canonicalTitle = `${this.config.workspaceTitle} · ${this.shortId(id)}`
    const workspace = await registry.create(cwd, canonicalTitle)
    // `registry.create` returns an EXISTING row at that path UNTOUCHED, so a
    // title minted before the peer label changed — a directory migrated from
    // the raw userid to the RTX, or a row created while the RTX cache was cold
    // — would stay stale in the sidebar forever. Refresh it to the canonical
    // label derived from the directory name. Best-effort: a registry without
    // `setTitle` (or a failed write) must never fail the message.
    if (
      typeof workspace.setTitle === 'function' &&
      workspace.title !== undefined &&
      workspace.title !== canonicalTitle
    ) {
      try {
        await workspace.setTitle(canonicalTitle)
      } catch (error) {
        this.log.debug('WeCom workspace title refresh failed: %s', String(error))
      }
    }
    return workspace
  }

  /**
   * Repair every stale per-chat workspace row title.
   *
   * `openWorkspace` only touches the row of the session currently being
   * messaged, so a HISTORICAL epoch row (an older `/new` generation that will
   * never receive another message) keeps whatever title it was minted with —
   * e.g. the raw userid, before the directory was migrated to the peer's RTX.
   * This pass walks the whole registry and rewrites any row under this pool's
   * cwd whose title differs from the canonical label its directory implies.
   *
   * Best-effort and idempotent: a registry without `list`/`setTitle`, an
   * unrelated row, or a failed write is skipped.
   */
  async reconcileWorkspaceTitles(): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry?.list === undefined) return
    // Scope by THIS row's workspace title prefix: several dsh-wecom instances
    // share one base cwd (mp-perf + mp-publish both run under
    // ~/.wecom-sessions), so the path alone cannot tell whose row it is. The
    // prefix is already canonical; only the peer suffix needs repairing.
    const prefix = `${this.config.workspaceTitle} · `
    for (const workspace of registry.list()) {
      const path = workspace.path
      if (typeof path !== 'string' || !path.startsWith(this.config.cwd)) continue
      const dir = path.split('/').pop() ?? ''
      if (!dir.startsWith('WeCom-')) continue
      if (workspace.title === undefined || !workspace.title.startsWith(prefix)) continue
      const canonicalTitle = `${prefix}${shortIdOfDir(dir)}`
      if (workspace.title === canonicalTitle) continue
      if (typeof workspace.setTitle !== 'function') continue
      try {
        await workspace.setTitle(canonicalTitle)
      } catch (error) {
        this.log.debug('WeCom workspace title reconcile failed for %s: %s', dir, String(error))
      }
    }
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
    return shortIdOfDir(this.conversationDir(id).split('/').pop() ?? '')
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
    const cached = this.dirCache.get(id)
    if (cached !== undefined) return cached
    const tail6 = id.slice(-6)
    const escaped = tail6.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^WeCom-.*-${escaped}$`)
    try {
      const hit = readdirSync(this.config.cwd).find((name) => pattern.test(name))
      if (hit !== undefined) {
        const adopted = join(this.config.cwd, hit)
        this.dirCache.set(id, adopted)
        return adopted
      }
    } catch {
      // base not readable yet — fall through to mint a new name
    }
    // Mint ONCE and materialize the directory immediately. The workspace row is
    // built from a LATER `conversationDir(id)` call (openWorkspace), and
    // `firstSeenStamp()` reads the clock every time it runs: if that later call
    // crossed a second boundary it would name a different directory than the
    // one written into the session header, leaving the session Ungrouped next
    // to an empty row. Creating the directory here also makes the name
    // discoverable by the scan above on every later call and after a restart.
    const minted = join(
      this.config.cwd,
      `WeCom-${this.peerTag(id)}-${this.firstSeenStamp()}-${tail6}`,
    )
    this.dirCache.set(id, minted)
    try {
      mkdirSync(minted, { recursive: true })
    } catch {
      // A failed pre-create must not fail the message: the cache above still
      // pins this session to one name for the rest of the process.
    }
    return minted
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
    // Single chats prefer the sender's resolved RTX for the peer label (and
    // therefore the per-chat directory name + workspace row). peekRtxFor is a
    // synchronous cache-only lookup: it returns the RTX for an already-seen
    // sender and falls back to the raw userid on a cache miss (warming the
    // cache in the background so the next message shows the RTX). Group chats
    // keep the chatid — there is no per-group RTX. New conversations only:
    // the early-return above leaves existing prefixes (and their directories)
    // untouched, so live sessions never move.
    const singlePeer = this.peekRtxFor(message.from.userid) ?? message.from.userid
    const prefix = message.chattype === 'group' ? (message.chatid ?? singlePeer) : singlePeer
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
        canonical = this.previousTitle(liveEvents(session), event.seq) ?? title
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
    // Preempt (插队): a new message interrupts any RUNNING turn of this
    // conversation. `agent.cancel` makes the in-flight turn settle promptly
    // (its `settleTurn` waits on `whenIdle`), so the new message is driven
    // right after instead of queueing behind a long analysis. Different
    // conversations stay independent (bounded by maxConcurrent).
    const agent = this.agents.get(target)?.agent ?? this.ctx.agents.get(SessionId(target))
    if (agent !== undefined && agent.status !== 'idle') agent.cancel({ kind: 'user' })
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

  /**
   * Drop the current conversation; the next message starts a fresh session.
   * Returns the minted epoch number so the caller can name it in its reply.
   * The fresh epoch is one past the HIGHEST epoch ever minted for this chat —
   * after `/resume` rewinds the routing pointer to an older epoch, a naive
   * "current + 1" would collide with (and silently continue) an existing
   * session instead of starting a new one.
   */
  async forget(message: BaseMessage): Promise<number> {
    const base = conversationId(this.config.namespace, message)
    const currentEpoch = this.epochs.get(base) ?? 0
    const nextEpoch = (await this.maxEpochOf(base)) + 1
    this.epochs.set(base, nextEpoch)
    this.saveState()
    const oldId = this.withEpoch(base, currentEpoch)
    const handle = this.agents.get(oldId)
    if (handle !== undefined) this.agents.delete(oldId)
    // Deliberately NOT disposing the old agent: a disposed session leaves the
    // host's live-session projection (host/session-removed), which erases its
    // row content from the sidebar even though the log and workspace row are
    // intact. Keeping the agent live keeps the previous conversation visible
    // and resumable while the fresh epoch starts clean; the handle's own
    // dispose stays wired into the pool's teardown for shutdown.
    return nextEpoch
  }

  /**
   * Every historical session of this chat's conversation (its base id plus
   * all `~gN` epochs), newest first. Reads fresh persistence headers at
   * command time, so sessions minted by earlier process runs are included.
   */
  async listSessions(message: BaseMessage): Promise<SessionView[]> {
    const base = conversationId(this.config.namespace, message)
    const currentEpoch = this.epochs.get(base) ?? 0
    const rows: Array<{ id: string; epoch: number; createdAt: number | null }> = []
    for (const header of await this.ctx.sessionPersistence.list()) {
      const id = String(header.id)
      const epoch = epochOfId(base, id)
      if (epoch === undefined) continue
      const createdAt = typeof header.createdAt === 'number' ? header.createdAt : null
      rows.push({ id, epoch, createdAt })
    }
    rows.sort((a, b) => b.epoch - a.epoch)
    const views: SessionView[] = []
    for (const row of rows) {
      views.push(
        await this.describeSession(row.id, row.epoch, row.createdAt, row.epoch === currentEpoch),
      )
    }
    return views
  }

  /** The session new messages of this chat currently route to, when it exists. */
  async currentSession(message: BaseMessage): Promise<SessionView | undefined> {
    const base = conversationId(this.config.namespace, message)
    const epoch = this.epochs.get(base) ?? 0
    const id = this.withEpoch(base, epoch)
    const headers = await this.ctx.sessionPersistence.list()
    const header = headers.find((h) => String(h.id) === id)
    if (header === undefined) return undefined
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : null
    return this.describeSession(id, epoch, createdAt, true)
  }

  /**
   * Switch this chat's routing pointer to one historical epoch (`/resume`).
   * The argument is the epoch number shown by `/session` (0 = the original
   * session). Only sessions that actually exist and are visible (not archived
   * in the web UI) may be resumed; the selection is persisted to the state
   * file, so it survives restarts like `/new` does. A running turn on the
   * previous session is left alone — the switch applies from the next
   * message on.
   */
  async resumeSession(message: BaseMessage, arg: string): Promise<string> {
    const base = conversationId(this.config.namespace, message)
    const trimmed = arg.trim()
    if (!/^\d+$/.test(trimmed)) {
      return '/resume <编号> — 切换到历史 session；编号见 /session 列表。'
    }
    const epoch = Number(trimmed)
    if (epoch === (this.epochs.get(base) ?? 0)) {
      return `当前就是 session #${epoch}。`
    }
    const id = this.withEpoch(base, epoch)
    const exists = (await this.ctx.sessionPersistence.list()).some(
      (header) => String(header.id) === id,
    )
    if (!exists) {
      return `没有编号为 ${epoch} 的 session；发送 /session 查看可恢复的历史列表。`
    }
    if (this.isArchived(id)) {
      return `session #${epoch} 已在网页端归档，无法恢复；可发送 /new 开新会话。`
    }
    this.epochs.set(base, epoch)
    this.saveState()
    const { title } = await this.describeLog(id)
    const suffix = title === undefined ? '' : `（${title}）`
    return `已切换到 session #${epoch}${suffix}；后续消息将继续该会话，/new 可再开新会话。`
  }

  /** Tear down every agent once queued turns have settled. */
  async dispose(): Promise<void> {
    this.watcherDisposer?.()
    this.approvals.dispose()
    await Promise.allSettled(this.chains.values())
    await Promise.allSettled([...this.agents.values()].map((handle) => handle.dispose()))
    this.agents.clear()
  }

  /**
   * Highest epoch ever minted for one conversation, over the routing pointer,
   * the in-memory snapshot, and the FRESH persistence headers. Used by `/new`
   * so a resumed (rewound) pointer never collides with an existing `~gN`
   * session. The header read is what keeps `/new` from handing out an epoch
   * whose session already exists on disk but is missing from the startup
   * snapshot; every epoch seen there is folded back into the snapshot.
   */
  private async maxEpochOf(base: string): Promise<number> {
    let max = this.epochs.get(base) ?? 0
    const prefix = `${base}~g`
    const consider = (id: string): void => {
      if (!id.startsWith(prefix)) return
      const n = Number(id.slice(prefix.length))
      if (Number.isInteger(n) && n > max) max = n
      this.persisted.add(id)
    }
    for (const id of this.persisted) consider(id)
    try {
      for (const header of await this.ctx.sessionPersistence.list()) {
        consider(String(header.id))
      }
    } catch {
      // Persistence unavailable/transient: fall back to the in-memory view.
    }
    return max
  }

  /** Assemble one `/session` row: header facts plus log-derived title/turns. */
  private async describeSession(
    id: string,
    epoch: number,
    createdAt: number | null,
    current: boolean,
  ): Promise<SessionView> {
    const log = await this.describeLog(id)
    return {
      epoch,
      sessionId: id,
      createdAt,
      ...(log.title === undefined ? {} : { title: log.title }),
      turns: log.turns,
      current,
    }
  }

  /**
   * Title and turn count of one session, read from the live agent's events
   * when it is open, else inspected from persistence. A cold inspection reads
   * the whole log, so it is bounded by a timeout; any failure degrades to
   * "no title / unknown turns" instead of failing the command.
   */
  private async describeLog(id: string): Promise<{ title?: string; turns: number | null }> {
    const live = this.agents.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (live !== undefined)
      return summarizeSessionLog(liveEvents(live.session) as readonly unknown[])
    try {
      const inspection = await this.ctx.sessionPersistence.inspect(
        SessionId(id),
        AbortSignal.timeout(3_000),
      )
      return summarizeSessionLog(inspection.events as readonly unknown[])
    } catch {
      return { turns: null }
    }
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

  /**
   * Where the durable per-conversation state lives (one hidden file in the
   * agent cwd). The `default` namespace keeps its legacy filename; every other
   * namespace (multi-bot rows) gets a suffixed file so two pools sharing a cwd
   * never overwrite each other's epochs/peers/tombstones.
   */
  private epochStateFile(): string {
    const suffix = this.config.namespace === 'default' ? '' : `.${this.config.namespace}`
    return join(this.config.cwd, `.dsh-wecom-state${suffix}.json`)
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
    // Resolve the sender's RTX BEFORE the peer label — and therefore the
    // per-chat directory — is minted, so a cold cache no longer bakes the raw
    // userid into a brand-new conversation's directory name. Bounded, and a
    // no-op for every later turn and every existing conversation.
    await this.primePeerForNewConversation(id, message)
    // only place the raw message is in hand.
    this.rememberTitlePrefix(id, message)
    for (;;) {
      const agent = (await this.ensureAgent(id)).agent
      if (this.ctx.agents.get(SessionId(id)) === agent) return agent
      this.agents.delete(id)
    }
  }

  /**
   * Resolve a brand-new conversation's sender RTX before its peer label is
   * minted, so `conversationDir` names the directory from the RTX instead of
   * the raw userid.
   *
   * Only the FIRST message of a conversation that has no peer label yet pays
   * the lookup, and only for single chats whose cache is cold — every later
   * message early-returns. The wait is capped by
   * {@link PEER_RESOLVE_TIMEOUT_MS}; on a miss or a slow resolver the message
   * proceeds on the userid (the previous behavior) while the in-flight
   * resolution still warms the cache for the next conversation.
   */
  private async primePeerForNewConversation(id: string, message: BaseMessage): Promise<void> {
    if (message.chattype === 'group') return
    if (this.titlePrefixes.has(id)) return
    const base = this.baseId(id)
    if (this.peers.has(base)) return
    const userid = message.from.userid
    if (userid === undefined || userid.length === 0) return
    const enricher = this.identityEnricher()
    if (enricher === undefined) return
    try {
      if (typeof enricher.peekRtx === 'function' && enricher.peekRtx(userid) !== undefined) return
    } catch {
      // A throwing synchronous cache probe must never block the message.
      return
    }
    await withTimeout(this.enrichIdentity({ userid, chattype: 'single' }), PEER_RESOLVE_TIMEOUT_MS)
  }

  private async driveTurn(
    agent: Agent,
    message: BaseMessage,
    download: MediaPort['download'],
    onDelta?: (delta: TurnDelta) => void,
  ): Promise<Reply> {
    const start = liveEvents(agent.session).length
    const reasoning: string[] = []
    const pendingCalls = new Map<string, { name: string; arguments: string }>()
    const toolCalls: ToolCallSummary[] = []
    const images: ImageAttachmentRef[] = []
    // Forward one model delta to the streaming sink and, for reasoning, to the
    // final process summary. Both delta sources below funnel through here so
    // the two harness generations behave identically.
    const applyDelta = (chunk: { type?: string; text?: string }): void => {
      if (chunk.type === 'text-delta' && chunk.text) {
        onDelta?.({ kind: 'text', text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        reasoning.push(chunk.text)
        onDelta?.({ kind: 'reasoning', text: chunk.text })
      }
    }
    // Live model deltas ride the transient `agent/assistant-stream` event on the
    // current harness (0.1.5-rc.2+): `session/event` no longer carries
    // `assistant/chunk` at all, so subscribing there alone leaves the WeCom
    // stream silent for the whole turn (only the final finish=true frame lands)
    // and `reply.reasoning` empty. Scoped to the agent, so we see only its
    // frames, and torn down with `offStream()` after the turn.
    let sawStreamFrame = false
    const offStream = onAgentEvent(agent.ctx, 'agent/assistant-stream', (raw) => {
      const payload = raw as {
        agent?: unknown
        frame?: { type?: string; chunk?: { type?: string; text?: string } }
      }
      // Scope-filtered dispatch already limits this to the agent; keep the
      // check for harnesses that broadcast the payload unscoped.
      if (payload?.agent !== undefined && payload.agent !== agent) return
      const frame = payload?.frame
      if (frame?.type !== 'chunk') return
      sawStreamFrame = true
      if (frame.chunk !== undefined) applyDelta(frame.chunk)
    })
    // Observe this agent's session firehose for the duration of the turn:
    // collect tool activity for the optional final summary, plus the card
    // images tools produce. Scoped to the agent, so we see only its events and
    // the listener is torn down with `off()` after the turn.
    const off = agent.ctx.on('session/event', (_session, event: SessionEvent) => {
      if (event.type === 'assistant/chunk') {
        // Legacy delta shape, still produced when a session log written by the
        // V0 format is replayed. Ignored once real stream frames are seen so a
        // harness emitting both cannot double-count a delta.
        if (!sawStreamFrame) applyDelta(event.data.chunk)
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
    // Record the turn's sender identity BEFORE the first prompt assembly:
    // the identity section renders from this entry and the `wecomIdentity`
    // service snapshots it. Cleared in `finally` so a later web-UI follow-up
    // (no WeCom turn) sees no sender identity.
    const sessionId = String(agent.session.id)
    const baseIdentity: WecomIdentity = {
      userid: message.from.userid,
      chattype: message.chattype === 'group' ? 'group' : 'single',
      ...(message.chattype === 'group' && message.chatid !== undefined
        ? { chatid: message.chatid }
        : {}),
    }
    // Identity-enricher seam (Q1=A, service pull): if another plugin mounted a
    // resolver under `wecomIdentityEnricher[.namespace]`, let it add resolved
    // facts (rtx/staffId/displayName/...) before the identity is recorded and
    // the first prompt is assembled. Awaiting here is safe — we are inside the
    // async driveTurn, before followup. Any resolver failure is swallowed so
    // the turn falls back to the bare userid (zero behavior change by default).
    const identity = await this.enrichIdentity(baseIdentity)
    this.turnIdentities.set(sessionId, identity)
    try {
      const includeImages = containsImageMedia(message) ? await this.canViewImages(agent) : false
      const content = await toContentBlocks(
        message,
        this.mediaPort(download, sessionId),
        includeImages,
        (userid) => this.peekRtxFor(userid),
      )
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      await this.settleTurn(agent)
    } finally {
      off()
      offStream()
      if (this.turnIdentities.get(sessionId) === identity) {
        this.turnIdentities.delete(sessionId)
      }
    }
    const reply = this.extractText(liveEvents(agent.session).slice(start))
    if (reasoning.length > 0) reply.reasoning = reasoning.join('')
    if (toolCalls.length > 0) reply.toolCalls = toolCalls
    if (images.length > 0) reply.images = images
    return reply
  }

  /**
   * Wait for the agent's turn to settle with a NO-PROGRESS timeout: the
   * deadline resets on every session event AND every live model delta, so a
   * long reasoning pass or a slow tool loop keeps the turn alive as long as it
   * is demonstrably moving. Only a turn that goes silent for turnTimeoutMs is
   * treated as stuck — cancelled so the next message is not queued behind work
   * that will never finish.
   *
   * Both feeds are required: tool activity and step boundaries arrive on
   * `session/event`, while a long reasoning pass with no tool call emits only
   * `agent/assistant-stream` frames. Watching the session firehose alone would
   * treat such a pass as silence and kill a working turn.
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
    const offStream = onAgentEvent(agent.ctx, 'agent/assistant-stream', () => {
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
      offStream()
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
      this.mountIdentitySeams(live.ctx, id)
      return { agent: live, dispose: async () => undefined }
    }

    const agentOptions = this.modelOptions()
    const resolvedPreset = (await this.ctx.agentPresets.resolve(this.config.preset)).id
    const setup = this.mountPreset(resolvedPreset, id)
    const exists = await this.sessionExists(id)

    // Cross-driver contention: the web UI's session controller prepares the
    // SAME persisted session through the same `agents.resume` path. Both sides
    // check `ctx.agents.get(sessionId)` before opening, but a resume only
    // REGISTERS its agent after `open(id,'write')` → cold read → setup, so
    // during that window the check misses on BOTH sides and the second `open`
    // throws SessionAlreadyOwnedError. Retry with backoff, adopting the agent
    // as soon as the other driver publishes it, and only then tell the user
    // something actionable instead of leaking the raw error.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.openAgentOnce(id, sessionId, agentOptions, resolvedPreset, setup, exists)
      } catch (error) {
        if (!isSessionContentionError(error)) throw error
        const adopted = this.ctx.agents.get(sessionId)
        if (adopted !== undefined) {
          this.mountWecomInstructions(adopted)
          this.mountIdentitySeams(adopted.ctx, id)
          return { agent: adopted, dispose: async () => undefined }
        }
        const delay = SESSION_CONTENTION_RETRY_MS[attempt]
        if (delay === undefined) {
          throw new Error(
            '该会话正被另一处同时使用（例如网页界面打开着同一会话），请稍后重试；若网页端正打开该会话，请先关闭它再试。',
          )
        }
        await sleep(delay)
      }
    }
  }

  /**
   * One resume/create attempt: resume an existing log, else create, and fall
   * back to resume when a concurrent driver wins the create race.
   */
  private async openAgentOnce(
    id: string,
    sessionId: SessionId,
    agentOptions: { provider: string; model: string },
    resolvedPreset: string,
    setup: AgentSetup,
    exists: boolean,
  ): Promise<AgentHandle> {
    if (exists) {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
      this.inheritModelSelection(handle.agent)
      await this.groupSession(id, this.headerCwds.get(id), { revive: true })
      return handle
    }

    try {
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
    } catch (error) {
      // Collision: the session identity is already taken even though our
      // existence probe said otherwise — e.g. a concurrent driver (the web UI,
      // or another turn of this same conversation) materialized it between the
      // probe and the create, or a previous create registered the session but
      // failed before its bookkeeping ran. Heal the snapshot and adopt the
      // existing log instead of failing every later message on this chat.
      if (!isAlreadyExistsError(error)) throw error
      this.persisted.add(id)
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
      this.inheritModelSelection(handle.agent)
      await this.groupSession(id, this.headerCwds.get(id), { revive: true })
      return handle
    }
  }

  /**
   * Whether one session identity already exists, from the in-memory snapshot
   * first and the FRESH persistence headers otherwise. The snapshot is a
   * startup-time cache that only grows on this pool's own successful creates,
   * so trusting it alone made the pool call `create` on an existing `~gN`
   * session ("session ... already exists") and, because the snapshot is only
   * updated on success, never recover. A hit from the fresh read is folded
   * back into the snapshot.
   */
  private async sessionExists(id: string): Promise<boolean> {
    if (this.persisted.has(id)) return true
    try {
      const headers = await this.ctx.sessionPersistence.list()
      const found = headers.some((header) => String(header.id) === id)
      if (found) this.persisted.add(id)
      return found
    } catch {
      return false
    }
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

  private mountPreset(presetId: string, sessionId: string): AgentSetup {
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
      this.mountIdentitySeams(agentCtx, sessionId)
    }
  }

  /**
   * Resolve the mounted identity enricher for this row's namespace, or
   * `undefined` when none is mounted (or the lookup itself fails). Shared by
   * {@link enrichIdentity} (async path) and {@link peekRtxFor} (sync path).
   */
  private identityEnricher(): WecomIdentityEnricher | undefined {
    try {
      return this.ctx.get(wecomIdentityEnricherServiceName(this.config.namespace)) as
        | WecomIdentityEnricher
        | undefined
    } catch {
      return undefined
    }
  }

  /**
   * Run the mounted identity enricher (if any) over one base identity and merge
   * the resolved facts into `identity.resolved` (Q2=A). Returns the identity
   * unchanged when no resolver is mounted under this row's namespace, or when
   * the resolver returns `undefined` / throws — the turn then proceeds on the
   * bare WeCom userid, which is the pre-seam behavior.
   */
  private async enrichIdentity(base: WecomIdentity): Promise<WecomIdentity> {
    const enricher = this.identityEnricher()
    if (enricher === undefined) return base
    try {
      const resolved = await enricher.enrich(base)
      if (resolved === undefined) return base
      return { ...base, resolved }
    } catch (error) {
      this.log.warn(
        `identity enricher failed for userid=${base.userid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return base
    }
  }

  /**
   * Synchronous, cache-only RTX for one sender userid (the local-cache seam).
   * When the mounted enricher exposes `peekRtx`, return its cached RTX for an
   * already-resolved sender; otherwise `undefined`. Never touches the network,
   * so it is safe on the synchronous message-intake path (directory naming,
   * sender labels). A miss additionally kicks off a background {@link enrich}
   * to warm the cache so the NEXT message from this sender resolves to the RTX.
   */
  private peekRtxFor(userid: string): string | undefined {
    if (!userid) return undefined
    const enricher = this.identityEnricher()
    if (enricher === undefined || typeof enricher.peekRtx !== 'function') return undefined
    try {
      const hit = enricher.peekRtx(userid)
      if (hit !== undefined) return hit
    } catch {
      return undefined
    }
    // Cache miss: warm it in the background (fire-and-forget) so the next
    // message from this sender resolves synchronously. We build a minimal base
    // identity here; enrich() only reads userid. Failures are swallowed by
    // enrichIdentity's own guard.
    void this.enrichIdentity({
      userid,
      chattype: 'single',
    }).catch(() => undefined)
    return undefined
  }

  /**
   * Install the sender-identity seams on one agent's scoped context: the
   * `wecomIdentity` service presets and plugins may read, and the
   * `wecom-identity` prompt section telling the model who is talking
   * (the message-source marker). Idempotent per context (the same live
   * agent may be adopted more than once).
   *
   * The seams are registered on the agent's shared root scope, and the SAME
   * conversation can reach this method through two different context objects —
   * the preset setup (`agentCtx` on resume/create) and the live-agent adopt
   * path (`live.ctx` in `openAgent`). The `identitySeams` WeakSet keys by
   * context object, so it cannot dedupe across those two references; the
   * `provide`/`section` calls below are therefore wrapped to swallow the
   * duplicate-registration error, which simply means the seam is already in
   * place (mirrors `mountWecomInstructions`).
   */
  private mountIdentitySeams(agentCtx: Context, sessionId: string): void {
    if (this.identitySeams.has(agentCtx)) return
    this.identitySeams.add(agentCtx)
    const identity: WecomIdentityService = {
      snapshot: () => this.turnIdentities.get(sessionId),
    }
    try {
      agentCtx.provide('wecomIdentity', identity)
    } catch (error) {
      this.log.debug('wecomIdentity service already registered: %s', String(error))
    }

    try {
      agentCtx.systemPrompt.section({
        name: 'wecom-identity',
        order: 49,
        text: () => {
          const current = this.turnIdentities.get(sessionId)
          // Outside a WeCom-driven turn (web-UI follow-up on this session, or a
          // session driven by another channel) the section renders empty.
          if (current === undefined) return ''
          // When an enricher resolved the sender's RTX, surface it so the model
          // knows who is actually talking (and can attribute work / billing).
          const who =
            current.resolved?.rtx !== undefined
              ? `当前企业微信用户 ${current.userid}（工蜂 ${current.resolved.rtx}）`
              : `当前企业微信用户 ${current.userid}`
          const scope = current.chattype === 'group' ? '群聊' : '单聊'
          return `${who}，来自企微${scope}。`
        },
      })
    } catch (error) {
      this.log.debug('wecom-identity section already registered: %s', String(error))
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
