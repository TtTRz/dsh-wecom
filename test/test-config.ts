import type { Config } from '../src/config.js'

/** Complete deterministic plugin config for unit tests. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    botId: 'test-bot',
    credentialName: 'WECOM_BOT_SECRET',
    namespace: 'default',
    cwd: '/tmp/wecom-test',
    wsUrl: 'wss://openws.work.weixin.qq.com',
    preset: 'standard',
    workspaceTitle: 'WeCom',
    dmPolicy: 'open',
    dmAllowlist: [],
    groupPolicy: 'open',
    groupAllowlist: [],
    greeting: '',
    instructions: 'WeCom test instructions',
    imageMode: 'auto',
    streaming: true,
    streamFlushMs: 50,
    showReasoning: true,
    showToolCalls: true,
    connectTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
    sendTimeoutMs: 1_000,
    reconnectIntervalMs: 100,
    maxReconnectAttempts: 1,
    maxAuthFailureAttempts: 1,
    sendAttempts: 0,
    replyLimitBytes: 20_000,
    dedupeLimit: 100,
    maxConcurrent: 4,
    restartIntervalMs: 100,
    ...overrides,
  }
}
