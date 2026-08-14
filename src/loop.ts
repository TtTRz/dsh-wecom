import type { WecomChannel } from './channel.js'

/** Narrow log face the restart loop reports through. */
export interface LoopLogger {
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * Own the channel lifecycle: start it, wait for an unrecoverable end (auth
 * failure, reconnect exhaustion, or replacement by another client), then
 * restart after `restartIntervalMs` — indefinitely, unless `isStopped()` turns
 * true (the fiber disposing the loop). This is what keeps the bot alive when
 * the long connection dies instead of leaving a failed fiber behind.
 */
export async function runChannelLoop(
  channel: WecomChannel,
  restartIntervalMs: number,
  log: LoopLogger,
  isStopped: () => boolean,
): Promise<void> {
  for (;;) {
    try {
      await channel.start()
      await channel.untilDead()
      if (isStopped()) return
      log.warn('WeCom connection ended; restarting the channel')
    } catch (error) {
      if (isStopped()) return
      log.error('WeCom channel failed: %s; restarting', String(error))
    }
    await new Promise((resolve) => setTimeout(resolve, restartIntervalMs))
  }
}
