import { describe, expect, it } from 'vitest'
import { liveEvents } from '../src/pool.js'

/**
 * The harness renamed `session.events` (getter) to `session.snapshotEvents()`
 * in @deepseek-ai/dsh-session 0.1.5-rc.2. This package's pinned types are the
 * older ones, so `session.events` still compiled while the runtime answered
 * `undefined` — crashing the first turn of every conversation after the
 * 2026-09-11 upgrade. `liveEvents` must read EITHER shape.
 */
describe('liveEvents', () => {
  it('prefers the new snapshotEvents() accessor', () => {
    const events = [{ type: 'turn/end' }]
    const session = {
      events: [{ type: 'stale' }],
      snapshotEvents: () => events,
    }
    expect(liveEvents(session)).toBe(events)
  })

  it('falls back to the old events getter when snapshotEvents is absent', () => {
    const events = [{ type: 'turn/end' }]
    expect(liveEvents({ events })).toBe(events)
  })

  it('returns an empty list when neither accessor exists (the crash case)', () => {
    expect(liveEvents({ id: 'dsh-wecom-single-x' })).toEqual([])
  })

  it('returns an empty list for a missing session', () => {
    expect(liveEvents(undefined)).toEqual([])
    expect(liveEvents(null)).toEqual([])
  })
})
