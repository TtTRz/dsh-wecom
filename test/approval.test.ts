import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationId } from '../src/helpers.js'
import { AgentPool, ApprovalBridge } from '../src/pool.js'
import { testConfig } from './test-config.js'

/** Structural face of the harness approval request the bridge consumes. */
interface FakeApprovalRequest {
  agent: {
    session: {
      id: string
      events: Array<{ type: string; data?: { id?: string; callId?: string } }>
    }
  }
  toolName: string
  reason?: string
  signal?: {
    aborted?: boolean
    addEventListener?: (t: string, fn: () => void, o?: unknown) => void
  }
}

function singleMessage(text = 'hello', userid = 'u1'): never {
  return {
    msgid: `m-${text}-${userid}`,
    aibotid: 'bot',
    chattype: 'single',
    from: { userid },
    msgtype: 'text',
    text: { content: text },
  } as never
}

const noopDownload = vi.fn(async () => ({ data: new Uint8Array() }))
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} }

describe('ApprovalBridge', () => {
  beforeEach(() => {
    rmSync(join('/tmp/wecom-test', '.dsh-wecom-state.json'), { force: true })
    ApprovalBridge.TIMEOUT_MS = 300_000
  })

  /** Drive one escalation through the bridge with a minimal pool fixture. */
  function makeBridge(options: { mode?: 'chat' | 'notify' | 'off'; allowlist?: string[] } = {}) {
    const pushes: Array<{ sessionId: string; text: string }> = []
    const bridge = new ApprovalBridge(quietLogger as never, {
      ...testConfig(options.allowlist ? { approvalAllowlist: options.allowlist } : {}),
      ...(options.mode ? { approvalMode: options.mode } : {}),
    })
    const owned = new Set<string>()
    const fallback = vi.fn(async () => 'unavailable' as const)
    bridge.start(
      { on: (_name: string, _fn: never) => () => true } as never,
      (sessionId: string) => owned.has(sessionId),
      async (sessionId: string, text: string) => {
        pushes.push({ sessionId, text })
      },
    )
    const ask = (request: FakeApprovalRequest) => {
      const driver = bridge as unknown as {
        onRequest: (req: FakeApprovalRequest, next: () => Promise<string>) => Promise<string>
      }
      return driver.onRequest(request, fallback)
    }
    return { bridge, pushes, owned, ask, fallback }
  }

  it('claims an owned session ask, pushes it, and resolves from the chat reply', async () => {
    const { bridge, pushes, owned, ask } = makeBridge()
    const sessionId = 'dsh-wecom-single-abc'
    owned.add(sessionId)
    const events = [{ type: 'approval/asked', data: { id: 'ap1', callId: 'c1' } }]
    const pending = ask({
      agent: { session: { id: sessionId, events } },
      toolName: 'bash',
      reason: '写 .git/config',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.sessionId).toBe(sessionId)
    expect(pushes[0]?.text).toContain('bash')
    expect(pushes[0]?.text).toContain('批准')

    const outcome = bridge.reply(singleMessage('批准'), () => sessionId)
    expect(outcome).toBe('allowed-once')
    expect(await pending).toBe('allowed-once')
  })

  it('resolves rejected from a 拒绝 reply', async () => {
    const { bridge, owned, ask } = makeBridge()
    const sessionId = 'dsh-wecom-single-abc'
    owned.add(sessionId)
    const pending = ask({
      agent: {
        session: { id: sessionId, events: [{ type: 'approval/asked', data: { id: 'ap2' } }] },
      },
      toolName: 'bash',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.reply(singleMessage('拒绝'), () => sessionId)).toBe('rejected')
    expect(await pending).toBe('rejected')
  })

  it('falls through to next() for a session the pool does not own', async () => {
    const { pushes, ask, fallback } = makeBridge()
    const pending = ask({
      agent: {
        session: {
          id: 'some-web-session',
          events: [{ type: 'approval/asked', data: { id: 'ap3' } }],
        },
      },
      toolName: 'bash',
    })
    expect(await pending).toBe('unavailable')
    expect(fallback).toHaveBeenCalledOnce()
    expect(pushes).toHaveLength(0)
  })

  it('falls through when the session log has no un-decided approval/asked id', async () => {
    const { owned, ask, fallback } = makeBridge()
    owned.add('dsh-wecom-single-x')
    const pending = ask({
      agent: { session: { id: 'dsh-wecom-single-x', events: [] } },
      toolName: 'bash',
    })
    expect(await pending).toBe('unavailable')
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('times out to cancelled when nobody replies', async () => {
    ApprovalBridge.TIMEOUT_MS = 20
    const { bridge, owned, ask } = makeBridge()
    const sessionId = 'dsh-wecom-single-abc'
    owned.add(sessionId)
    const pending = ask({
      agent: {
        session: { id: sessionId, events: [{ type: 'approval/asked', data: { id: 'ap4' } }] },
      },
      toolName: 'bash',
    })
    expect(await pending).toBe('cancelled')
    // The timed-out approval is gone: later reply words no longer match.
    expect(bridge.reply(singleMessage('批准'), () => sessionId)).toBeUndefined()
  })

  it('ignores reply words from senders outside the allowlist', async () => {
    const { bridge, pushes, owned, ask } = makeBridge({ allowlist: ['u1'] })
    const sessionId = 'dsh-wecom-single-abc'
    owned.add(sessionId)
    const pending = ask({
      agent: {
        session: { id: sessionId, events: [{ type: 'approval/asked', data: { id: 'ap5' } }] },
      },
      toolName: 'bash',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // An unauthorized sender's 批准 is not an approval answer — and their
    // message must NOT resolve the pending ask.
    expect(bridge.reply(singleMessage('批准', 'stranger'), () => sessionId)).toBeUndefined()
    // The authorized sender can still answer.
    expect(bridge.reply(singleMessage('批准', 'u1'), () => sessionId)).toBe('allowed-once')
    expect(await pending).toBe('allowed-once')
    expect(pushes).toHaveLength(1)
  })

  it('non-reply text is not consumed as an approval answer', async () => {
    const { bridge, owned, ask } = makeBridge()
    const sessionId = 'dsh-wecom-single-abc'
    owned.add(sessionId)
    const pending = ask({
      agent: {
        session: { id: sessionId, events: [{ type: 'approval/asked', data: { id: 'ap6' } }] },
      },
      toolName: 'bash',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.reply(singleMessage('帮我看看启动耗时'), () => sessionId)).toBeUndefined()
    expect(bridge.reply(singleMessage('  ＯＫ  '), () => sessionId)).toBe('allowed-once')
    expect(await pending).toBe('allowed-once')
  })

  it('notify mode pushes the ask but leaves the decision to the web UI', async () => {
    const { pushes, owned, ask, fallback } = makeBridge({ mode: 'notify' })
    const sessionId = 'dsh-wecom-single-abc'
    owned.add(sessionId)
    const pending = ask({
      agent: {
        session: { id: sessionId, events: [{ type: 'approval/asked', data: { id: 'ap7' } }] },
      },
      toolName: 'bash',
      reason: '升级权限',
    })
    expect(await pending).toBe('unavailable')
    expect(fallback).toHaveBeenCalledOnce()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.text).toContain('升级权限')
  })

  it('off mode is fully silent', async () => {
    const { pushes, owned, ask, fallback } = makeBridge({ mode: 'off' })
    owned.add('dsh-wecom-single-abc')
    const pending = ask({
      agent: {
        session: {
          id: 'dsh-wecom-single-abc',
          events: [{ type: 'approval/asked', data: { id: 'ap8' } }],
        },
      },
      toolName: 'bash',
    })
    expect(await pending).toBe('unavailable')
    expect(pushes).toHaveLength(0)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('answers the same chat only: a foreign chat reply leaves the ask pending', async () => {
    const { bridge, owned, ask } = makeBridge()
    owned.add('dsh-wecom-single-abc')
    const pending = ask({
      agent: {
        session: {
          id: 'dsh-wecom-single-abc',
          events: [{ type: 'approval/asked', data: { id: 'ap9' } }],
        },
      },
      toolName: 'bash',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      bridge.reply(singleMessage('批准', 'other'), () => 'dsh-wecom-single-zzz'),
    ).toBeUndefined()
    expect(bridge.reply(singleMessage('批准'), () => 'dsh-wecom-single-abc')).toBe('allowed-once')
    expect(await pending).toBe('allowed-once')
  })
})

describe('AgentPool approval wiring', () => {
  beforeEach(() => {
    rmSync(join('/tmp/wecom-test', '.dsh-wecom-state.json'), { force: true })
  })

  it('wireApprovals returns a reply interceptor bound to the pool conversations', async () => {
    const { pool, pushes } = makePoolWithHarness()
    await pool.start()
    const intercept = pool.wireApprovals(async (sessionId, text) => {
      pushes.push({ sessionId, text })
    })
    // Open the conversation so the pool owns its session, then escalate.
    await pool.handle(singleMessage(), noopDownload)
    const sessionId = conversationId('default', singleMessage())
    const events = [{ type: 'approval/asked', data: { id: 'ap10' } }]
    const approvals = (
      pool as unknown as {
        approvals: {
          onRequest: (req: FakeApprovalRequest, next: () => Promise<string>) => Promise<string>
        }
      }
    ).approvals
    const pending = approvals.onRequest(
      { agent: { session: { id: sessionId, events } }, toolName: 'bash' },
      async () => 'unavailable',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pushes).toHaveLength(1)

    // The interceptor resolves the pending ask from the chat's own message.
    expect(intercept(singleMessage('批准'))).toBe('allowed-once')
    expect(await pending).toBe('allowed-once')
    await pool.dispose()
  })

  it('dispose resolves pending approvals as rejected', async () => {
    const { pool } = makePoolWithHarness()
    await pool.start()
    pool.wireApprovals(async () => {})
    await pool.handle(singleMessage(), noopDownload)
    const base = conversationId('default', singleMessage())
    const approvals = (
      pool as unknown as {
        approvals: {
          onRequest: (req: FakeApprovalRequest, next: () => Promise<string>) => Promise<string>
        }
      }
    ).approvals
    const pending = approvals.onRequest(
      {
        agent: {
          session: { id: base, events: [{ type: 'approval/asked', data: { id: 'ap11' } }] },
        },
        toolName: 'bash',
      },
      async () => 'unavailable',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await pool.dispose()
    expect(await pending).toBe('rejected')
  })
})

/** Minimal harness fake able to run one full turn (mirrors pool.test.ts). */
function makePoolWithHarness() {
  const pushes: Array<{ sessionId: string; text: string }> = []
  const live = new Map<string, unknown>()

  const makeAgent = (sessionId: string): unknown => {
    const events: unknown[] = []
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    const agent = {
      status: 'idle',
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: { id: sessionId, events, requestHeader: () => undefined },
      ctx: {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          const set = handlers.get(event) ?? new Set<(...args: unknown[]) => void>()
          set.add(handler)
          handlers.set(event, set)
          return () => set.delete(handler)
        },
        systemPrompt: { section: vi.fn() },
      },
      cancel: vi.fn(),
      followup: vi.fn(() => {
        agent.status = 'running'
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'ok' }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
        agent.status = 'idle'
      }),
      whenIdle: vi.fn(() => {
        agent.status = 'idle'
        return Promise.resolve()
      }),
    }
    return agent
  }

  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    on: vi.fn(() => () => true),
    sessionPersistence: { list: vi.fn(async () => []) },
    agentDefaultModel: {
      currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })),
    },
    attachments: {
      imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000 },
      saveImage: vi.fn(),
    },
    llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
    agentPresets: {
      resolve: vi.fn(async (id: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async () => {}),
    },
    agents: {
      create: vi.fn(async (options: { sessionId: string }) => {
        const agent = makeAgent(options.sessionId)
        live.set(options.sessionId, agent)
        return { agent, dispose: vi.fn(async () => live.delete(options.sessionId)) }
      }),
      resume: vi.fn(async (options: { resumeSessionId: string }) => {
        const agent = makeAgent(options.resumeSessionId)
        live.set(options.resumeSessionId, agent)
        return { agent, dispose: vi.fn(async () => live.delete(options.resumeSessionId)) }
      }),
      get: vi.fn((id: string) => live.get(id)),
    },
    get: vi.fn(() => undefined),
  }
  const pool = new AgentPool(ctx as never, testConfig())
  return { pool, ctx, pushes, live }
}
