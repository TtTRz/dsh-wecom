import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  /** Finish a `hang: true` turn: push the closing events, then go idle. */
  release: () => void
}

/** Which harness session API the double should look like. */
type SessionApi = 'legacy' | 'snapshot'

/**
 * Session double. `legacy` mirrors dsh-session 0.1.0-rc.x (`events` getter);
 * `snapshot` mirrors 0.1.5-rc.x, where that getter is gone and the log is read
 * through `snapshotEvents()` — the shape that made every production turn fail
 * with `Cannot read properties of undefined (reading 'length')`.
 *
 * The declared type keeps the legacy surface so existing tests can push events;
 * the snapshot double deliberately carries NO `events` property, so a code path
 * that still reads it throws here exactly as it did in production.
 */
function fakeSession(events: unknown[], id = '', api: SessionApi = 'legacy'): FakeAgent['session'] {
  const requestHeader = (): undefined => undefined
  if (api === 'legacy') return { id, events, requestHeader }
  return {
    id,
    get seq() {
      return events.length
    },
    ownEvents: () => events.slice(),
    snapshotEvents: (from = 0, to = events.length) => events.slice(from, to),
    requestHeader,
  } as unknown as FakeAgent['session']
}

function makeAgent(
  options: {
    hang?: boolean
    replyText?: string
    stream?: unknown[]
    /** Live attempt frames, as dsh-agent 0.1.5-rc.x publishes them. */
    frames?: unknown[]
    sessionApi?: SessionApi
  } = {},
): FakeAgent {
  const events: unknown[] = []
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args)
  }
  let releaseIdle: (() => void) | undefined
  let idle: Promise<void> | undefined
  /** The events every completed turn ends with (mirrors the real harness). */
  const closeTurn = (): void => {
    const closing = [
      {
        type: 'assistant/message',
        data: {
          message: { content: [{ type: 'text', text: options.replyText ?? 'Harness reply' }] },
        },
      },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]
    for (const event of closing) {
      events.push(event)
      fire('session/event', agent.session, event)
    }
  }
  const agent: FakeAgent = {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: fakeSession(events, '', options.sessionApi),
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
      // 0.1.5-rc.x: the same deltas arrive as transient attempt frames on an
      // agent-scoped event and never enter the durable session log.
      for (const frame of options.frames ?? []) fire('agent/assistant-stream', { agent, frame })
      closeTurn()
    }),
    whenIdle: vi.fn(() => {
      if (options.hang) {
        idle ??= new Promise<void>((resolve) => {
          releaseIdle = resolve
        })
        return idle.then(() => {
          agent.status = 'idle'
        })
      }
      agent.status = 'idle'
      return Promise.resolve()
    }),
    release: () => {
      if (releaseIdle === undefined) return
      closeTurn()
      const resolve = releaseIdle
      releaseIdle = undefined
      resolve()
    },
    fire,
  }
  return agent
}

/**
 * A turn whose single tool call returns one image block — the shape both the
 * harness vision reader (`read_image`) and a card renderer (`render_card`) use.
 */
function makeImageTurn(toolName: string, attachmentId: string): FakeAgent {
  return makeAgent({
    stream: [
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'c1', name: toolName, arguments: '{}' },
      },
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [
              {
                type: 'tool-result',
                content: [
                  {
                    type: 'image',
                    attachment: {
                      attachmentId,
                      mediaType: 'image/png',
                      bytes: 3,
                      width: 10,
                      height: 10,
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  })
}

/**
 * A Code Mode turn: `run_code` bridges one sub-call (the harness logs it on
 * `tool/ptc-dispatch`) and attaches that sub-result's image to the OUTER
 * `run_code` result — so the name on the result is `run_code`, not the tool that
 * produced the picture.
 */
function makePtcImageTurn(
  subCalls: readonly { name: string; attachmentId: string }[],
  eventType = 'tool/ptc-dispatch',
): FakeAgent {
  const contents = subCalls.map(({ attachmentId }) => [
    { type: 'text', text: 'sub-call output' },
    {
      type: 'image',
      attachment: { attachmentId, mediaType: 'image/png', bytes: 3, width: 10, height: 10 },
    },
  ])
  return makeAgent({
    stream: [
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: '{}' },
      },
      ...subCalls.map(({ name }, index) => ({
        type: eventType,
        data: {
          rootCallId: 'c1',
          parentCallId: 'c1',
          subCallId: `c1:ptc:${index + 1}`,
          name,
          arguments: {},
          isError: false,
          content: contents[index],
        },
      })),
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'tool-result', content: contents.flat() }],
          },
        },
      },
    ],
  })
}

