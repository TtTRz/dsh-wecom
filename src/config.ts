import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Access policy for one WeCom chat scope. */
export type AccessMode = 'open' | 'allowlist' | 'disabled'

/** How inbound images are presented to the selected model. */
export type ImageMode = 'auto' | 'always' | 'never'

/**
 * Resolve the agent working directory: explicit row config wins, then the
 * `DSH_WECOM_CWD` environment override, then the default `~/.wecom-sessions`
 * so WeCom state and uploads stay out of the process cwd. The result must be
 * absolute; a relative override rejects loudly instead of drifting.
 */
export function resolveCwd(configured?: string): string {
  const cwd = configured ?? process.env.DSH_WECOM_CWD ?? join(homedir(), '.wecom-sessions')
  if (!isAbsolute(cwd)) {
    throw new Error(`dsh-wecom: cwd must be absolute, got ${JSON.stringify(cwd)}`)
  }
  return cwd
}

/**
 * Validate the per-row `namespace`: it keys the session-id digest, the status
 * service name, and the HTTP route suffix, so only route-safe characters are
 * accepted. `default` (the shared legacy value) is also accepted here.
 */
export function sanitizeNamespace(namespace: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(namespace)) {
    throw new Error(
      `dsh-wecom: namespace must match [a-z0-9][a-z0-9_-]{0,31}, got ${JSON.stringify(namespace)}`,
    )
  }
  return namespace
}

/** Route/status base of one channel row: the default keeps its legacy paths. */
export function statusBaseOf(namespace: string): string {
  return namespace === 'default' ? '/api/wecom' : `/api/wecom-${sanitizeNamespace(namespace)}`
}

/**
 * Enriched identity facts produced by an external resolver (Q2=A). These are
 * OPTIONAL and absent unless a {@link WecomIdentityEnricher} service is mounted
 * by another plugin (e.g. an imate/OpenClaw resolver). dsh-wecom never fills
 * them itself; it only merges what the enricher returns into the current
 * turn's {@link WecomIdentity} so the `wecomIdentity` service and the
 * prompt section all read one place.
 */
export interface WecomResolvedIdentity {
  /** Gongfeng username (RTX) resolved from the WeCom userid, when known. */
  readonly rtx?: string
  /** Numeric staff id parsed from the WeCom userid, when known. */
  readonly staffId?: number
  /** Human display name for the sender (falls back to userid when absent). */
  readonly displayName?: string
  /** Free-form extra facts the resolver wants to expose (kept scalar). */
  readonly extra?: Record<string, string | number | boolean>
}

/**
 * Identity facts of the WeCom sender driving the CURRENT turn, keyed by
 * conversation session id. Present only while a WeCom-driven turn runs;
 * a web-UI follow-up or a turn on another channel's agent has no entry,
 * so identity-dependent behavior fails closed there.
 */
export interface WecomIdentity {
  /** `from.userid` of the message that opened this turn. */
  readonly userid: string
  /** Chat scope of that message. */
  readonly chattype: 'single' | 'group'
  /** Group chat id when {@link chattype} is `group`. */
  readonly chatid?: string
  /**
   * Enriched facts merged in from a {@link WecomIdentityEnricher} (Q2=A).
   * `undefined` when no enricher is mounted or enrichment failed; readers must
   * treat every field as optional.
   */
  readonly resolved?: WecomResolvedIdentity
}

/** Read access to a conversation's current-turn identity (absent outside a WeCom turn). */
export interface WecomIdentityService {
  snapshot(): WecomIdentity | undefined
}

/**
 * Pluggable identity resolver seam (Q1=A, service pull). Another plugin
 * provides an implementation under {@link wecomIdentityEnricherServiceName};
 * dsh-wecom calls it once per turn right after the base {@link WecomIdentity}
 * is built (still inside `driveTurn`, before the first prompt is assembled) and
 * merges the returned facts into `identity.resolved`. The call is awaited, so
 * resolvers may hit the network (e.g. OpenClaw `getUsername`). When no enricher
 * is mounted, or it throws, the turn proceeds with the bare userid — zero
 * behavior change for default deployments.
 */
