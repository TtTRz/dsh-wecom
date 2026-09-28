import { SessionId } from '@deepseek-ai/dsh-session'

/** The metadata needed by the channel, independent of persistence generation. */
export interface StoredSessionHeader {
  id: string
  cwd?: string
  createdAt?: number
}

/** Both legacy headers and current snapshots are validated at this boundary. */
export interface SessionListing {
  list(): Promise<readonly unknown[]>
}

export interface SessionLogReader {
  inspect?(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly unknown[] }>
  open?(
    id: SessionId,
    access: 'read',
    options?: { signal?: AbortSignal },
  ): Promise<{
    read(
      offset?: number,
      length?: number,
      options?: { signal?: AbortSignal },
    ): Promise<{ events: readonly unknown[] }>
    close(): Promise<void>
  }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export async function listSessionHeaders(
  persistence: SessionListing,
): Promise<StoredSessionHeader[]> {
  const headers: StoredSessionHeader[] = []
  for (const entry of await persistence.list()) {
    const outer = record(entry)
    if (outer === undefined) continue
    const header = 'header' in outer ? record(outer.header) : outer
    if (header === undefined || typeof header.id !== 'string' || header.id.length === 0) continue
    headers.push({
      id: header.id,
      ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
      ...(typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
        ? { createdAt: header.createdAt }
        : {}),
    })
  }
  return headers
}

/** Read without claiming write ownership; always release a current read handle. */
export async function readSessionEvents(
  persistence: SessionLogReader,
  id: string,
  signal: AbortSignal,
): Promise<readonly unknown[]> {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(SessionId(id), 'read', { signal })
    try {
      return (await handle.read(0, undefined, { signal })).events
    } finally {
      await handle.close()
    }
  }
  if (typeof persistence.inspect === 'function') {
    return (await persistence.inspect(SessionId(id), signal)).events
  }
  throw new Error('Session persistence does not support reading stored events')
}
