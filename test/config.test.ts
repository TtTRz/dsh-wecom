import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, resolveCwd } from '../src/config.js'

const ENV = 'DSH_WECOM_CWD'

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

  it('accepts a missing cwd (resolved later by resolveCwd)', () => {
    expect(Config({ botId: 'b' } as never).cwd).toBeUndefined()
  })

  it('rejects missing required fields', () => {
    expect(() => Config({ cwd: '/tmp' } as never)).toThrow()
  })

  it('rejects an unknown access policy', () => {
    expect(() => Config({ botId: 'b', cwd: '/tmp', dmPolicy: 'nope' } as never)).toThrow()
  })
})

describe('resolveCwd', () => {
  const original = process.env[ENV]
  afterEach(() => {
    if (original === undefined) delete process.env[ENV]
    else process.env[ENV] = original
  })

  it('defaults to ~/.wecom-sessions when nothing else is set', () => {
    delete process.env[ENV]
    expect(resolveCwd()).toBe(join(homedir(), '.wecom-sessions'))
  })

  it('prefers the explicit configured value over the environment', () => {
    process.env[ENV] = '/tmp/env-cwd'
    expect(resolveCwd('/tmp/row-cwd')).toBe('/tmp/row-cwd')
  })

  it('uses the environment override when no row value is given', () => {
    process.env[ENV] = '/tmp/env-cwd'
    expect(resolveCwd()).toBe('/tmp/env-cwd')
  })

  it('rejects a relative configured value', () => {
    delete process.env[ENV]
    expect(() => resolveCwd('.wecom-sessions')).toThrow(/cwd must be absolute/)
  })

  it('rejects a relative environment value', () => {
    process.env[ENV] = 'relative/path'
    expect(() => resolveCwd()).toThrow(/cwd must be absolute/)
  })
})
