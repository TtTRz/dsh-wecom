import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WecomChannel } from '../src/channel.js'
import { runChannelLoop } from '../src/loop.js'

type FakeChannel = WecomChannel & { starts(): number; kill(): void }

/**
 * Channel double: `start` resolves dead after `deadAfterStarts` runs (so an
 * awaiting `untilDead` wakes and the loop restarts), or always throws when
 * `failAlways` is set. `kill()` resolves the current death signal by hand.
 */
function fakeChannel(
  options: { failAlways?: boolean; deadAfterStarts?: number } = {},
): FakeChannel {
  let startCount = 0
  let resolveDead: () => void = () => undefined
  const dead = new Promise<void>((resolve) => {
    resolveDead = resolve
  })
  const channel = {
    start: vi.fn(async () => {
      startCount += 1
      if (options.failAlways === true) throw new Error('auth failed')
      if (options.deadAfterStarts !== undefined && startCount >= options.deadAfterStarts) {
        resolveDead()
      }
    }),
    untilDead: vi.fn(() => dead),
    starts: () => startCount,
    kill: () => resolveDead(),
  } as unknown as FakeChannel
  return channel
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runChannelLoop', () => {
  it('restarts after the connection dies', async () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const channel = fakeChannel({ deadAfterStarts: 1 })
    let stopped = false
    const loop = runChannelLoop(channel, 10, { warn, error: vi.fn() }, () => stopped)
    await vi.advanceTimersByTimeAsync(30)
    stopped = true
    channel.kill()
    await vi.advanceTimersByTimeAsync(30)
    await loop
    expect(channel.starts()).toBeGreaterThanOrEqual(2)
    expect(warn).toHaveBeenCalledWith('WeCom connection ended; restarting the channel')
  })

  it('keeps retrying after startup failures', async () => {
    vi.useFakeTimers()
    const error = vi.fn()
    const channel = fakeChannel({ failAlways: true })
    let stopped = false
    const loop = runChannelLoop(channel, 10, { warn: vi.fn(), error }, () => stopped)
    await vi.advanceTimersByTimeAsync(25)
    stopped = true
    await vi.advanceTimersByTimeAsync(25)
    await loop
    expect(channel.starts()).toBeGreaterThanOrEqual(2)
    expect(error).toHaveBeenCalledWith('WeCom channel failed: %s; restarting', 'Error: auth failed')
  })

  it('returns promptly once stopped', async () => {
    const channel = fakeChannel()
    const loop = runChannelLoop(channel, 10, { warn: vi.fn(), error: vi.fn() }, () => true)
    channel.kill()
    await expect(loop).resolves.toBeUndefined()
  })
})
