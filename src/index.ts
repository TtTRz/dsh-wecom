import type { Context } from '@deepseek-ai/cordis'
import { type ChannelStatusService, WecomChannel } from './channel.js'
import {
  Config,
  type Config as PluginConfig,
  resolveCwd,
  sanitizeNamespace,
  statusBaseOf,
} from './config.js'
import { runChannelLoop } from './loop.js'
import { channelStatusServiceName } from './status.js'

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
export { addBot, DEFAULT_PATCH_PATH, editBot, listBots, removeBot } from './manage.js'
export {
  detectImageMediaType,
  type MediaPort,
  safeFilename,
  saveUploadFile,
} from './media.js'
export { containsImageMedia, toContentBlocks } from './message.js'
export type { Reply, ToolCallSummary } from './pool.js'
export { channelStatusServiceName } from './status.js'
export type { PluginConfig as ChannelConfig }
export { Config, resolveCwd, sanitizeNamespace, statusBaseOf, WecomChannel }

/**
 * Mount one WeCom bot long connection and publish its status + reconnect seams
 * under `wecomChannelStatus[.namespace]`. The web console (dsh-wecom-console)
 * consumes those services to render the fleet panel and drive restarts — as of
 * this version dsh-wecom no longer registers any /api/wecom route itself, so no
 * single bot is a "primary" console host; every row is symmetric.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const namespace = sanitizeNamespace(config.namespace)
  const resolved = { ...config, namespace, cwd: resolveCwd(config.cwd) }
  const channel = new WecomChannel(ctx, resolved)
  // Expose both the health snapshot and the reconnect seam to the console.
  const status: ChannelStatusService = {
    snapshot: () => channel.snapshot(),
    reconnect: () => channel.reconnect(),
  }
  ctx.provide(channelStatusServiceName(namespace), status)
  // The websocket loop runs for the life of the fiber. It must NOT be awaited
  // inside apply(): an unresolved apply keeps this row in a non-loaded state,
  // so the status service it provides stays invisible to other plugins — the
  // console would report the bot as「未挂载」. Run the loop imperatively and
  // tie its stop flag to the fiber's teardown via a synchronous effect.
  const stop = { value: false }
  const loop = runChannelLoop(
    channel,
    resolved.restartIntervalMs,
    ctx.logger('dsh-wecom'),
    () => stop.value,
  )
  void loop.catch(() => undefined)
  ctx.effect(
    () => () => {
      stop.value = true
      void channel.stop()
    },
    'dsh-wecom.websocket',
  )
}

export default { name, inject, Config, apply }
