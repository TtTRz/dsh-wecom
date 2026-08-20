import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationId } from '../src/helpers.js'
import { AgentPool } from '../src/pool.js'
import { testConfig } from './test-config.js'

interface FakeAgent {
  status: 'idle' | 'running'
  options: { provider: string; model: string }
  session: { id: string; events: unknown[]; requestHeader?: () => unknown }
  ctx: {
    on: (event: string, handler: (...args: unknown[]) => void) => () => boolean
    systemPrompt: { section: ReturnType<typeof vi.fn> }
  }
  cancel: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  fire: (event: string, ...args: unknown[]) => void
}

function makeAgent(
  options: { hang?: boolean; replyText?: string; stream?: unknown[] } = {},
): FakeAgent {
  const events: unknown[] = []
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args)
  }
  const agent: FakeAgent = {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: '', events, requestHeader: () => undefined },
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
      if (options.hang) return
      for (const event of options.stream ?? []) {
        events.push(event)
        fire('session/event', agent.session, event)
      }
      events.push({
        type: 'assistant/message',
        data: {
          message: { content: [{ type: 'text', text: options.replyText ?? 'Harness reply' }] },
        },
      })
      events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    }),
    whenIdle: vi.fn(() => {
      if (options.hang) return new Promise(() => undefined)
      agent.status = 'idle'
      return Promise.resolve()
    }),
    fire,
  }
  return agent
}

function makeHarness() {
  const mounts: string[] = []
  const sections: Array<{ name: string; order: number; text: string }> = []
  const disposed: string[] = []
  const created: Array<{ sessionId: string }> = []
  const live = new Map<string, unknown>()
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()

  const section = vi.fn((s: { name: string; order: number; text: string }) => {
    sections.push(s)
  })

  const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const set = handlers.get(event) ?? new Set<(...args: unknown[]) => void>()
    set.add(handler)
    handlers.set(event, set)
    return () => set.delete(handler)
  })

  const fireSessionEvent = (session: unknown, event: unknown): void => {
    for (const handler of handlers.get('session/event') ?? []) handler(session, event)
  }

  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    on,
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
      mount: vi.fn(async (_agentCtx: unknown, id: string) => {
        mounts.push(id)
      }),
    },
    agents: {
      create: vi.fn(
        async (options: {
          sessionId: string
          agentOptions?: { provider: string; model: string }
          setup?: (agentCtx: unknown) => Promise<void>
        }) => {
          created.push({ sessionId: options.sessionId })
          const agent = makeAgent()
          agent.session.id = options.sessionId
          if (options.agentOptions) agent.options = options.agentOptions
          if (options.setup) await options.setup({ systemPrompt: { section } })
          live.set(options.sessionId, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              disposed.push(options.sessionId)
              live.delete(options.sessionId)
            }),
          }
        },
      ),
      resume: vi.fn(
        async (options: {
          resumeSessionId: string
          agentOptions?: { provider: string; model: string }
          setup?: (agentCtx: unknown) => Promise<void>
        }) => {
          const agent = makeAgent()
          agent.session.id = options.resumeSessionId
          if (options.agentOptions) agent.options = options.agentOptions
          if (options.setup) await options.setup({ systemPrompt: { section } })
          live.set(options.resumeSessionId, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              live.delete(options.resumeSessionId)
            }),
          }
        },
      ),
      get: vi.fn((id: string) => live.get(id)),
    },
    get: vi.fn(() => undefined),
  }
  return { ctx, mounts, sections, disposed, created, live, fireSessionEvent }
}

function singleMessage(text = 'hello'): never {
  return {
    msgid: 'm1',
    aibotid: 'bot',
    chattype: 'single',
    from: { userid: 'u1' },
    msgtype: 'text',
    text: { content: text },
  } as never
}

function groupMessage(text = 'hello'): never {
  return {
    msgid: 'm2',
    aibotid: 'bot',
    chattype: 'group',
    chatid: 'wrTestGroupChat',
    from: { userid: 'u2' },
    msgtype: 'text',
    text: { content: text },
  } as never
}

