import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { WecomChannel } from '../src/channel.js'
import { mountChannel } from '../src/index.js'

/** Reject after `ms` so a regression that never settles fails instead of hanging. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Channel double: `start` resolves immediately and the death signal is manual. */
function fakeChannel() {
  let resolveDead: () => void = () => undefined
  const dead = new Promise<void>((resolve) => {
    resolveDead = resolve
  })
  const channel = {
    start: vi.fn(async () => undefined),
    untilDead: vi.fn(() => dead),
    stop: vi.fn(async () => {
      resolveDead()
    }),
  }
  return { channel: channel as unknown as WecomChannel, ...channel }
}

describe('mountChannel', () => {
  it('lets plugin apply settle while the channel loop keeps running', async () => {
    const ctx = new Context()
    const { channel, start, stop } = fakeChannel()
    // Regression: `dsh web` waits for every plugin's apply to settle before it
    // prints its URL line, and this loop only ends when the fiber unloads.
    const fiber = ctx.plugin({ name: 'dsh-wecom', apply: (c) => mountChannel(c, channel, 5) })

    await withTimeout(fiber.await(), 1_000)

    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('stops the channel on disposal without resurrecting it', async () => {
    const ctx = new Context()
    const { channel, start, stop } = fakeChannel()
    const fiber = ctx.plugin({ name: 'dsh-wecom', apply: (c) => mountChannel(c, channel, 5) })
    await withTimeout(fiber.await(), 1_000)

    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
  })
})
