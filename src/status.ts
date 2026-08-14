import type { IncomingMessage, ServerResponse } from 'node:http'
import { freemem, loadavg, totalmem } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ChannelStatus } from './channel.js'

/** One live agent projected to the wire; scalars only, no live objects. */
export interface AgentView {
  sessionId: string
  status: string
  model: string
  /** Whether the session is a WeCom conversation of this plugin. */
  wecom: boolean
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
  session: { id: string }
  status: string
  options?: { model?: string }
}

function agentView(agent: AgentLike): AgentView {
  const sessionId = String(agent.session.id)
  return {
    sessionId,
    status: agent.status,
    model: agent.options?.model ?? '',
    wecom: sessionId.startsWith('dsh-wecom-'),
  }
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
): StatusPayload {
  const views = agents.map(agentView)
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
interface PersistenceLike {
  list(): Promise<readonly { id: string }[]>
}

/**
 * Serve `GET /api/wecom/status` for the browser UI: connection health, live
 * agents, process load, and session counts. Registering is optional: in
 * profiles without a web server this is a no-op disposer.
 */
export function registerStatusRoute(ctx: Context, snapshot: () => ChannelStatus): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined
  return webServer.register({
    kind: 'exact',
    path: '/api/wecom/status',
    handler: async (_req, res) => {
      const send = (status: number, body: unknown): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(body))
      }
      try {
        const agents = (ctx.get('agents') as AgentsLike | undefined)?.list() ?? []
        const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
        const sessionIds =
          persistence === undefined ? [] : (await persistence.list()).map((h) => String(h.id))
        send(200, statusPayload(snapshot(), agents, sessionIds))
      } catch (error) {
        send(500, { available: false, error: String(error) })
      }
    },
  })
}