export interface WecomIdentityEnricher {
  /**
   * Resolve extra identity facts for one inbound sender. Called with the base
   * identity (userid/chattype/chatid already set, `resolved` still empty).
   * Return the enriched facts, or `undefined` to leave `resolved` unset.
   * Implementations should cache successes and must not throw for an
   * unresolvable sender — resolve to `undefined` instead so the turn continues.
   */
  enrich(identity: WecomIdentity): Promise<WecomResolvedIdentity | undefined>
  /**
   * OPTIONAL synchronous, cache-only RTX lookup. When an enricher keeps a warm
   * local `userid → rtx` cache, it can expose this so dsh-wecom's synchronous
   * hot paths (directory naming, per-message sender labels) show the RTX for
   * already-resolved senders without awaiting a network call. It MUST NOT hit
   * the network: return the cached RTX on a hit, `undefined` on a miss (the
   * caller then falls back to the userid and lets the async {@link enrich}
   * warm the cache for next time). dsh-wecom duck-checks for this method, so
   * enrichers without a cache simply omit it.
   */
  peekRtx?(userid: string): string | undefined
}

/**
 * Service name under which an identity enricher publishes itself. Mirrors the
 * {@link channelStatusServiceName} convention so a non-default channel row and
 * its resolver can be namespaced together: the resolver mounts
 * `wecomIdentityEnricher.<namespace>` for the row it enriches (or the bare
 * `wecomIdentityEnricher` for the default row).
 */
export function wecomIdentityEnricherServiceName(namespace: string): string {
  return namespace === 'default'
    ? 'wecomIdentityEnricher'
    : `wecomIdentityEnricher.${sanitizeNamespace(namespace)}`
}

/** Runtime-validated plugin configuration as declared in a composition row. */
export interface Config {
  botId: string
  credentialName: string
  namespace: string
  /**
   * Agent working directory, optional in the row. Resolved by {@link resolveCwd}
   * at apply time: explicit value → `DSH_WECOM_CWD` → `~/.wecom-sessions`.
   */
  cwd?: string
  wsUrl: string
  /** Named preset mounted into each WeCom-driven agent (gives it tools + persona). */
  preset: string
  /**
   * Display title of the workspace that groups every WeCom conversation in the
   * web sidebar. The workspace is created (when a workspace registry exists)
   * on `cwd`, so WeCom sessions stop falling into the "Ungrouped" bucket.
   */
  workspaceTitle: string
  dmPolicy: AccessMode
  dmAllowlist: string[]
  groupPolicy: AccessMode
  /** Allowlist of group chatids (only checked when groupPolicy === 'allowlist'). */
  groupAllowlist: string[]
  greeting: string
  /**
   * In-chat sandbox-escalation approvals. `chat` answers every WeCom-agent
   * approval inside the chat that triggered it (reply per the hint pushed with
   * the request); `notify` only pushes the request and leaves the decision to
   * the web UI; `off` behaves as before (silent, web UI decides).
   */
  approvalMode: 'chat' | 'notify' | 'off'
  /** How long an in-chat approval waits for a reply before failing closed. */
  approvalTimeoutMs: number
  /**
   * Senders allowed to answer an in-chat approval (single-chat userids or
   * group sender userids). Empty means every sender the channel already
   * admits may approve.
   */
  approvalAllowlist: string[]
  /** Reply-word hint appended to the pushed approval request. */
  approvalHint: string
  /** Persistent prompt section layered on the preset persona on every turn. */
  instructions: string
  /**
   * Optional fixed model route for every WeCom conversation. Both fields must
   * be set together; when absent, new conversations use the harness default
   * model selection and resumed conversations inherit their last logged
   * model (so web-UI model switches survive restarts).
   */
  provider?: string
  model?: string
  /** Attach images when the model can view them (`auto`), or force always/never. */
  imageMode: ImageMode
  /** Stream model text deltas to WeCom as they are produced; `false` sends only the ack + final answer. */
  streaming: boolean
  /** Cadence (ms) for flushing accumulated streamed text to WeCom. */
  streamFlushMs: number
  /** Append a reasoning/thinking summary to the final reply. */
  showReasoning: boolean
  /** Append a tool-call activity summary to the final reply. */
  showToolCalls: boolean
  connectTimeoutMs: number
  turnTimeoutMs: number
  sendTimeoutMs: number
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  maxAuthFailureAttempts: number
  sendAttempts: number
  replyLimitBytes: number
  dedupeLimit: number
  /** Upper bound on concurrently running agent turns across all conversations. */
  maxConcurrent: number
  /** Delay before the channel restarts after a dead or failed connection. */
  restartIntervalMs: number
  /**
   * Non-default namespaces this row aggregates into its status response as an
   * `instances` list (the panel's bot switcher). Only the row mounted under
   * the `default` namespace should list siblings; each listed sibling must be
   * another dsh-wecom row with that namespace.
   */
  aggregateBots: string[]
  /** Deployment patch the bot manager reads/writes (defaults to ~/.dsh/profiles/web/cordis.patch.yml). */
  patchPath?: string
}

