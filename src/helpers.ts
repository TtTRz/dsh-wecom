import { createHash } from 'node:crypto'
import type { BaseMessage } from '@wecom/aibot-node-sdk'

/**
 * Stable, non-reversible session id for one WeCom chat. The raw peer id is
 * salted into a digest, so nothing identifying ever appears in the id.
 */
export function conversationId(
  namespace: string,
  message: Pick<BaseMessage, 'chattype' | 'chatid' | 'from'>,
): string {
  const scope = message.chattype === 'group' ? 'group' : 'single'
  const peer = scope === 'group' ? message.chatid : message.from.userid
  if (peer === undefined || peer.length === 0) {
    throw new Error(`WeCom ${scope} message has no peer identifier`)
  }
  const digest = createHash('sha256')
    .update(`${namespace}\0${scope}\0${peer}`)
    .digest('hex')
    .slice(0, 32)
  return `dsh-wecom-${scope}-${digest}`
}

/** The chat id a reply should be addressed to for this message. */
export function replyTarget(message: Pick<BaseMessage, 'chattype' | 'chatid' | 'from'>): string {
  const target = message.chattype === 'group' ? message.chatid : message.from.userid
  if (target === undefined || target.length === 0) {
    throw new Error('WeCom message has no outbound chat target')
  }
  return target
}

/** Trim and cap text to a UTF-8 byte budget without cutting a code point in half. */
export function clipUtf8(text: string, maxBytes: number, suffix = '\n\n[reply truncated]'): string {
  const normalized = text.trim()
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized
  const suffixBytes = Buffer.byteLength(suffix)
  const available = Math.max(0, maxBytes - suffixBytes)
  let result = ''
  let bytes = 0
  for (const codePoint of normalized) {
    const size = Buffer.byteLength(codePoint)
    if (bytes + size > available) break
    result += codePoint
    bytes += size
  }
  return result + (suffixBytes <= maxBytes ? suffix : '')
}

/** Await `task`, but throw a labeled error if it overruns `timeoutMs`. */
export async function timeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Fixed-size set that remembers seen ids and forgets the oldest ones. */
export class Dedupe {
  private readonly ids = new Set<string>()

  constructor(private readonly limit: number) {}

  /** Return true when `id` was already seen; otherwise record it. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true
    this.ids.add(id)
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
    return false
  }
}

/** Fair counting lock that caps how many operations run at once. */
export class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Semaphore limit must be a positive integer')
    }
    this.permits = limit
  }

  /** Resolve with a release function once a permit is held. */
  acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1
      return Promise.resolve(() => this.release())
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(() => this.release()))
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.permits += 1
  }
}
