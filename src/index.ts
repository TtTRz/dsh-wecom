import type { Context } from '@deepseek-ai/cordis'
import { type ChannelStatusService, WecomChannel } from './channel.js'
import { Config, type Config as PluginConfig } from './config.js'
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
export { clipUtf8, conversationId, Dedupe, replyTarget, Semaphore, timeout } from './helpers.js'
export { runChannelLoop } from './loop.js'
export {
  detectImageMediaType,
  type MediaPort,
  safeFilename,
  saveUploadFile,
} from './media.js'
export { containsImageMedia, toContentBlocks } from './message.js'
export type { Reply } from './pool.js'
export { registerRestartRoute, registerStatusRoute, type StatusPayload, statusPayload } from './status.js'
export type { PluginConfig as ChannelConfig }
export { Config, WecomChannel }

/** Mount the WeCom long connection and tie teardown to the Cordis lifecycle. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const channel = new WecomChannel(ctx, config)
  // Published host-wide so dashboards and UI plugins can render live status
  // without reaching into channel internals. Scoped to this plugin's fiber.
  const status: ChannelStatusService = { snapshot: () => channel.snapshot() }
  ctx.provide('wecomChannelStatus', status)
  // Browser UI + dashboards: `GET /api/wecom/status` (a no-op without a web server).
  ctx.effect(() => registerStatusRoute(ctx, () => channel.snapshot()), 'dsh-wecom.status-route')
  // Browser UI control: `POST /api/wecom/restart` forces an immediate reconnect.
  ctx.effect(() => registerRestartRoute(ctx, () => channel.reconnect()), 'dsh-wecom.restart-route')
  await ctx.effect(async function* () {
    let stopped = false
    yield async () => {
      stopped = true
      await channel.stop()
    }
    // Restart the channel after every unrecoverable end so a kicked or
    // replaced long connection always comes back instead of leaving a dead bot.
    await runChannelLoop(channel, config.restartIntervalMs, ctx.logger('dsh-wecom'), () => stopped)
  }, 'dsh-wecom.websocket')
}

export default { name, inject, Config, apply }
