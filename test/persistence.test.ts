import { describe, expect, it, vi } from 'vitest'
import { listSessionHeaders, readSessionEvents } from '../src/persistence.js'

describe('persistence compatibility', () => {
  it('retains metadata from both generations and skips malformed entries', async () => {
    const header = { id: 'session-example', cwd: '/workspace/example', createdAt: 123 }
    const headers = await listSessionHeaders({
      list: async () => [
        header,
        { header, revision: 'opaque-revision' },
        null,
        undefined,
        [],
        {},
        { id: undefined },
        { id: '' },
        { id: 'outer-id', header: null },
        { header: { id: 123 } },
      ],
    })
    expect(headers).toEqual([header, header])
  })

  it('reads legacy logs with the original timeout signal and receiver', async () => {
    const signal = AbortSignal.timeout(3_000)
    const events = [{ type: 'turn/end' }]
    const persistence = {
      inspect: vi.fn(async function (this: unknown, id, receivedSignal) {
        expect(this).toBe(persistence)
        expect(id).toBe('session-example')
        expect(receivedSignal).toBe(signal)
        return { events }
      }),
    }
    await expect(readSessionEvents(persistence, 'session-example', signal)).resolves.toBe(events)
  })

  it.each(['success', 'read failure', 'timeout'] as const)(
    'releases a read-only handle after %s',
    async (outcome) => {
      const controller = new AbortController()
      const events = [{ type: 'turn/end' }]
      const close = vi.fn(async () => undefined)
      const read = vi.fn(async (_offset, _length, options) => {
        if (outcome === 'read failure') throw new Error('read failed')
        if (outcome === 'timeout') {
          controller.abort(new Error('read timed out'))
          options.signal.throwIfAborted()
        }
        return { events }
      })
      const inspect = vi.fn()
      const persistence = { open: vi.fn(async () => ({ read, close })), inspect }
      const result = readSessionEvents(persistence, 'session-example', controller.signal)
      if (outcome === 'success') await expect(result).resolves.toBe(events)
      else await expect(result).rejects.toThrow(outcome === 'timeout' ? 'timed out' : 'failed')
      expect(persistence.open).toHaveBeenCalledWith('session-example', 'read', {
        signal: controller.signal,
      })
      expect(read).toHaveBeenCalledWith(0, undefined, { signal: controller.signal })
      expect(close).toHaveBeenCalledOnce()
      expect(inspect).not.toHaveBeenCalled()
    },
  )

  it('propagates a failed open without attempting a legacy fallback', async () => {
    const persistence = {
      open: vi.fn(async () => {
        throw new Error('missing session')
      }),
      inspect: vi.fn(),
    }
    await expect(
      readSessionEvents(persistence, 'session-example', AbortSignal.timeout(3_000)),
    ).rejects.toThrow('missing session')
    expect(persistence.inspect).not.toHaveBeenCalled()
  })
})
