import { describe, expect, it } from 'vitest'
import {
  clipUtf8,
  conversationId,
  Dedupe,
  replyTarget,
  Semaphore,
  timeout,
} from '../src/helpers.js'

describe('conversationId', () => {
  it('is stable per single-chat peer without exposing the userid', () => {
    const message = { chattype: 'single' as const, from: { userid: 'sensitive-userid' } }
    const first = conversationId('default', message)
    expect(conversationId('default', message)).toBe(first)
    expect(first).toMatch(/^dsh-wecom-single-[0-9a-f]{32}$/)
    expect(first).not.toContain('sensitive-userid')
    expect(conversationId('other', message)).not.toBe(first)
    expect(replyTarget(message)).toBe('sensitive-userid')
  })

  it('shares one group session and target across senders', () => {
    const first = { chattype: 'group' as const, chatid: 'group-1', from: { userid: 'u1' } }
    const second = { chattype: 'group' as const, chatid: 'group-1', from: { userid: 'u2' } }
    expect(conversationId('default', second)).toBe(conversationId('default', first))
    expect(replyTarget(second)).toBe('group-1')
  })

  it('rejects messages without a peer identifier', () => {
    expect(() =>
      conversationId('default', { chattype: 'single' as const, from: { userid: '' } }),
    ).toThrow('peer identifier')
  })
})

describe('clipUtf8', () => {
  it('bounds bytes without splitting code points', () => {
    expect(clipUtf8(' short ', 20)).toBe('short')
    const clipped = clipUtf8('a😀b😀c', 5, '')
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(5)
    expect([...clipped].at(-1)).toBe('😀')
  })
})

describe('Dedupe', () => {
  it('detects duplicates and evicts the oldest id', () => {
    const seen = new Dedupe(2)
    expect(seen.seen('a')).toBe(false)
    expect(seen.seen('a')).toBe(true)
    expect(seen.seen('b')).toBe(false)
    expect(seen.seen('c')).toBe(false)
    expect(seen.seen('a')).toBe(false)
  })
})

describe('timeout', () => {
  it('preserves fulfillment and rejects a stalled task', async () => {
    await expect(timeout(Promise.resolve('ok'), 50, 'fast')).resolves.toBe('ok')
    await expect(timeout(new Promise(() => undefined), 5, 'slow')).rejects.toThrow('slow timed out')
  })
})

describe('Semaphore', () => {
  it('bounds concurrency and releases permits', async () => {
    const semaphore = new Semaphore(2)
    const release1 = await semaphore.acquire()
    const release2 = await semaphore.acquire()

    let acquired = false
    const pending = semaphore.acquire().then((release) => {
      acquired = true
      release()
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(acquired).toBe(false)

    release1()
    release2()
    await pending
    expect(acquired).toBe(true)
  })

  it('rejects non-positive limits', () => {
    expect(() => new Semaphore(0)).toThrow('positive integer')
  })
})