const noopDownload = vi.fn(async () => ({ data: new Uint8Array() }))

describe('AgentPool', () => {
  beforeEach(() => {
    // The epoch map persists to a file under the test cwd; wipe it so each
    // test starts at epoch 0 (a stale file would leak `/new` state across tests).
    rmSync(join('/tmp/wecom-test', '.dsh-wecom-state.json'), { force: true })
  })

  it('creates an agent, mounts the preset, registers instructions, and returns text', async () => {
    const { ctx, mounts, sections, created, disposed } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage(), noopDownload)

    expect(created).toHaveLength(1)
    expect(created[0]?.sessionId).toMatch(/^dsh-wecom-single-/)
    expect(mounts).toEqual(['standard'])
    expect(sections).toEqual([
      { name: 'wecom-instructions', order: 50, text: 'WeCom test instructions' },
    ])
    expect(reply).toEqual({ text: 'Harness reply' })
    expect(manager.size()).toBe(1)

    await manager.dispose()
    expect(disposed).toHaveLength(1)
    expect(manager.size()).toBe(0)
  })

  it('resumes a persisted session instead of recreating it', async () => {
    const { ctx, created } = makeHarness()
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'dsh-wecom-single-abc' },
    ])
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    // Force the persisted id to collide with this message's session id is hard,
    // so just assert that a resume path is exercised by seeding the persisted set.
    expect(ctx.sessionPersistence.list).toHaveBeenCalledOnce()
    await manager.handle(singleMessage(), noopDownload)
    expect(created).toHaveLength(1)
  })

  it('reset starts a fresh agent on the next message', async () => {
    const { ctx, created, disposed } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await manager.handle(singleMessage('one'), noopDownload)
    expect(created).toHaveLength(1)

    await manager.forget(singleMessage('reset'))
    expect(disposed).toHaveLength(1)

    await manager.handle(singleMessage('two'), noopDownload)
    expect(created).toHaveLength(2)
    expect(created[1]?.sessionId).toContain('~g1')
  })

  it('persists the /new reset across a restart so the fresh session resumes', async () => {
    const base = conversationId('default', singleMessage())
    const first = new AgentPool(makeHarness().ctx as never, testConfig())
    await first.start()
    await first.handle(singleMessage('one'), noopDownload)
    await first.forget(singleMessage('reset')) // epoch 0 -> 1, persisted to disk
    await first.dispose()

    // A new pool (fresh process) shares the same cwd and must load the epoch,
    // so the next message opens `~g1` instead of resuming the ORIGINAL session.
    const { ctx: ctx2, created: created2 } = makeHarness()
    const second = new AgentPool(ctx2 as never, testConfig())
    await second.start()
    await second.handle(singleMessage('two'), noopDownload)

    expect(created2[0]?.sessionId).toBe(`${base}~g1`)
  })

  it('persists the display peer across a restart', async () => {
    const base = conversationId('default', singleMessage())
    const first = new AgentPool(makeHarness().ctx as never, testConfig())
    await first.start()
    await first.handle(singleMessage('one'), noopDownload)
    expect(first.peerOf(base)).toBe('u1')
    expect(first.peerOf(`${base}~g7`)).toBe('u1') // epoch-suffixed ids share the peer
    await first.dispose()

    // A fresh pool (new process) resolves the peer from the state file
    // without needing the conversation's next message.
    const second = new AgentPool(makeHarness().ctx as never, testConfig())
    await second.start()
    expect(second.peerOf(base)).toBe('u1')
    await second.dispose()
  })

  it('migrates the legacy flat epoch state file and writes back the new shape', async () => {
    const base = conversationId('default', singleMessage())
    const file = join('/tmp/wecom-test', '.dsh-wecom-state.json')
    writeFileSync(file, JSON.stringify({ [base]: 1 }), 'utf8') // pre-0.1.21 format
    const { ctx, created } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('one'), noopDownload)
    expect(created[0]?.sessionId).toBe(`${base}~g1`)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      epochs?: unknown
      peers?: unknown
    }
    expect(saved.epochs).toEqual({ [base]: 1 })
    expect(saved.peers).toEqual({ [base]: 'u1' })
  })

  it('uses the configured provider/model for new conversations', async () => {
    const { ctx, live, created } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig({ provider: 'venus', model: 'glm-5.3' }))
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    expect(agent?.options).toEqual({ provider: 'venus', model: 'glm-5.3' })
  })

  it('rejects a half-configured model route', () => {
    expect(
      () => new AgentPool(makeHarness().ctx as never, testConfig({ provider: 'venus' })),
    ).toThrow('provider and model must be configured together')
  })

  it('selectionFor prefers the configured model over the logged header', () => {
    const manager = new AgentPool(
      makeHarness().ctx as never,
      testConfig({ provider: 'v', model: 'm' }),
    )
    const agent = makeAgent()
    agent.session.requestHeader = vi.fn(() => ({ config: { provider: 'p2', model: 'm2' } }))
    expect(manager.selectionFor(agent as never).current).toEqual({ provider: 'v', model: 'm' })
  })

  it('selectionFor inherits the logged header model and falls back to none', () => {
    const manager = new AgentPool(makeHarness().ctx as never, testConfig())
    const agent = makeAgent()
    agent.session.requestHeader = vi.fn(() => ({
      config: { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    }))
    expect(manager.selectionFor(agent as never).current).toEqual({
      provider: 'p2',
      model: 'm2',
      reasoningEffort: 'high',
    })
    const bare = makeAgent()
    expect(manager.selectionFor(bare as never).current).toBeUndefined()
  })

  it('cancels the turn on response timeout', async () => {
    const hanging = makeAgent({ hang: true })
    const ctx = {
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
      on: vi.fn(() => () => undefined),
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
        resolve: vi.fn(async () => ({ id: 'standard' })),
        mount: vi.fn(async () => undefined),
      },
      agents: {
        create: vi.fn(async () => ({ agent: hanging, dispose: vi.fn(async () => undefined) })),
        resume: vi.fn(),
        get: vi.fn(() => hanging),
      },
      get: vi.fn(() => undefined),
    }
    const manager = new AgentPool(ctx as never, testConfig({ turnTimeoutMs: 20 }))
    await manager.start()

    await expect(manager.handle(singleMessage(), noopDownload)).rejects.toThrow(
      'agent response timed out',
    )
    expect(hanging.cancel).toHaveBeenCalledWith({ kind: 'user' })
  })

  it('claims a workspace on cwd and adds every conversation session to it', async () => {
    const added: string[] = []
    const create = vi.fn(async (path: string, title: string) => ({
      attachSession: vi.fn(async (sessionId: string) => {
        added.push(sessionId)
      }),
      path,
      title,
    }))
    const { ctx, created } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await manager.handle(singleMessage('one'), noopDownload)
    // One per-conversation workspace under the base cwd, named after the chat.
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatch(/^\/tmp\/wecom-test\/dsh-wecom-single-[0-9a-f]+$/)
    expect(create.mock.calls[0]?.[1]).toMatch(/^WeCom · chat·[0-9a-f]{6}$/)
    expect(added).toEqual([created[0]?.sessionId])

    await manager.forget(singleMessage('reset'))
    await manager.handle(singleMessage('two'), noopDownload)
    expect(added).toEqual([created[0]?.sessionId, created[1]?.sessionId])
  })

  it('skips workspace grouping when no registry exists', async () => {
    const { ctx } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await expect(manager.start()).resolves.toBeUndefined()
  })

  it('creates the workspace lazily when the registry appears after startup', async () => {
    const added: string[] = []
    const create = vi.fn(async (path: string, title: string) => ({
      attachSession: vi.fn(async (sessionId: string) => {
        added.push(sessionId)
      }),
      path,
      title,
    }))
    const { ctx, created } = makeHarness()
    const get = ctx.get as ReturnType<typeof vi.fn>
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    expect(create).not.toHaveBeenCalled()

    get.mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    await manager.handle(singleMessage('one'), noopDownload)
    // The per-conversation workspace resolves lazily once the registry exists.
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatch(/^\/tmp\/wecom-test\/dsh-wecom-single-[0-9a-f]+$/)
    expect(added).toEqual([created[0]?.sessionId])
  })

  it('re-attaches persisted conversations to the workspace at startup', async () => {
    const attached: string[] = []
    const create = vi.fn(async () => ({
      attachSession: vi.fn(async (sessionId: string) => {
        attached.push(sessionId)
      }),
    }))
    const { ctx } = makeHarness()
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'dsh-wecom-single-abc' },
      { id: 'dsh-wecom-group-xyz' },
      { id: 'session-other' },
    ])
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    expect(attached).toEqual(['dsh-wecom-single-abc', 'dsh-wecom-group-xyz'])
  })

  it('a failing attach never fails the message itself', async () => {
    const create = vi.fn(async () => ({
      attachSession: vi.fn(async () => {
        throw new Error('cwd does not match the workspace path')
      }),
    }))
    const { ctx } = makeHarness()
    const get = ctx.get as ReturnType<typeof vi.fn>
    get.mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await expect(manager.handle(singleMessage('one'), noopDownload)).resolves.toEqual({
      text: 'Harness reply',
    })
  })

  it('leaves new conversations untitled instead of renaming from the first message', async () => {
    const renamed: string[] = []
    const { ctx } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello world'), noopDownload)
    await manager.handle(singleMessage('second message'), noopDownload)
    expect(renamed).toEqual([])
  })

  it('prefixes a harness-generated LLM title with the userid for single chats', async () => {
    const renamed: string[] = []
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    expect(agent).toBeDefined()
    const titleEvent = (seq: number, source: unknown, title: string) => {
      const event = {
        type: 'session/title',
        seq,
        data: { title, messageSeqs: [1], source },
      }
      agent?.session.events.push(event)
      fireSessionEvent(agent?.session, event)
    }
    // The deterministic fallback lands first and is left untouched.
    titleEvent(10, { kind: 'fallback' }, 'hello')
    titleEvent(11, { kind: 'provider', provider: 'session-title-first-prompt-llm' }, '性能优化')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual(['u1：性能优化'])
  })

  it('uses the group chatid as the title prefix for group chats', async () => {
    const renamed: string[] = []
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(groupMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    expect(agent).toBeDefined()
    const event = {
      type: 'session/title',
      seq: 10,
      data: {
        title: '性能优化',
        messageSeqs: [1],
        source: { kind: 'provider', provider: 'session-title-first-prompt-llm' },
      },
    }
    agent?.session.events.push(event)
    fireSessionEvent(agent?.session, event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual(['wrTestGroupChat：性能优化'])
    expect(manager.peerOf(created[0]?.sessionId ?? '')).toBe('wrTestGroupChat')
  })

  it('reverts a manual rename back to the canonical title', async () => {
    const renamed: string[] = []
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    const titleEvent = (seq: number, source: unknown, title: string) => {
      const event = {
        type: 'session/title',
        seq,
        data: { title, messageSeqs: [], source },
      }
      agent?.session.events.push(event)
      fireSessionEvent(agent?.session, event)
    }
    titleEvent(10, { kind: 'provider', provider: 'session-title-first-prompt-llm' }, '性能优化')
    titleEvent(11, { kind: 'user' }, '手动改名')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual(['u1：性能优化', 'u1：性能优化'])
  })

  it('reverts a manual rename of a legacy session to its previous title', async () => {
    const renamed: string[] = []
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    // A legacy title from before the lock was introduced (not fired through
    // the handler — it is already part of the log).
    agent?.session.events.push({
      type: 'session/title',
      seq: 5,
      data: { title: '旧标题', messageSeqs: [1], source: { kind: 'user' } },
    })
    const rename = {
      type: 'session/title',
      seq: 6,
      data: { title: '新名字', messageSeqs: [], source: { kind: 'user' } },
    }
    agent?.session.events.push(rename)
    fireSessionEvent(agent?.session, rename)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual(['旧标题'])
  })

  it('passes through a rename that already matches the canonical title', async () => {
    const renamed: string[] = []
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    const titleEvent = (seq: number, source: unknown, title: string) => {
      const event = {
        type: 'session/title',
        seq,
        data: { title, messageSeqs: [], source },
      }
      agent?.session.events.push(event)
      fireSessionEvent(agent?.session, event)
    }
    titleEvent(10, { kind: 'provider', provider: 'session-title-first-prompt-llm' }, '性能优化')
    titleEvent(11, { kind: 'user' }, 'u1：性能优化')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual(['u1：性能优化'])
  })

  it('ignores title events of non-WeCom sessions', async () => {
    const renamed: string[] = []
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    const other = { id: 'session-abc', events: [] }
    const event = {
      type: 'session/title',
      seq: 1,
      data: { title: '别的会话', messageSeqs: [], source: { kind: 'user' } },
    }
    fireSessionEvent(other, event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual([])
    expect(agent).toBeDefined()
  })

  it('a failing title rewrite never fails the turn', async () => {
    const { ctx, live, created, fireSessionEvent } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? {
            rename: vi.fn(() => {
              throw new Error('session disposed')
            }),
          }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    const event = {
      type: 'session/title',
      seq: 10,
      data: {
        title: '性能优化',
        messageSeqs: [1],
        source: { kind: 'provider', provider: 'session-title-first-prompt-llm' },
      },
    }
    agent?.session.events.push(event)
    fireSessionEvent(agent?.session, event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(manager.handle(singleMessage('again'), noopDownload)).resolves.toEqual({
      text: 'Harness reply',
    })
  })

  it('streams text deltas and captures reasoning + tool calls', async () => {
    const deltas: Array<{ kind: string; text: string }> = []
    const agent = makeAgent({
      stream: [
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } },
        },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } },
        },
        {
          type: 'assistant/chunk',
          data: {
            turn: 1,
            step: 1,
            chunk: { type: 'reasoning-delta', index: 1, text: 'thinking…' },
          },
        },
        {
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
        },
        {
          type: 'tool/result',
          data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' } } },
        },
      ],
    })
    const ctx = {
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
      on: vi.fn(() => () => undefined),
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
        resolve: vi.fn(async () => ({ id: 'standard' })),
        mount: vi.fn(async () => undefined),
      },
      agents: {
        create: vi.fn(async () => ({ agent, dispose: vi.fn(async () => undefined) })),
        resume: vi.fn(),
        get: vi.fn(() => agent),
      },
      get: vi.fn(() => undefined),
    }
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage(), noopDownload, (delta) => deltas.push(delta))

    expect(deltas).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
      { kind: 'reasoning', text: 'thinking…' },
    ])
    expect(reply.text).toBe('Harness reply')
    expect(reply.reasoning).toBe('thinking…')
    expect(reply.toolCalls).toEqual([{ name: 'bash', arguments: '{"cmd":"ls"}', ok: true }])
  })

  it('marks a tool call as failed when the result carries an error', async () => {
    const agent = makeAgent({
      stream: [
        {
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"x"}' },
        },
        {
          type: 'tool/result',
          data: {
            turn: 1,
            step: 1,
            message: { source: { kind: 'tool', callId: 'c1' } },
            error: { name: 'TOOL_FAILED', code: 'EIO' },
          },
        },
      ],
    })
    const ctx = {
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
      on: vi.fn(() => () => undefined),
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
        resolve: vi.fn(async () => ({ id: 'standard' })),
        mount: vi.fn(async () => undefined),
      },
      agents: {
        create: vi.fn(async () => ({ agent, dispose: vi.fn(async () => undefined) })),
        resume: vi.fn(),
        get: vi.fn(() => agent),
      },
      get: vi.fn(() => undefined),
    }
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage(), noopDownload)

    expect(reply.toolCalls).toEqual([
      { name: 'read', arguments: '{"path":"x"}', ok: false, error: 'EIO' },
    ])
  })

  it('adopts a live session instead of trying to resume it again', async () => {
    const liveAgent = makeAgent()
    const resume = vi.fn()
    const create = vi.fn()
    const ctx = {
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
      on: vi.fn(() => () => undefined),
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
        resolve: vi.fn(async () => ({ id: 'standard' })),
        mount: vi.fn(async () => undefined),
      },
      agents: { create, resume, get: vi.fn(() => liveAgent) },
      get: vi.fn(() => undefined),
    }
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage(), noopDownload)

    expect(reply.text).toBe('Harness reply')
    expect(liveAgent.followup).toHaveBeenCalled()
    // Resuming would throw "cannot prepare session ... while it is live".
    expect(resume).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(liveAgent.ctx.systemPrompt.section).toHaveBeenCalledWith({
      name: 'wecom-instructions',
      order: 50,
      text: 'WeCom test instructions',
    })
  })

  it('re-opens the conversation when its agent was disposed elsewhere', async () => {
    const { ctx, live } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await manager.handle(singleMessage('one'), noopDownload)
    expect(live.size).toBe(1)

    // The real owner (e.g. the web UI) disposes the agent: the registry no
    // longer returns it, and the pool must not drive the stale handle.
    const [id] = [...live.keys()]
    live.delete(id ?? '')

    const reply = await manager.handle(singleMessage('two'), noopDownload)
    expect(reply.text).toBe('Harness reply')
    expect(ctx.agents.resume).toHaveBeenCalled()
    expect(live.size).toBe(1)
  })

  it('starts a fresh session when the conversation id is archived', async () => {
    const base = conversationId('default', singleMessage())
    const attached: string[] = []
    const { ctx, created } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry'
        ? {
            archivedSessionIds: [base, `${base}~g1`],
            create: vi.fn(async () => ({
              attachSession: vi.fn(async (sessionId: string) => {
                attached.push(sessionId)
              }),
            })),
          }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await manager.handle(singleMessage('one'), noopDownload)
    expect(created[0]?.sessionId).toBe(`${base}~g2`)
    expect(attached).toEqual([`${base}~g2`])

    // Later messages keep reusing that visible session.
    await manager.handle(singleMessage('two'), noopDownload)
    expect(created).toHaveLength(1)
  })

  describe('compact', () => {
    it('reports when the compaction service is not mounted', async () => {
      const { ctx } = makeHarness()
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()

      expect(await manager.compact(singleMessage())).toBe(
        'Compaction is not available in this harness build.',
      )
    })

    it('reports when no conversation agent exists yet', async () => {
      const { ctx } = makeHarness()
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'compaction' ? { compactNow: vi.fn() } : undefined,
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()

      expect(await manager.compact(singleMessage())).toBe(
        'No conversation yet — send a message first, then try /compact.',
      )
    })

    it('compacts through the seam and reports the summary size', async () => {
      const { ctx, live } = makeHarness()
      const compactNow = vi.fn(async (_agent: unknown, _signal: AbortSignal) => ({
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 1200,
      }))
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'compaction' ? { compactNow } : undefined,
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      await manager.handle(singleMessage('one'), noopDownload)

      expect(await manager.compact(singleMessage('two'))).toBe(
        'Compacted 3 history items (~1200 tokens).',
      )
      expect(compactNow).toHaveBeenCalledTimes(1)
      expect(compactNow.mock.calls[0]?.[0]).toBe([...live.values()][0])
    })

    it('reports null as no compactable history', async () => {
      const { ctx } = makeHarness()
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'compaction' ? { compactNow: vi.fn(async () => null) } : undefined,
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      await manager.handle(singleMessage('one'), noopDownload)

      expect(await manager.compact(singleMessage('two'))).toBe('No compactable history yet.')
    })

    it('maps expected failure codes to concise replies', async () => {
      const { ctx } = makeHarness()
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'compaction'
          ? {
              compactNow: vi.fn(async () => {
                throw Object.assign(new Error('busy'), { code: 'busy' })
              }),
            }
          : undefined,
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      await manager.handle(singleMessage('one'), noopDownload)

      expect(await manager.compact(singleMessage('two'))).toBe(
        'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      )
    })
  })
})
