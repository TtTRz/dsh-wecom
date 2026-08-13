import z from '@deepseek-ai/schemastery'

/** Access policy for one WeCom chat scope. */
export type AccessMode = 'open' | 'allowlist' | 'disabled'

/** How inbound images are presented to the selected model. */
export type ImageMode = 'auto' | 'always' | 'never'

/** Runtime-validated plugin configuration. */
export interface Config {
  botId: string
  credentialName: string
  namespace: string
  cwd: string
  wsUrl: string
  /** Named preset mounted into each WeCom-driven agent (gives it tools + persona). */
  preset: string
  dmPolicy: AccessMode
  dmAllowlist: string[]
  groupPolicy: AccessMode
  /** Allowlist of group chatids (only checked when groupPolicy === 'allowlist'). */
  groupAllowlist: string[]
  greeting: string
  /** Persistent prompt section layered on the preset persona on every turn. */
  instructions: string
  /** Attach images when the model can view them (`auto`), or force always/never. */
  imageMode: ImageMode
  connectTimeoutMs: number
  turnTimeoutMs: number
  sendTimeoutMs: number
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  maxAuthFailureAttempts: number
  sendAttempts: number
  replyLimitBytes: number
  dedupeLimit: number
  /** Upper bound on concurrently running agent turns across all conversations. */
  maxConcurrent: number
}

export const Config: z<Config> = z.object({
  botId: z.string().required(),
  credentialName: z.string().default('WECOM_BOT_SECRET'),
  namespace: z.string().default('default'),
  cwd: z.string().required(),
  wsUrl: z.string().default('wss://openws.work.weixin.qq.com'),
  preset: z.string().default('standard'),
  dmPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  dmAllowlist: z.array(z.string()).default([]),
  groupPolicy: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowlist: z.array(z.string()).default([]),
  greeting: z.string().default(''),
  instructions: z
    .string()
    .default(
      'You are replying through WeCom (enterprise chat). Keep replies clear and concise. ' +
        'Do not reveal credentials or internal system data. When a request needs an interactive ' +
        'approval that WeCom cannot provide, explain what approval is needed instead of waiting ' +
        'indefinitely.',
    ),
  imageMode: z.union(['auto', 'always', 'never']).default('auto'),
  connectTimeoutMs: z.number().step(1).min(1).default(30_000),
  turnTimeoutMs: z.number().step(1).min(1).default(300_000),
  sendTimeoutMs: z.number().step(1).min(1).default(30_000),
  reconnectIntervalMs: z.number().step(1).min(100).default(1_000),
  maxReconnectAttempts: z.number().step(1).min(-1).default(10),
  maxAuthFailureAttempts: z.number().step(1).min(1).default(2),
  sendAttempts: z.number().step(1).min(0).max(5).default(2),
  replyLimitBytes: z.number().step(1).min(100).max(20_480).default(20_000),
  dedupeLimit: z.number().step(1).min(100).max(100_000).default(5_000),
  maxConcurrent: z.number().step(1).min(1).max(64).default(4),
})
