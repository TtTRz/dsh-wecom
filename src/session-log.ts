import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Structural views of the harness session APIs this plugin reads across the
 * 0.1.0-rc.x → 0.1.5-rc.x change.
 *
 * `@deepseek-ai/dsh-session` 0.1.0-rc.x exposes the log as the `events` getter;
 * 0.1.5-rc.x REMOVED that getter in favour of `snapshotEvents()` (the whole log
 * when called without arguments), `ownEvents()` and `eventAt(seq)`. `seq` still
 * means "the log length" in both generations, and every accessor returns the
 * same deeply frozen events, so this view lets the plugin read one log on both.
 *
 * The same change moved `sessionPersistence.list()` from stored headers to
 * snapshot wrappers; see {@link storedSessionHeader}.
 */
export interface SessionLogLike {
  /** Next event sequence number — always the log length. */
  readonly seq?: number
  /** 0.1.0-rc.x event log. */
  readonly events?: readonly SessionEvent[]
  /** 0.1.5-rc.x log accessor; a half-open `[fromSeq, toSeqExclusive)` range. */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
}

/** The session's whole event log, on either side of the 0.1.5 API change. */
export function sessionLog(session: SessionLogLike): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

/** The session log from `fromSeq` (an index into the log) to its end. */
export function sessionLogFrom(session: SessionLogLike, fromSeq: number): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents(fromSeq)
  return (session.events ?? []).slice(fromSeq)
}

/** The log length — the index one past the last event. */
export function sessionLogLength(session: SessionLogLike): number {
  const seq = session.seq
  if (typeof seq === 'number') return seq
  return session.events?.length ?? 0
}

/** The slice of one stored session this plugin needs (`sessionPersistence.list()`). */
export interface StoredSessionHeader {
  id: string
  cwd?: string
}

/**
 * Unwrap one `sessionPersistence.list()` entry.
 *
 * 0.1.0-rc.x returned the stored headers directly; 0.1.5-rc.x returns snapshot
 * wrappers (`{ header, revision, sizeBytes }`) and the harness's own consumers
 * unwrap them — `dsh-workspace` reads
 * `(await sessionPersistence.list()).map((snapshot) => snapshot.header)`.
 * Reading `entry.id` off a snapshot yields `undefined`, which silently left the
 * pool's persisted-id and stored-cwd maps empty on 0.1.5: every restart then
 * re-`create()`d sessions that already had a log and failed with
 * `SessionAlreadyExistsError`.
 *
 * @returns the header's id and (when recorded) cwd, or `undefined` when the
 * entry carries no usable id.
 */
export function storedSessionHeader(entry: unknown): StoredSessionHeader | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const wrapper = entry as { header?: unknown }
  const raw = wrapper.header ?? entry
  if (raw === null || typeof raw !== 'object') return undefined
  const header = raw as { id?: unknown; cwd?: unknown }
  if (header.id === undefined || header.id === null) return undefined
  const id = String(header.id)
  return typeof header.cwd === 'string' ? { id, cwd: header.cwd } : { id }
}
