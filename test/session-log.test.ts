import { describe, expect, it } from 'vitest'
import {
  type SessionLogLike,
  sessionLog,
  sessionLogFrom,
  sessionLogLength,
  storedSessionHeader,
} from '../src/session-log.js'

/** The events a test session holds; only their identity matters here. */
const events = [{ seq: 0 }, { seq: 1 }, { seq: 2 }] as never[]

/** dsh-session 0.1.0-rc.x: the log is the `events` getter. */
function legacySession(): SessionLogLike {
  return { events, seq: events.length }
}

/** dsh-session 0.1.5-rc.x: the `events` getter is gone; `snapshotEvents()` replaces it. */
function snapshotSession(): SessionLogLike {
  const held = events
  return {
    get seq() {
      return held.length
    },
    snapshotEvents: (from = 0, to = held.length) => held.slice(from, to),
  }
}

describe('session log compatibility', () => {
  it('reads the whole log from either API generation', () => {
    expect(sessionLog(legacySession())).toEqual(events)
    expect(sessionLog(snapshotSession())).toEqual(events)
  })

  it('reports the log length from `seq` in both generations', () => {
    expect(sessionLogLength(legacySession())).toBe(3)
    expect(sessionLogLength(snapshotSession())).toBe(3)
  })

  it('reads the log from one seq onward in both generations', () => {
    expect(sessionLogFrom(legacySession(), 1)).toEqual(events.slice(1))
    expect(sessionLogFrom(snapshotSession(), 1)).toEqual(events.slice(1))
  })

  it('treats a session with neither accessor as an empty log', () => {
    const bare: SessionLogLike = {}
    expect(sessionLog(bare)).toEqual([])
    expect(sessionLogFrom(bare, 2)).toEqual([])
    expect(sessionLogLength(bare)).toBe(0)
  })

  it('prefers the 0.1.5 accessor when a session somehow carries both', () => {
    const both: SessionLogLike = {
      events: [],
      seq: 0,
      snapshotEvents: () => events,
    }
    expect(sessionLog(both)).toEqual(events)
  })
})

describe('storedSessionHeader', () => {
  it('reads the header behind a 0.1.5 snapshot wrapper', () => {
    expect(
      storedSessionHeader({
        header: { id: 'dsh-wecom-single-a', cwd: '/root/ws/a' },
        revision: 'r1',
        sizeBytes: 42,
      }),
    ).toEqual({ id: 'dsh-wecom-single-a', cwd: '/root/ws/a' })
  })

  it('reads a 0.1.0-rc.x stored header directly', () => {
    expect(storedSessionHeader({ id: 'session-b', cwd: '/root/ws/b' })).toEqual({
      id: 'session-b',
      cwd: '/root/ws/b',
    })
  })

  it('returns undefined when the entry carries no id', () => {
    expect(storedSessionHeader({ header: {}, revision: 'r' })).toBeUndefined()
    expect(storedSessionHeader({ revision: 'r' })).toBeUndefined()
    expect(storedSessionHeader(null)).toBeUndefined()
    expect(storedSessionHeader('nope')).toBeUndefined()
  })

  it('omits a cwd that is not a string', () => {
    expect(storedSessionHeader({ header: { id: 's3', cwd: 7 } })).toEqual({ id: 's3' })
    expect(storedSessionHeader({ id: 's4' })).toEqual({ id: 's4' })
  })
})
