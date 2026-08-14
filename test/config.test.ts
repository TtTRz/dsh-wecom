import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'

describe('Config', () => {
  it('applies defaults for optional fields', () => {
    const config = Config({ botId: 'b', cwd: '/tmp' } as never)
    expect(config.credentialName).toBe('WECOM_BOT_SECRET')
    expect(config.preset).toBe('standard')
    expect(config.wsUrl).toBe('wss://openws.work.weixin.qq.com')
    expect(config.dmPolicy).toBe('open')
    expect(config.imageMode).toBe('auto')
    expect(config.turnTimeoutMs).toBe(300_000)
    expect(config.workspaceTitle).toBe('WeCom')
    expect(config.restartIntervalMs).toBe(10_000)
  })

  it('rejects missing required fields', () => {
    expect(() => Config({ botId: 'b' } as never)).toThrow()
    expect(() => Config({ cwd: '/tmp' } as never)).toThrow()
  })

  it('rejects an unknown access policy', () => {
    expect(() => Config({ botId: 'b', cwd: '/tmp', dmPolicy: 'nope' } as never)).toThrow()
  })
})
