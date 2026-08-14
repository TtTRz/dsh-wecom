import type { Context } from '@deepseek-ai/cordis'
import { type ChannelStatusService, WecomChannel } from './channel.js'
import { Config, type Config as PluginConfig } from './config.js'

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
export {
  detectImageMediaType,
  type MediaPort,
  safeFilename,
  saveUploadFile,
} from './media.js'
export { containsImageMedia, toContentBlocks } from './message.js'
export type { Reply } from './pool.js'
export type { PluginConfig as ChannelConfig }
export { Config, WecomChannel }

/** Mount the WeCom long connection and tie teardown to the Cordis lifecycle. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const channel = new WecomChannel(ctx, config)
  // Published host-wide so dashboards and UI plugins can render live status
  // without reaching into channel internals. Scoped to this plugin's fiber.
  const status: ChannelStatusService = { snapshot: () => channel.snapshot() }
  ctx.provide('wecomChannelStatus', status)
  await ctx.effect(async function* () {
    yield async () => channel.stop()
    await channel.start()
  }, 'dsh-wecom.websocket')
}

export default { name, inject, Config, apply }
