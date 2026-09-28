import type { IncomingMessage, ServerResponse } from 'node:http'
import { freemem, loadavg, totalmem } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ChannelStatus } from './channel.js'
import { sanitizeNamespace, statusBaseOf } from './config.js'
import { listSessionHeaders, type SessionListing } from './persistence.js'

/** One live agent projected to the wire; scalars only, no live objects. */
export interface AgentView {
  sessionId: string
  status: string
  model: string
  /** Whether the session is a WeCom conversation of this plugin. */
  wecom: boolean
  /** Display peer (userid or chatid) for WeCom conversations, when known. */
  peer?: string
}

/** Node process + machine load snapshot. */
export interface ProcessView {
  memoryRss: number
  uptimeSec: number
  loadavg: number[]
  totalmem: number
  freemem: number
}

/** Session inventory counts. */
export interface SessionCounts {
  total: number
  wecom: number
}

/** JSON served to dashboards and the bundled browser UI; scalars only. */
export interface StatusPayload {
  available: true
  connected: boolean
  stopping: boolean
  conversations: number
  /** Milliseconds since the last successful authentication, or null before it. */
  authenticatedAgoMs: number | null
  lastError: string | null
  agents: AgentView[]
  process: ProcessView
  sessions: SessionCounts
}

/** Minimal live-agent face; leaf fields are read immediately, nothing retained. */
interface AgentLike {
  session: {
    id: string
    requestHeader?: () => { config?: { model?: unknown } } | undefined
  }
  status: string
  options?: { model?: string }
}

function agentView(
  agent: AgentLike,
  peerOf: ((sessionId: string) => string | undefined) | undefined,
): AgentView {
  const sessionId = String(agent.session.id)
  // The model a conversation actually runs on is folded from its logged
  // request headers — `agent.options` is only the creation-time snapshot and
  // goes stale once the session's model is switched in the web UI.
  const headerModel = agent.session.requestHeader?.()?.config?.model
  const wecom = sessionId.startsWith('dsh-wecom-')
  const peer = wecom ? peerOf?.(sessionId) : undefined
  return {
    sessionId,
    status: agent.status,
    model: typeof headerModel === 'string' ? headerModel : (agent.options?.model ?? ''),
    wecom,
    ...(peer === undefined ? {} : { peer }),
  }
}

/** One sibling bot row aggregated into the default row's status payload. */
export interface InstanceView {
  /** The sibling's `namespace` (also its status base suffix). */
  id: string
  /** Whether the sibling service was reachable in the registry. */
  available: boolean
  connected?: boolean
  conversations?: number
  lastError?: string | null
}

/** Service name under which a channel row publishes its status snapshot. */
export function channelStatusServiceName(namespace: string): string {
  return namespace === 'default'
    ? 'wecomChannelStatus'
    : `wecomChannelStatus.${sanitizeNamespace(namespace)}`
}

/** Aggregate the configured sibling rows into scalar views; missing stay `available:false`. */
function resolveInstances(ctx: Context, namespaces: readonly string[]): InstanceView[] {
  return namespaces.map((id) => {
    try {
      const svc = ctx.get(channelStatusServiceName(id)) as
        | { snapshot?: () => ChannelStatus }
        | undefined
      const snap = svc?.snapshot?.()
      if (snap === undefined) return { id, available: false }
      return {
        id,
        available: true,
        connected: snap.connected,
        conversations: snap.conversations,
        lastError: snap.lastError,
      }
    } catch {
      // The sibling has not activated (yet); surface it as unavailable instead
      // of failing the whole payload.
      return { id, available: false }
    }
  })
}

/** Process and machine load scalars. */
export function processView(): ProcessView {
  return {
    memoryRss: process.memoryUsage().rss,
    uptimeSec: Math.floor(process.uptime()),
    loadavg: [...loadavg()],
    totalmem: totalmem(),
    freemem: freemem(),
  }
}

/** Project one channel snapshot plus runtime inventory into the wire shape. */
export function statusPayload(
  snapshot: ChannelStatus,
  agents: readonly AgentLike[],
  sessionIds: readonly string[],
  peerOf?: (sessionId: string) => string | undefined,
): StatusPayload {
  const views = agents.map((agent) => agentView(agent, peerOf))
  views.sort((a, b) => {
    if (a.status === b.status) return a.sessionId < b.sessionId ? -1 : 1
    return a.status === 'running' ? -1 : 1
  })
  return {
    available: true,
    connected: snapshot.connected,
    stopping: snapshot.stopping,
    conversations: snapshot.conversations,
    authenticatedAgoMs:
      snapshot.authenticatedAt === null ? null : Date.now() - snapshot.authenticatedAt,
    lastError: snapshot.lastError,
    agents: views,
    process: processView(),
    sessions: {
      total: sessionIds.length,
      wecom: sessionIds.filter((id) => id.startsWith('dsh-wecom-')).length,
    },
  }
}

/** Structural face of the optional `webServer` service (absent in non-web profiles). */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}
interface AgentsLike {
  list(): readonly AgentLike[]
}

/**
 * Serve `GET <base>/status` for the browser UI: connection health, live
 * agents, process load, and session counts. The route base follows the row's
 * namespace (`/api/wecom` for the legacy default, `/api/wecom-<ns>` otherwise).
 * A default row may additionally list sibling namespaces (`aggregateBots`),
 * which adds an `instances` array powering the panel's bot switcher.
 * Registering is optional: in profiles without a web server this is a no-op
 * disposer.
 */
export function registerStatusRoute(
  ctx: Context,
  snapshot: () => ChannelStatus,
  peerOf?: (sessionId: string) => string | undefined,
  options: { namespace?: string; aggregateBots?: readonly string[] } = {},
): () => void {
  const base = statusBaseOf(options.namespace ?? 'default')
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined
  return webServer.register({
    kind: 'exact',
    path: `${base}/status`,
    handler: async (_req, res) => {
      const send = (status: number, body: unknown): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(body))
      }
      try {
        const agents = (ctx.get('agents') as AgentsLike | undefined)?.list() ?? []
        const persistence = ctx.get('sessionPersistence') as SessionListing | undefined
        const sessionIds =
          persistence === undefined ? [] : (await listSessionHeaders(persistence)).map((h) => h.id)
        const payload = statusPayload(snapshot(), agents, sessionIds, peerOf)
        send(200, {
          ...payload,
          namespace: options.namespace ?? 'default',
          ...(options.aggregateBots && options.aggregateBots.length > 0
            ? { instances: resolveInstances(ctx, options.aggregateBots) }
            : {}),
        })
      } catch (error) {
        send(500, { available: false, error: String(error) })
      }
    },
  })
}

/**
 * Serve `POST <base>/restart` — force the named row's long connection to
 * reconnect now (e.g. after credential rotation or a stuck socket). The
 * `restart` callback drops the current socket and wakes the owning reconnect
 * loop; it never shuts the bot down. Registering is optional: in profiles
 * without a web server this is a no-op disposer.
 */
export function registerRestartRoute(
  ctx: Context,
  restart: () => void,
  namespace = 'default',
): () => void {
  const base = statusBaseOf(namespace)
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined
  return webServer.register({
    kind: 'exact',
    path: `${base}/restart`,
    handler: (_req, res) => {
      const send = (status: number, body: unknown): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(body))
      }
      try {
        restart()
        send(200, { ok: true })
      } catch (error) {
        send(500, { ok: false, error: String(error) })
      }
    },
  })
}
