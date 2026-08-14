import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ChannelStatus } from './channel.js'

/** JSON served to dashboards and the bundled browser UI; scalars only. */
export interface StatusPayload {
  available: true
  connected: boolean
  stopping: boolean
  conversations: number
  /** Milliseconds since the last successful authentication, or null before it. */
  authenticatedAgoMs: number | null
  lastError: string | null
}

/** Project one channel snapshot into the wire shape. */
export function statusPayload(snapshot: ChannelStatus): StatusPayload {
  return {
    available: true,
    connected: snapshot.connected,
    stopping: snapshot.stopping,
    conversations: snapshot.conversations,
    authenticatedAgoMs:
      snapshot.authenticatedAt === null ? null : Date.now() - snapshot.authenticatedAt,
    lastError: snapshot.lastError,
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

/**
 * Serve `GET /api/wecom/status` for the browser UI. Registering is optional:
 * in profiles without a web server this is a no-op disposer.
 */
export function registerStatusRoute(ctx: Context, snapshot: () => ChannelStatus): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined
  return webServer.register({
    kind: 'exact',
    path: '/api/wecom/status',
    handler: (_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(statusPayload(snapshot())))
    },
  })
}