/** Fully resolved runtime config: `cwd` is absolute and non-optional. */
export type ResolvedConfig = Omit<Config, 'cwd'> & { cwd: string }

export const Config: z<Config> = z.object({
  botId: z.string().required(),
  credentialName: z.string().default('WECOM_BOT_SECRET'),
  namespace: z.string().default('default'),
  cwd: z.string(),
  wsUrl: z.string().default('wss://openws.work.weixin.qq.com'),
  preset: z.string().default('standard'),
  workspaceTitle: z.string().default('WeCom'),
  dmPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  dmAllowlist: z.array(z.string()).default([]),
  groupPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowlist: z.array(z.string()).default([]),
  greeting: z.string().default(''),
  /**
   * In-chat sandbox-escalation approvals. `chat` answers every WeCom-agent
   * approval inside the chat that triggered it (reply per the hint pushed with
   * the request); `notify` only pushes the request and leaves the decision to
   * the web UI; `off` behaves as before (silent, web UI decides).
   */
  approvalMode: z.union(['chat', 'notify', 'off']).default('chat'),
  /** How long an in-chat approval waits for a reply before failing closed. */
  approvalTimeoutMs: z.number().step(1).min(10_000).max(1_209_600_000).default(300_000),
  /**
   * Senders allowed to answer an in-chat approval (single-chat userids or
   * group sender userids). Empty means every sender the channel already
   * admits may approve.
   */
  approvalAllowlist: z.array(z.string()).default([]),
  /** Reply-word hint appended to the pushed approval request. */
  approvalHint: z.string().default('回复「批准」继续，回复「拒绝」取消。'),
  instructions: z
    .string()
    .default(
      'You are replying through WeCom (enterprise chat). Keep replies clear and concise. ' +
        'Do not reveal credentials or internal system data. When a request needs an interactive ' +
        'approval that WeCom cannot provide, explain what approval is needed instead of waiting ' +
        'indefinitely.',
    ),
  imageMode: z.union(['auto', 'always', 'never']).default('auto'),
  streaming: z.boolean().default(true),
  streamFlushMs: z.number().step(1).min(50).max(5_000).default(250),
  provider: z.string(),
  model: z.string(),
  showReasoning: z.boolean().default(true),
  showToolCalls: z.boolean().default(true),
  connectTimeoutMs: z.number().step(1).min(1).default(30_000),
  turnTimeoutMs: z.number().step(1).min(1).default(300_000),
  sendTimeoutMs: z.number().step(1).min(1).default(30_000),
  reconnectIntervalMs: z.number().step(1).min(100).default(1_000),
  maxReconnectAttempts: z.number().step(1).min(-1).default(10),
  maxAuthFailureAttempts: z.number().step(1).min(1).default(2),
  sendAttempts: z.number().step(1).min(0).max(5).default(2),
  replyLimitBytes: z.number().step(1).min(100).max(204_800).default(20_000),
  dedupeLimit: z.number().step(1).min(100).max(100_000).default(5_000),
  maxConcurrent: z.number().step(1).min(1).max(64).default(4),
  /** Delay before the channel restarts after a dead or failed connection. */
  restartIntervalMs: z.number().step(1).min(100).default(10_000),
  /** Sibling namespaces aggregated into the default row's status payload. */
  aggregateBots: z.array(z.string()).default([]),
  /** Deployment patch the bot manager reads/writes; defaults to ~/.dsh/profiles/web/cordis.patch.yml. */
  patchPath: z.string(),
})
