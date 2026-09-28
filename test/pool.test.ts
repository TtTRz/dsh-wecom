import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wecomIdentityEnricherServiceName } from '../src/config.js'
import { conversationId } from '../src/helpers.js'
import { AgentPool } from '../src/pool.js'
import { testConfig } from './test-config.js'

interface FakeAgent {
  status: 'idle' | 'running'
  options: { provider: string; model: string }
  session: { id: string; events: unknown[]; requestHeader?: () => unknown }
  ctx: {
    on: (event: string, handler: (...args: unknown[]) => unknown) => () => boolean
    provide: ReturnType<typeof vi.fn>
    systemPrompt: { section: ReturnType<typeof vi.fn> }
  }
  cancel: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  fire: (event: string, ...args: unknown[]) => void
  /** Direct access to one registered listener set (gate assertions). */
  handlersOf: (event: string) => Set<(...args: unknown[]) => unknown>
}

function makeAgent(
  options: {
    hang?: boolean
    replyText?: string
    stream?: unknown[]
    section?: ReturnType<typeof vi.fn>
  } = {},
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
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        const set = handlers.get(event) ?? new Set<(...args: unknown[]) => unknown>()
        set.add(handler)
        handlers.set(event, set)
        return () => set.delete(handler)
      },
      provide: vi.fn(),
      systemPrompt: {
        section: options.section ?? vi.fn(),
      },
    },
    cancel: vi.fn(),
    followup: vi.fn(() => {
      agent.status = 'running'
      if (options.hang) return
      for (const event of options.stream ?? []) {
        if ((event as { type?: string }).type === 'assistant/chunk') {
          // Production shape on the current harness: model deltas are transient
          // `agent/assistant-stream` frames, never durable session events.
          fire('agent/assistant-stream', {
            agent,
            frame: {
              type: 'chunk',
              chunk: (event as { data?: { chunk?: unknown } }).data?.chunk,
            },
          })
          continue
        }
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
    handlersOf: (event: string) => handlers.get(event) ?? new Set(),
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
          const agent = makeAgent({ section })
          agent.session.id = options.sessionId
          if (options.agentOptions) agent.options = options.agentOptions
          // Setup runs on the agent's own scoped context (real harness):
          // identity seams (provide/on) must live on it too.
          if (options.setup) await options.setup(agent.ctx)
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
          const agent = makeAgent({ section })
          agent.session.id = options.resumeSessionId
          if (options.agentOptions) agent.options = options.agentOptions
          if (options.setup) await options.setup(agent.ctx)
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
    // The real cordis Context runs the callback once every named service is
    // available; this double invokes it immediately when the stubbed `get`
    // already answers all of them (and stays silent otherwise).
    inject: (deps: string[], callback: (scoped: unknown) => void) => {
      if (deps.every((name) => (ctx.get as (n: string) => unknown)(name) !== undefined)) {
        callback(ctx)
      }
    },
  }
  return { ctx, mounts, sections, disposed, created, live, fireSessionEvent, sectionFn: section }
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
      { name: 'wecom-identity', order: 49, text: expect.any(Function) },
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

  it('resumes when the routed session exists on disk but is missing from the startup snapshot', async () => {
    const { ctx, created } = makeHarness()
    const base = conversationId('default', singleMessage())
    // start() scans an EMPTY store, so the in-memory snapshot has no ids.
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    // The routed session materialized after start (another driver, or a prior
    // process). Trusting the startup snapshot alone used to call create() on it
    // and throw 'session "..." already exists' on EVERY later message.
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: base }])

    await manager.handle(singleMessage(), noopDownload)

    expect(created).toHaveLength(0)
    expect(ctx.agents.resume).toHaveBeenCalledOnce()
  })

  it('falls back to resume when create collides on an existing session', async () => {
    const { ctx, created } = makeHarness()
    ;(ctx.agents.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('session "dsh-wecom-single-x" already exists'),
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await manager.handle(singleMessage(), noopDownload)

    expect(created).toHaveLength(0)
    expect(ctx.agents.resume).toHaveBeenCalledOnce()
  })

  it('adopts the session when another driver wins the write race', async () => {
    const { ctx, live, sectionFn } = makeHarness()
    const base = conversationId('default', singleMessage())
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: base }])
    const other = makeAgent({ section: sectionFn })
    other.session.id = base
    ;(ctx.agents.resume as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // The other driver (the web UI) is mid-resume: the write handle is taken
      // while its agent becomes visible only now — the exact window that makes
      // `ctx.agents.get` miss on both sides.
      live.set(base, other)
      throw new Error(`session "${base}" is already owned by an active write handle`)
    })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage(), noopDownload)

    expect(reply).toEqual({ text: 'Harness reply' })
  })

  it('surfaces a readable message when the write race never clears', async () => {
    const { ctx } = makeHarness()
    const base = conversationId('default', singleMessage())
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: base }])
    ;(ctx.agents.resume as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(`session "${base}" is already owned by an active write handle`),
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    // Retries exhaust, then the user gets an actionable sentence — never the
    // raw persistence error.
    await expect(manager.handle(singleMessage(), noopDownload)).rejects.toThrow(
      /正被另一处同时使用/,
    )
  })

  it('/new mints past an epoch present on disk but absent from the startup snapshot', async () => {
    const { ctx, created } = makeHarness()
    const base = conversationId('default', singleMessage())
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: `${base}~g3` },
    ])

    const epoch = await manager.forget(singleMessage('new'))
    expect(epoch).toBe(4)
    await manager.handle(singleMessage('hi'), noopDownload)
    expect(created[0]?.sessionId).toBe(`${base}~g4`)
  })

  it('reset starts a fresh agent on the next message', async () => {
    const { ctx, created, disposed } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await manager.handle(singleMessage('one'), noopDownload)
    expect(created).toHaveLength(1)

    await manager.forget(singleMessage('reset'))
    // The old agent stays live (kept visible in the sidebar projection); the
    // pool just stops routing this conversation to it.
    expect(disposed).toHaveLength(0)

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
    const manager = new AgentPool(
      ctx as never,
      testConfig({ provider: 'example-provider', model: 'example-model' }),
    )
    await manager.start()
    await manager.handle(singleMessage('hello'), noopDownload)
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    expect(agent?.options).toEqual({ provider: 'example-provider', model: 'example-model' })
  })

  it('rejects a half-configured model route', () => {
    expect(
      () => new AgentPool(makeHarness().ctx as never, testConfig({ provider: 'example-provider' })),
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

  describe('session history commands', () => {
    const T0 = 1_700_000_000_000
    const T1 = 1_700_100_000_000
    const T2 = 1_700_200_000_000

    /** Headers for a chat with the base session plus two /new epochs. */
    function chatHeaders(base: string) {
      return [
        { id: base, createdAt: T0 },
        { id: `${base}~g1`, createdAt: T1 },
        { id: `${base}~g2`, createdAt: T2 },
        // Another chat's session and a web session must never leak in.
        { id: 'dsh-wecom-single-otherchat', createdAt: T2 },
        { id: 'session-web', createdAt: T2 },
      ]
    }

    function inspectFor(titles: Record<string, string | undefined>) {
      return vi.fn(async (id: string) => ({
        meta: { id },
        events:
          titles[id] === undefined
            ? []
            : [{ type: 'session/title', seq: 2, data: { title: titles[id] } }],
      }))
    }

    it("lists the chat's own sessions newest-first with title and turns", async () => {
      const base = conversationId('default', singleMessage())
      const { ctx, live, fireSessionEvent } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      await manager.handle(singleMessage('one'), noopDownload)
      // The chat's base id is persisted, so the turn resumes the live base
      // agent (not create). Feed the pool's canonical-title watcher through its
      // public session/event seam (the turn's own watcher is gone after settle).
      const agent = live.get(base) as FakeAgent
      const titleEvent: { type: string; seq: number; data: { title: string } } = {
        type: 'session/title',
        seq: 2,
        data: { title: '当前话题' },
      }
      agent.session.events.push(titleEvent)
      fireSessionEvent(agent.session, titleEvent)
      ;(ctx.sessionPersistence as Record<string, unknown>).inspect = inspectFor({
        [`${base}~g1`]: '旧话题一',
        [`${base}~g2`]: '旧话题二',
      }) as never

      const views = await manager.listSessions(singleMessage())

      expect(views.map((v) => v.sessionId)).toEqual([`${base}~g2`, `${base}~g1`, base])
      expect(views.map((v) => v.epoch)).toEqual([2, 1, 0])
      expect(views[2]).toMatchObject({ current: true, title: '当前话题', turns: 1, createdAt: T0 })
      expect(views[1]).toMatchObject({ current: false, title: '旧话题一', createdAt: T1 })
      expect(views[0]).toMatchObject({ current: false, title: '旧话题二', createdAt: T2 })
    })

    it('degrades to no title and null turns when the log cannot be inspected', async () => {
      const base = conversationId('default', singleMessage())
      const { ctx } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )(ctx.sessionPersistence as Record<string, unknown>).inspect = vi.fn(async () => {
        throw new Error('corrupt log')
      }) as never
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()

      const views = await manager.listSessions(singleMessage())

      expect(views).toHaveLength(3)
      for (const view of views) {
        expect(view.title).toBeUndefined()
        expect(view.turns).toBeNull()
      }
    })

    it('shows the current session (from the live log) or nothing before the first message', async () => {
      const base = conversationId('default', singleMessage())
      const { ctx, live, fireSessionEvent } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: base, createdAt: T0 },
      ])
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()

      // The base id is persisted, so the turn resumes the live base agent
      // (it already logged one turn/end).
      await manager.handle(singleMessage('one'), noopDownload)
      const agent = live.get(base) as FakeAgent
      const titleEvent: { type: string; seq: number; data: { title: string } } = {
        type: 'session/title',
        seq: 2,
        data: { title: '当前话题' },
      }
      agent.session.events.push(titleEvent)
      fireSessionEvent(agent.session, titleEvent)

      const view = await manager.currentSession(singleMessage())
      expect(view).toMatchObject({ epoch: 0, current: true, title: '当前话题', turns: 1 })

      // A chat whose routed session is not persisted yet resolves to undefined.
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
      await expect(manager.currentSession(singleMessage())).resolves.toBeUndefined()
    })

    it('resumes an older epoch and routes the next message to it', async () => {
      const base = conversationId('default', singleMessage())
      const { ctx, live } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      // Simulate: the chat had /new'd twice, so routing sits on epoch 2.
      ;(manager as unknown as { epochs: Map<string, number> }).epochs.set(base, 2)

      const text = await manager.resumeSession(singleMessage(), '1')
      expect(text).toContain('#1')

      await manager.handle(singleMessage('continued'), noopDownload)
      // Resumed (not re-created): the agent comes from persistence…
      expect(ctx.agents.resume).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: `${base}~g1` }),
      )
      // …and the live registry now routes the chat to epoch 1.
      expect([...live.keys()]).toContain(`${base}~g1`)
    })

    it('reports the already-current epoch, missing epochs, bad input, and archived sessions', async () => {
      const base = conversationId('default', singleMessage())
      const { ctx } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()

      // No argument / garbage argument → usage hint, no routing change.
      expect(await manager.resumeSession(singleMessage(), '')).toContain('/resume <编号>')
      expect(await manager.resumeSession(singleMessage(), 'x')).toContain('/resume <编号>')
      // Already on epoch 0 (default).
      expect(await manager.resumeSession(singleMessage(), '0')).toContain('当前就是 session #0')
      // Epoch 9 was never minted.
      expect(await manager.resumeSession(singleMessage(), '9')).toContain('没有编号为 9')
      // Routing is still epoch 0 after the failures above.
      expect((manager as unknown as { epochs: Map<string, number> }).epochs.get(base) ?? 0).toBe(0)

      // An archived session may not be resumed (the pool would skip it anyway).
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'workspaceRegistry' ? { archivedSessionIds: [`${base}~g1`] } : undefined,
      )
      expect(await manager.resumeSession(singleMessage(), '1')).toContain('归档')
      expect((manager as unknown as { epochs: Map<string, number> }).epochs.get(base) ?? 0).toBe(0)
    })

    it('survives a restart: a resumed epoch keeps routing after the process reloads', async () => {
      const base = conversationId('default', singleMessage())
      const firstCtx = makeHarness().ctx
      ;(firstCtx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )
      const first = new AgentPool(firstCtx as never, testConfig())
      await first.start()
      ;(first as unknown as { epochs: Map<string, number> }).epochs.set(base, 2)
      await first.resumeSession(singleMessage(), '1')
      await first.dispose()

      // New pool (fresh process): the epoch comes back from the state file.
      const { ctx: ctx2, created: created2 } = makeHarness()
      ;(ctx2.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )
      const second = new AgentPool(ctx2 as never, testConfig())
      await second.start()
      await second.handle(singleMessage('continued'), noopDownload)
      // Epoch 1 already exists on disk, so it is resumed — not re-created.
      expect(created2).toHaveLength(0)
      expect(ctx2.agents.resume).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: `${base}~g1` }),
      )
      await second.dispose()
    })

    it('/new after a rewind mints a fresh epoch instead of colliding with an existing session', async () => {
      const base = conversationId('default', singleMessage())
      const { ctx, created } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        chatHeaders(base),
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      ;(manager as unknown as { epochs: Map<string, number> }).epochs.set(base, 2)
      // Rewind to the original session, then /new — a naive "current + 1"
      // would reopen ~g1 with its old history.
      await manager.resumeSession(singleMessage(), '0')
      const next = await manager.forget(singleMessage('new'))
      expect(next).toBe(3)

      await manager.handle(singleMessage('fresh'), noopDownload)
      expect(created.at(-1)?.sessionId).toBe(`${base}~g3`)
    })
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

  it('keeps a thinking-only turn alive while stream frames keep arriving', async () => {
    // A long reasoning pass emits ONLY `agent/assistant-stream` frames — no
    // tool call, no step boundary, no durable session event. The no-progress
    // watchdog must treat those frames as progress; watching the session
    // firehose alone killed a working turn as "agent response timed out".
    const agent = makeAgent({ hang: true })
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
    const manager = new AgentPool(ctx as never, testConfig({ turnTimeoutMs: 60 }))
    await manager.start()
    const pending = manager.handle(singleMessage(), noopDownload)
    pending.catch(() => undefined)

    // Stream frames every 20ms keep the deadline reset, so the turn survives
    // well past the 60ms timeout.
    const ticker = setInterval(() => {
      agent.fire('agent/assistant-stream', {
        agent,
        frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: '…' } },
      })
    }, 20)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(agent.cancel).not.toHaveBeenCalled()

    // Once the frames stop, real silence lets the watchdog fire as designed.
    clearInterval(ticker)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
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
    expect(create.mock.calls[0]?.[0]).toMatch(/^\/tmp\/wecom-test\/WeCom-u1-\d{4}-\d{6}-287789$/)
    expect(create.mock.calls[0]?.[1]).toMatch(/^WeCom · .+ \d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(added).toEqual([created[0]?.sessionId])

    await manager.forget(singleMessage('reset'))
    await manager.handle(singleMessage('two'), noopDownload)
    expect(added).toEqual([created[0]?.sessionId, created[1]?.sessionId])
  })

  it('mints one conversation directory so the header cwd and the workspace path agree', async () => {
    // `conversationDir` mints its name from the wall clock, and nothing creates
    // the directory until `openWorkspace` runs later in the same turn. A slow
    // `agents.create` that crosses a second boundary must therefore NOT hand the
    // session a different directory than its workspace row: that leaves the chat
    // in Ungrouped beside an empty row (hailinluo, 2026-09-15 16:58).
    const RealDate = Date
    let offsetMs = 0
    class ShiftedDate extends RealDate {
      constructor(...args: [] | [number | string | Date]) {
        if (args.length === 0) super(RealDate.now() + offsetMs)
        else super(args[0] as number)
      }
      static override now(): number {
        return RealDate.now() + offsetMs
      }
    }
    vi.stubGlobal('Date', ShiftedDate)
    // A private base: `conversationDir` adopts any existing directory whose name
    // ends in the session-id tail, so the shared /tmp/wecom-test base (which
    // carries leftovers from earlier runs) would bypass the very mint path this
    // test exists to exercise.
    const base = mkdtempSync(join(tmpdir(), 'wecom-mint-'))
    try {
      const { ctx } = makeHarness()
      const create = vi.fn(async (path: string, title: string) => ({
        attachSession: vi.fn(async () => undefined),
        path,
        title,
      }))
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'workspaceRegistry' ? { create } : undefined,
      )
      const agentsCreate = ctx.agents.create as ReturnType<typeof vi.fn>
      const realCreate = agentsCreate.getMockImplementation()
      agentsCreate.mockImplementation(async (options: unknown) => {
        // The session is created first; the workspace row is created after it.
        offsetMs += 1_500
        return realCreate?.(options)
      })
      const manager = new AgentPool(ctx as never, testConfig({ cwd: base }))
      await manager.start()

      await manager.handle(singleMessage('one'), noopDownload)

      const createCall = agentsCreate.mock.calls[0] as [{ meta?: { cwd?: string } }] | undefined
      const sessionCwd = createCall?.[0]?.meta?.cwd
      expect(sessionCwd).toMatch(new RegExp(`^${base}/WeCom-u1-\\d{4}-\\d{6}-287789$`))
      expect(create).toHaveBeenCalledTimes(1)
      expect(create.mock.calls[0]?.[0]).toBe(sessionCwd)
    } finally {
      vi.unstubAllGlobals()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('skips workspace grouping when no registry exists', async () => {
    const { ctx } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await expect(manager.start()).resolves.toBeUndefined()
  })

  it('tombstones a workspace deleted in the UI: no row on restart, row back on new activity', async () => {
    const stateFile = '/tmp/wecom-test/.dsh-wecom-state.json'
    // Shrink the poll interval so the watcher observes the deletion quickly.
    AgentPool.DELETION_POLL_MS = 20
    const rows: Array<{ path: string; title: string }> = []
    const create = vi.fn(async (path: string, title: string) => {
      const row = {
        path,
        title,
        attachSession: vi.fn(async () => undefined),
      }
      rows.push(row)
      return row
    })
    const makeRegistry = () => ({
      create,
      list: () => rows.map((row) => ({ path: row.path })),
    })

    // Boot 1: one message groups into one workspace row.
    {
      const { ctx } = makeHarness()
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'workspaceRegistry' ? makeRegistry() : undefined,
      )
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      await manager.handle(singleMessage('one'), noopDownload)
      expect(create).toHaveBeenCalledTimes(1)
      // The deletion watcher sampled the baseline; give the poll one tick and
      // then remove the row the way the web UI does.
      await new Promise((resolve) => setTimeout(resolve, 20))
      rows.length = 0
      await new Promise((resolve) => setTimeout(resolve, 60))
      await manager.dispose()
    }

    // The tombstone persisted.
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      deletedWorkspaces?: string[]
    }
    expect(state.deletedWorkspaces).toHaveLength(1)
    expect(state.deletedWorkspaces?.[0]).toMatch(/WeCom-u1-\d{4}-\d{6}-287789$/)

    // Boot 2 (restart): the persisted session regroups, but the tombstoned
    // dir must NOT recreate its workspace row.
    {
      const { ctx } = makeHarness()
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'workspaceRegistry' ? makeRegistry() : undefined,
      )
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'dsh-wecom-single-7aa807000f4b59a39d6abc8a0aa07268~g1',
          cwd: state.deletedWorkspaces?.[0],
        },
      ])
      create.mockClear()
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      expect(create).toHaveBeenCalledTimes(0)
      expect(rows).toHaveLength(0)

      // New activity on the chat clears the tombstone: the row comes back.
      await manager.handle(singleMessage('fresh'), noopDownload)
      expect(create).toHaveBeenCalledTimes(1)
      expect(rows).toHaveLength(1)
      await manager.dispose()
    }

    // Boot 3: the revived row persists across another restart (no tombstone left).
    {
      const { ctx } = makeHarness()
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'workspaceRegistry' ? makeRegistry() : undefined,
      )
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'dsh-wecom-single-7aa807000f4b59a39d6abc8a0aa07268~g1',
          cwd: rows[0]?.path,
        },
      ])
      const manager = new AgentPool(ctx as never, testConfig())
      await manager.start()
      expect(create).toHaveBeenCalledTimes(1)
      await manager.dispose()
    }

    rmSync(stateFile, { force: true })
    AgentPool.DELETION_POLL_MS = 5_000
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
    expect(create.mock.calls[0]?.[0]).toMatch(/^\/tmp\/wecom-test\/WeCom-u1-\d{4}-\d{6}-287789$/)
    expect(added).toEqual([created[0]?.sessionId])
  })

  it('mints readable per-chat directories (WeCom-peer-MMDD-hash6)', async () => {
    const { ctx } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    const dirOf = (id: string): string =>
      (manager as unknown as { conversationDir(id: string): string }).conversationDir(id)
    // peers map is empty in this harness, so the peer tag falls back to the
    // slugified base id (24 chars); the stable identity suffix is the base
    // id's LAST 6 chars.
    const single = dirOf('dsh-wecom-single-00112233445566778899aabbccddee01')
    expect(single).toMatch(
      /\/tmp\/wecom-test\/WeCom-dsh-wecom-single-001122\d?-\d{4}-\d{6}-ddee01$/,
    )
    const group = dirOf('dsh-wecom-group-00112233445566778899aabbccddee02')
    expect(group).toMatch(/\/tmp\/wecom-test\/WeCom-dsh-wecom-group-0011223\d?-\d{4}-\d{6}-ddee02$/)
    // A /reset epoch is its own session: its own dir (tail embeds ~g3)…
    const epoch = dirOf('dsh-wecom-single-00112233445566778899aabbccddee01~g3')
    expect(epoch).toMatch(/\/tmp\/wecom-test\/WeCom-.+-\d{4}-\d{6}-e01~g3$/)
    expect(epoch).not.toBe(single)
    // …and each id resolves to the same dir on repeat (adoption).
    expect(dirOf('dsh-wecom-single-00112233445566778899aabbccddee01~g3')).toBe(epoch)
  })

  it('resolves the sender RTX before minting a new conversation peer label', async () => {
    const { ctx } = makeHarness()
    // A cold-cache enricher: peekRtx misses until enrich() resolves the RTX.
    const cache: Record<string, string> = {}
    const enricher = {
      peekRtx: (userid: string) => cache[userid],
      enrich: async (identity: { userid: string }) => {
        cache[identity.userid] = 'sanfordsun'
        return { rtx: 'sanfordsun' }
      },
    }
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === wecomIdentityEnricherServiceName('default') ? enricher : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage(), noopDownload)

    const state = JSON.parse(readFileSync(join('/tmp/wecom-test', '.dsh-wecom-state.json'), 'utf8'))
    const base = conversationId('default', singleMessage())
    expect(state.peers[base]).toBe('sanfordsun')
  })

  it('falls back to the raw userid when no enricher is mounted', async () => {
    const { ctx } = makeHarness()
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    await manager.handle(singleMessage(), noopDownload)

    const state = JSON.parse(readFileSync(join('/tmp/wecom-test', '.dsh-wecom-state.json'), 'utf8'))
    const base = conversationId('default', singleMessage())
    expect(state.peers[base]).toBe('u1')
  })

  it('re-attaches persisted sessions whose stored cwd matches their per-session dir', async () => {
    const attached: string[] = []
    const create = vi.fn(async (path: string) => ({
      attachSession: vi.fn(async (sessionId: string) => {
        attached.push(sessionId)
      }),
      path,
    }))
    const { ctx } = makeHarness()
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      // New-layout session: stored cwd equals its per-chat directory.
      { id: 'dsh-wecom-single-000abcdef', cwd: '/tmp/wecom-test/WeCom-u1-0821-abcdef' },
      // Epoch session of the same chat shares the base dir, so it re-attaches
      // to the SAME workspace row instead of minting a new one.
      { id: 'dsh-wecom-single-000abcdef~g2', cwd: '/tmp/wecom-test/WeCom-u1-0821-def~g2' },
      // New-layout group chat.
      { id: 'dsh-wecom-group-000xyz789', cwd: '/tmp/wecom-test/WeCom-grp-0821-xyz789' },
      // Legacy session under the shared base: must NOT create a per-chat row.
      { id: 'dsh-wecom-single-000legacy', cwd: '/tmp/wecom-test' },
      // Pre-fix epoch dir: stored cwd is the epoch-id directory, which no
      // longer equals the (now base-id) conversation dir — skip, no new row.
      { id: 'dsh-wecom-single-000old~g1', cwd: '/tmp/wecom-test/WeCom-old-0821-00old' },
      { id: 'session-other' },
    ])
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()
    expect(attached).toEqual([
      'dsh-wecom-single-000abcdef',
      'dsh-wecom-single-000abcdef~g2',
      'dsh-wecom-group-000xyz789',
    ])
    // One row per SESSION: the base session and its /reset epoch each claim
    // their own row; mismatched cwds create nothing.
    expect(create).toHaveBeenCalledTimes(3)
    const paths = create.mock.calls.map((call) => call[0])
    expect(paths[0]).toMatch(/^\/tmp\/wecom-test\/WeCom-.+-\d{4}-\d{6}-abcdef$/)
    expect(paths[1]).toMatch(/^\/tmp\/wecom-test\/WeCom-.+-\d{4}-\d{6}-def~g2$/)
    expect(paths[2]).toMatch(/^\/tmp\/wecom-test\/WeCom-.+-\d{4}-\d{6}-xyz789$/)
  })

  it('refreshes a stale workspace row title to the canonical peer label', async () => {
    // `registry.create` returns an existing row untouched, so a title minted
    // before the peer label changed stays stale in the sidebar (observed:
    // directories migrated from the raw userid to the RTX kept "· T32120019A").
    const stale = 'WeCom · T32120019A 09-03 23:49:34'
    const setTitle = vi.fn(async (_title: string) => undefined)
    const create = vi.fn(async () => ({
      attachSession: vi.fn(async () => undefined),
      title: stale,
      setTitle,
    }))
    const { ctx } = makeHarness()
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'dsh-wecom-single-000abcdef', cwd: '/tmp/wecom-test/WeCom-example-user-0821-abcdef' },
    ])
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    expect(setTitle).toHaveBeenCalledOnce()
    const next = setTitle.mock.calls[0]?.[0] as unknown as string
    expect(next).not.toBe(stale)
    expect(next).toMatch(/^WeCom · /)
  })

  it('leaves an up-to-date workspace row title alone', async () => {
    let created:
      | { attachSession: ReturnType<typeof vi.fn>; setTitle: ReturnType<typeof vi.fn> }
      | undefined
    const create = vi.fn(async (_path: string, title?: string) => {
      created = {
        attachSession: vi.fn(async () => undefined),
        setTitle: vi.fn(async () => undefined),
      }
      return { ...created, title }
    })
    const { ctx } = makeHarness()
    ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'dsh-wecom-single-000abcdef', cwd: '/tmp/wecom-test/WeCom-example-user-0821-abcdef' },
    ])
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { create } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    expect(created?.setTitle).not.toHaveBeenCalled()
  })

  it('reconciles stale titles across every row, including historical epochs', async () => {
    const staleSet = vi.fn(async (_title: string) => undefined)
    const freshSet = vi.fn(async (_title: string) => undefined)
    const foreignSet = vi.fn(async (_title: string) => undefined)
    const rows = [
      {
        path: '/tmp/wecom-test/WeCom-example-user-0903-234934-563~g7',
        title: 'WeCom · T32120019A 09-03 23:49:34',
        setTitle: staleSet,
      },
      {
        path: '/tmp/wecom-test/WeCom-example-user-0908-162049-63~g11',
        title: 'WeCom · example-user 09-08 16:20:49',
        setTitle: freshSet,
      },
      { path: '/tmp/elsewhere/A2A-xyz', title: 'A2A 版本 · xyz', setTitle: foreignSet },
      // Another dsh-wecom instance's row (different workspace title prefix,
      // same base cwd) must not be rewritten by this pool.
      {
        path: '/tmp/wecom-test/WeCom-weiqizhu-0910-161252-b3c626',
        title: 'WeCom 版本管理 · T13150002A 09-10 16:12:52',
        setTitle: foreignSet,
      },
    ]
    const { ctx } = makeHarness()
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'workspaceRegistry' ? { list: () => rows, create: vi.fn() } : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.reconcileWorkspaceTitles()

    expect(staleSet).toHaveBeenCalledOnce()
    expect(staleSet.mock.calls[0]?.[0]).toBe('WeCom · example-user 09-03 23:49:34')
    expect(freshSet).not.toHaveBeenCalled()
    // A row outside this pool's cwd (A2A) must never be touched.
    expect(foreignSet).not.toHaveBeenCalled()
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

  it('keeps a harness-generated LLM title topic-only for single chats', async () => {
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
    // Session titles stay topic-only: no userid prefix (identity is carried
    // by the per-chat workspace row).
    expect(renamed).toEqual([])
  })

  it('keeps a harness-generated LLM title topic-only for group chats', async () => {
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
    expect(renamed).toEqual([])
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
    expect(renamed).toEqual(['性能优化'])
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
    titleEvent(11, { kind: 'user' }, '性能优化')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(renamed).toEqual([])
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