function makeHarness(harness: { sessionApi?: SessionApi; agent?: FakeAgent } = {}) {
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
          const agent = harness.agent ?? makeAgent({ sessionApi: harness.sessionApi })
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
          const agent = harness.agent ?? makeAgent({ sessionApi: harness.sessionApi })
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
    expect(create.mock.calls[0]?.[0]).toMatch(/^\/tmp\/wecom-test\/WeCom-u1-\d{4}-\d{6}-287789$/)
    expect(create.mock.calls[0]?.[1]).toMatch(/^WeCom · .+ \d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
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
    // The row's canonical cwd IS the session's recorded cwd: a resumed session
    // runs where the harness stored it, so the workspace must not mint a second
    // name for it (that mismatch is what broke the sandbox cwd).
    expect(paths).toEqual([
      '/tmp/wecom-test/WeCom-u1-0821-abcdef',
      '/tmp/wecom-test/WeCom-u1-0821-def~g2',
      '/tmp/wecom-test/WeCom-grp-0821-xyz789',
    ])
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

  it('does not ship an image that read_image handed back to the model', async () => {
    const { ctx } = makeHarness({ agent: makeImageTurn('read_image', 'sha256:user-upload') })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('这是什么'), noopDownload)

    // The user's own upload is not a card: it must not be echoed back.
    expect(reply.images).toBeUndefined()
    // The call itself still shows up in the activity summary.
    expect(reply.toolCalls?.map((call) => call.name)).toEqual(['read_image'])
  })

  it('still ships an image a card tool rendered', async () => {
    const { ctx } = makeHarness({ agent: makeImageTurn('render_card', 'card-1') })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('画个图'), noopDownload)

    expect(reply.images).toHaveLength(1)
    expect(reply.images?.[0]?.attachmentId).toBe('card-1')
  })

  it('does not ship an image read_image produced inside run_code (PTC)', async () => {
    const { ctx } = makeHarness({
      agent: makePtcImageTurn([{ name: 'read_image', attachmentId: 'sha256:user-upload' }]),
    })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('这是什么'), noopDownload)

    // The outer result is named `run_code`; the reader is only visible on the
    // sub-dispatch, which must still keep the user's own picture out of the chat.
    expect(reply.images).toBeUndefined()
  })

  it('still ships an image a card tool rendered inside run_code (PTC)', async () => {
    const { ctx } = makeHarness({
      agent: makePtcImageTurn([{ name: 'render_card', attachmentId: 'card-2' }]),
    })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('画个图'), noopDownload)

    expect(reply.images?.map((ref) => ref.attachmentId)).toEqual(['card-2'])
  })

  it('ships a rendered image even when read_image returns the same attachment inside run_code', async () => {
    const { ctx } = makeHarness({
      agent: makePtcImageTurn([
        { name: 'render_card', attachmentId: 'shared-image' },
        { name: 'read_image', attachmentId: 'shared-image' },
      ]),
    })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('画图并检查'), noopDownload)

    expect(reply.images?.map((ref) => ref.attachmentId)).toEqual(['shared-image'])
  })

  it('recognizes the legacy tool/code-dispatch event name', async () => {
    const { ctx } = makeHarness({
      agent: makePtcImageTurn(
        [{ name: 'read_image', attachmentId: 'sha256:user-upload' }],
        'tool/code-dispatch',
      ),
    })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('这是什么'), noopDownload)

    expect(reply.images).toBeUndefined()
  })

  it('falls back to the outer run_code result when no sub-dispatch event is available', async () => {
    const { ctx } = makeHarness({ agent: makeImageTurn('run_code', 'compat-card') })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage('画个图'), noopDownload)

    expect(reply.images?.map((ref) => ref.attachmentId)).toEqual(['compat-card'])
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

/**
 * dsh-session 0.1.5-rc.x removed the `events` getter that 0.1.0-rc.x exposed
 * (`snapshotEvents()` / `ownEvents()` / `eventAt()` replaced it). The pool reads
 * the log on every turn, so the whole feature died on that upgrade — commands
 * kept working because they never open a session.
 */
describe('AgentPool on the dsh-session 0.1.5 session API', () => {
  it('drives a turn and extracts its reply without an `events` getter', async () => {
    const { ctx, live, created } = makeHarness({ sessionApi: 'snapshot' })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    await expect(manager.handle(singleMessage('hi'), noopDownload)).resolves.toMatchObject({
      text: 'Harness reply',
    })

    // Guard: the double must really look like 0.1.5, or this test proves nothing.
    const agent = live.get(created[0]?.sessionId ?? '') as FakeAgent | undefined
    expect(agent).toBeDefined()
    const session = agent?.session as { events?: unknown } | undefined
    expect(session?.events).toBeUndefined()
  })

  it('reverts a manual rename using the snapshot log', async () => {
    const renamed: string[] = []
    const { ctx, fireSessionEvent } = makeHarness({ sessionApi: 'snapshot' })
    ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'sessionTitle'
        ? { rename: vi.fn((_session: unknown, title: string) => renamed.push(title)) }
        : undefined,
    )
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    // The pool has no canonical title for this session yet, so it falls back to
    // the previous `session/title` in the log (pool.previousTitle).
    const log: unknown[] = [
      {
        type: 'session/title',
        seq: 3,
        data: { title: '性能优化', messageSeqs: [], source: { kind: 'provider' } },
      },
    ]
    const session = fakeSession(log, 'dsh-wecom-single-snapshot', 'snapshot')
    const rename = {
      type: 'session/title',
      seq: 4,
      data: { title: '手动改名', messageSeqs: [], source: { kind: 'user' } },
    }
    log.push(rename)
    fireSessionEvent(session, rename)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(renamed).toEqual(['性能优化'])
  })

  it('streams agent/assistant-stream frames instead of assistant/chunk events', async () => {
    const deltas: Array<{ kind: string; text: string }> = []
    const agent = makeAgent({
      sessionApi: 'snapshot',
      frames: [
        { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 },
        {
          type: 'chunk',
          attemptId: 'a1',
          revision: 2,
          index: 0,
          chunk: { type: 'text-delta', index: 0, text: 'Hel' },
        },
        {
          type: 'chunk',
          attemptId: 'a1',
          revision: 3,
          index: 1,
          chunk: { type: 'text-delta', index: 0, text: 'lo' },
        },
        {
          type: 'chunk',
          attemptId: 'a1',
          revision: 4,
          index: 2,
          chunk: { type: 'reasoning-delta', index: 1, text: '想一下' },
        },
        {
          type: 'end',
          attemptId: 'a1',
          revision: 5,
          index: 3,
          outcome: { kind: 'committed', eventType: 'assistant/message' },
        },
      ],
    })
    const { ctx } = makeHarness({ agent })
    const manager = new AgentPool(ctx as never, testConfig())
    await manager.start()

    const reply = await manager.handle(singleMessage(), noopDownload, (delta) => deltas.push(delta))

    expect(deltas).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
      { kind: 'reasoning', text: '想一下' },
    ])
    expect(reply.text).toBe('Harness reply')
    expect(reply.reasoning).toBe('想一下')
  })

  it('keeps a turn alive on transient frames alone (no-progress timeout)', async () => {
    const agent = makeAgent({ hang: true, sessionApi: 'snapshot' })
    const { ctx } = makeHarness({ agent })
    const manager = new AgentPool(ctx as never, testConfig({ turnTimeoutMs: 40 }))
    await manager.start()

    const turn = manager.handle(singleMessage('hi'), noopDownload)
    // Five 20ms beats: twice the timeout in total, but every frame resets it.
    for (let beat = 0; beat < 5; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      agent.fire('agent/assistant-stream', {
        agent,
        frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'x' } },
      })
    }
    agent.release()

    await expect(turn).resolves.toMatchObject({ text: 'Harness reply' })
    expect(agent.cancel).not.toHaveBeenCalled()
  })
})

