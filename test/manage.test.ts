import { describe, expect, it } from 'vitest'
import { addBot, editBot, listBots, removeBot } from '../src/manage.js'

const FIXTURE = `# wecom-channel 行覆盖：固定所有 wecom 会话的模型路由（provider/model 成对）。
- id: wecom-channel
  name: dsh-wecom
  config:
    botId: !!js process.env.WECOM_BOT_ID
    credentialName: WECOM_BOT_SECRET
    namespace: default
    preset: mp-perf
    workspaceTitle: WeCom
    provider: codebuddy
    model: deepseek-v4-flash-ioa
    turnTimeoutMs: 1200000
    replyLimitBytes: 50000

# a2a 行覆盖：本机部署身份。
- id: a2a
  name: dsh-a2a
  config:
    server:
      enabled: !!js process.env.A2A_ENABLED !== '0'
      preset: mp-perf
`

describe('manage bot rows', () => {
  it('lists only dsh-wecom rows with scalar config', () => {
    const bots = listBots(FIXTURE)
    expect(bots).toEqual([
      {
        id: 'wecom-channel',
        namespace: 'default',
        preset: 'mp-perf',
        workspaceTitle: 'WeCom',
        credentialName: 'WECOM_BOT_SECRET',
        botIdExpr: '!!js process.env.WECOM_BOT_ID',
        isDefault: true,
      },
    ])
  })

  it('edits preset and workspaceTitle in place, preserving comments and env expressions', () => {
    const next = editBot(FIXTURE, 'wecom-channel', {
      preset: 'code',
      workspaceTitle: '客服助手',
    })
    expect(next).toContain('preset: code')
    expect(next).toContain('workspaceTitle: 客服助手')
    // The a2a row and the header comment stay untouched.
    expect(next).toContain('name: dsh-a2a')
    expect(next).toContain('# wecom-channel 行覆盖')
    expect(next).toContain('botId: !!js process.env.WECOM_BOT_ID')
    expect(next).toContain('turnTimeoutMs: 1200000')
  })

  it('edits a missing workspaceTitle by inserting under config:', () => {
    const noTitle = FIXTURE.replace('    workspaceTitle: WeCom\n', '')
    const next = editBot(noTitle, 'wecom-channel', { workspaceTitle: '新名字' })
    expect(next).toContain('workspaceTitle: 新名字')
    expect(next).toContain('namespace: default')
  })

  it('adds a new bot row with a derived env var and sanitized namespace', () => {
    const next = addBot(FIXTURE, { namespace: 'support', name: '客服助手', preset: 'code' })
    const bots = listBots(next)
    expect(bots.map((b) => b.id)).toEqual(['wecom-channel', 'wecom-channel-support'])
    const added = bots[1]
    expect(added).toBeDefined()
    if (added === undefined) throw new Error('missing added bot')
    expect(added.namespace).toBe('support')
    expect(added.preset).toBe('code')
    expect(added.workspaceTitle).toBe('客服助手')
    expect(next).toContain('botId: !!js process.env.WECOM_BOT_ID_SUPPORT')
  })

  it('rejects a namespace that would break routes', () => {
    expect(() => addBot(FIXTURE, { namespace: 'Bad/ns', name: 'x', preset: 'code' })).toThrow(
      /namespace must match/,
    )
  })

  it('deletes a wecom row and its preceding comment', () => {
    const next = removeBot(FIXTURE, 'wecom-channel')
    expect(next).not.toContain('wecom-channel')
    expect(next).not.toContain('# wecom-channel 行覆盖')
    expect(next).toContain('name: dsh-a2a')
  })

  it('throws when the target id is not a wecom row', () => {
    expect(() => editBot(FIXTURE, 'a2a', { preset: 'code' })).toThrow(/no bot row/)
  })
})

describe('editBot namespace', () => {
  it('changes the namespace field in place', () => {
    const next = editBot(FIXTURE, 'wecom-channel', { namespace: 'lab' })
    expect(next).toContain('namespace: lab')
    expect(next).toContain('botId: !!js process.env.WECOM_BOT_ID')
  })

  it('rejects a namespace that would break routes', () => {
    expect(() => editBot(FIXTURE, 'wecom-channel', { namespace: 'Bad/ns' })).toThrow(
      /namespace must match/,
    )
  })
})
