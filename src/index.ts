import type { Context } from '@deepseek-ai/cordis'
import { type ChannelStatusService, WecomChannel } from './channel.js'
import { Config, type Config as PluginConfig, type ResolvedConfig, resolveCwd } from './config.js'
import { runChannelLoop } from './loop.js'
import { registerRestartRoute, registerStatusRoute } from './status.js'

export const name = 'dsh-wecom'
export const inject = [
  'agentDefaultModel',
  'agentPresets',
  'agents',
  'attachments',
  'credentials',
  'llm',
  'sessionPersistence',
]

export type { ChannelStatus, ChannelStatusService } from './channel.js'
export type { ResolvedConfig } from './config.js'
export { clipUtf8, conversationId, Dedupe, replyTarget, Semaphore, timeout } from './helpers.js'
export { runChannelLoop } from './loop.js'
export {
  detectImageMediaType,
  type MediaPort,
  safeFilename,
  saveUploadFile,
} from './media.js'
export { containsImageMedia, toContentBlocks } from './message.js'
export type { Reply, ToolCallSummary } from './pool.js'
export {
  registerRestartRoute,
  registerStatusRoute,
  type StatusPayload,
  statusPayload,
} from './status.js'
export type { PluginConfig as ChannelConfig }
export { Config, resolveCwd, WecomChannel }

/**
 * Own the long connection for the fiber's lifetime **without** blocking plugin
 * startup. `apply()` must settle: `dsh web` prints its `dsh web: …?token=…`
 * line only after `loader.await()` observes every plugin's apply settle, and
 * this channel's restart loop (by design) only ends when the fiber unloads.
 * The loop therefore runs detached and the effect registers just the teardown.
 */
export function mountChannel(ctx: Context, channel: WecomChannel, restartIntervalMs: number): void {
  const log = ctx.logger('dsh-wecom')
  ctx.effect(() => {
    let stopped = false
    // The loop swallows its own failures and retries; this guard only keeps a
    // final rejection from surfacing as an unhandled rejection.
    void runChannelLoop(channel, restartIntervalMs, log, () => stopped).catch((error: unknown) => {
      log.error('WeCom channel loop crashed: %s', String(error))
    })
    return async () => {
      stopped = true
      await channel.stop()
    }
  }, 'dsh-wecom.websocket')
}

/** Mount the WeCom long connection and tie teardown to the Cordis lifecycle. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const resolved: ResolvedConfig = { ...config, cwd: resolveCwd(config.cwd) }
  const channel = new WecomChannel(ctx, resolved)
  // Published host-wide so dashboards and UI plugins can render live status
  // without reaching into channel internals. Scoped to this plugin's fiber.
  const status: ChannelStatusService = { snapshot: () => channel.snapshot() }
  ctx.provide('wecomChannelStatus', status)
  // Browser UI + dashboards: `GET /api/wecom/status` (a no-op without a web server).
  ctx.effect(
    () =>
      registerStatusRoute(
        ctx,
        () => channel.snapshot(),
        (id) => channel.peerOf(id),
      ),
    'dsh-wecom.status-route',
  )
  // Browser UI control: `POST /api/wecom/restart` forces an immediate reconnect.
  ctx.effect(() => registerRestartRoute(ctx, () => channel.reconnect()), 'dsh-wecom.restart-route')
  // Restart the channel after every unrecoverable end so a kicked or replaced
  // long connection always comes back instead of leaving a dead bot.
  mountChannel(ctx, channel, resolved.restartIntervalMs)
}

export default { name, inject, Config, apply }