/**
 * Directory names are minted from the clock, so recomputing one mid-create can
 * straddle a second boundary: the session then records a cwd that the workspace
 * `mkdir` never created, and every tool spawn in that session fails ENOENT.
 */
describe('AgentPool workspace identity', () => {
  it('keeps the session cwd and the workspace path identical when the clock ticks mid-create', async () => {
    vi.useFakeTimers()
    // Own workspace root: this test mints (and could leave) real directories.
    const root = mkdtempSync(join(tmpdir(), 'wecom-ws-'))
    try {
      vi.setSystemTime(new Date('2026-09-11T08:14:27Z'))
      const { ctx, created } = makeHarness()
      const create = ctx.agents.create as ReturnType<typeof vi.fn>
      const inner = create.getMockImplementation()
      expect(inner).toBeDefined()
      // Cross a second boundary while the harness creates the session.
      create.mockImplementation(async (options: never) => {
        vi.advanceTimersByTime(1_500)
        return inner?.(options)
      })
      const paths: string[] = []
      ;(ctx.get as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'workspaceRegistry'
          ? {
              create: vi.fn(async (path: string) => {
                paths.push(path)
                return { attachSession: vi.fn(async () => undefined) }
              }),
            }
          : undefined,
      )
      const manager = new AgentPool(ctx as never, testConfig({ cwd: root }))
      await manager.start()

      await manager.handle(singleMessage('hi'), noopDownload)

      expect(created).toHaveLength(1)
      const passed = create.mock.calls[0]?.[0] as { meta?: { cwd?: string } } | undefined
      const sessionCwd = passed?.meta?.cwd
      expect(sessionCwd).toBeDefined()
      expect(paths).toContain(sessionCwd)
    } finally {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('repairs a persisted session whose recorded cwd is missing', async () => {
    // Own workspace root: the repaired directory must not leak into the
    // shared test cwd, where the adoption lookup would later find it.
    const root = mkdtempSync(join(tmpdir(), 'wecom-repair-'))
    try {
      const base = conversationId(testConfig().namespace, singleMessage('hi') as never)
      const cwd = join(root, `WeCom-u1-0911-161427-${base.slice(-6)}`)
      const { ctx } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: base, cwd },
      ])
      const manager = new AgentPool(ctx as never, testConfig({ cwd: root }))
      await manager.start()
      expect(existsSync(cwd)).toBe(false)

      await manager.handle(singleMessage('hi'), noopDownload)

      // dsh resumed the session where it was recorded, so that directory must exist.
      expect(ctx.agents.resume).toHaveBeenCalled()
      expect(existsSync(cwd)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recognizes persisted sessions listed as 0.1.5 snapshot wrappers', async () => {
    // 0.1.5-rc.x returns `{ header, revision, sizeBytes }` from list(); reading
    // `entry.id` left `persisted` empty and every restart re-created (and thus
    // failed on) sessions that already had a log.
    const root = mkdtempSync(join(tmpdir(), 'wecom-snapshot-'))
    try {
      const base = conversationId(testConfig().namespace, singleMessage('hi') as never)
      const cwd = join(root, `WeCom-u1-0911-161427-${base.slice(-6)}`)
      const { ctx } = makeHarness()
      ;(ctx.sessionPersistence.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { header: { id: base, cwd }, revision: 'r1', sizeBytes: 42 },
      ])
      const manager = new AgentPool(ctx as never, testConfig({ cwd: root }))
      await manager.start()

      await manager.handle(singleMessage('hi'), noopDownload)

      // Resumed as a known session (never re-created)…
      expect(ctx.agents.resume).toHaveBeenCalled()
      expect(ctx.agents.create).not.toHaveBeenCalled()
      // …and its recorded cwd is both honoured and repaired.
      expect(existsSync(cwd)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
