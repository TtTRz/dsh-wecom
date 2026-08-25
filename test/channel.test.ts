import { describe, expect, it, vi } from 'vitest'
import { type BotClient, buildStreamContent, WecomChannel } from '../src/channel.js'
import { testConfig } from './test-config.js'

function makeClient() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const client = {
    isConnected: false,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler)
      return client
    },
    connect() {
      client.isConnected = true
      handlers.get('connected')?.()
      handlers.get('authenticated')?.()
      return client
    },
    disconnect() {
      client.isConnected = false
    },
    replyStream: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    replyWelcome: vi.fn(async () => undefined),
    uploadMedia: vi.fn(async () => ({ media_id: 'media-1', created_at: String(Date.now()) })),
    sendMediaMessage: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => ({ buffer: new Uint8Array() })),
  }
  const botClient = client as unknown as BotClient
  const fire = (event: string, ...args: unknown[]): unknown => {
    return handlers.get(event)?.(...args)
  }
  return { client: botClient, fire }
}

/** Fire one inbound text message at a running channel. */
async function sendText(
  fire: (event: string, ...args: unknown[]) => unknown,
  text: string,
  msgid = 'm1',
): Promise<unknown> {
  return fire('message', {
    headers: { req_id: `r-${msgid}` },
    body: {
      msgid,
      aibotid: 'bot',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'text',
      text: { content: text },
    },
  })
}

function makeCtx() {
  return {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    on: vi.fn(() => () => undefined),
    sessionPersistence: { list: vi.fn(async () => []) },
    credentials: { resolve: vi.fn(async () => ({ value: 'secret' })) },
    get: vi.fn(() => undefined),
  }
}

async function makeRunningChannel() {
  const { client, fire } = makeClient()
  const channel = new WecomChannel(makeCtx() as never, testConfig(), () => client)
  await channel.start()
  return { channel, client, fire }
}

describe('WecomChannel status', () => {
  it('starts disconnected with empty counters', () => {
    const { client } = makeClient()
    const channel = new WecomChannel(makeCtx() as never, testConfig(), () => client)
    expect(channel.snapshot()).toEqual({
      connected: false,
      stopping: false,
      conversations: 0,
      authenticatedAt: null,
      lastError: null,
    })
  })

  it('reflects authentication and disconnection', async () => {
    const { channel, client } = await makeRunningChannel()
    const status = channel.snapshot()
    expect(status.connected).toBe(true)
    expect(status.authenticatedAt).toBeTypeOf('number')

    client.disconnect()
    expect(channel.snapshot().connected).toBe(false)
  })

  it('records the latest error', async () => {
    const { channel, fire } = await makeRunningChannel()
    fire('error', new Error('auth failed'))
    expect(channel.snapshot().lastError).toBe('auth failed')

    fire('event.disconnected_event')
    expect(channel.snapshot().lastError).toBe(
      'Connection replaced by another client for this Bot ID',
    )
  })

  it('clears the sticky error after a successful re-authentication', async () => {
    const { channel, fire } = await makeRunningChannel()
    fire('error', new Error('write EPROTO boom'))
    expect(channel.snapshot().lastError).toBe('write EPROTO boom')

    fire('authenticated')
    const snapshot = channel.snapshot()
    expect(snapshot.lastError).toBeNull()
    expect(snapshot.connected).toBe(true)
    expect(snapshot.authenticatedAt).toBeTypeOf('number')
  })

  it('marks stopping after stop', async () => {
    const { channel } = await makeRunningChannel()
    await channel.stop()
    expect(channel.snapshot()).toMatchObject({ stopping: true, connected: false })
  })

  it('untilDead resolves when the connection is replaced by another client', async () => {
    const { channel, fire } = await makeRunningChannel()
    const dead = channel.untilDead()
    fire('event.disconnected_event')
    await expect(dead).resolves.toBeUndefined()
  })

  it('untilDead resolves when the channel stops', async () => {
    const { channel } = await makeRunningChannel()
    const dead = channel.untilDead()
    await channel.stop()
    await expect(dead).resolves.toBeUndefined()
  })

  it('reconnect drops the socket and wakes the loop without stopping', async () => {
    const { channel, client } = await makeRunningChannel()
    const dead = channel.untilDead()
    channel.reconnect()
    await expect(dead).resolves.toBeUndefined()
    expect(channel.snapshot()).toMatchObject({ stopping: false, connected: false })
    expect((client as { isConnected: boolean }).isConnected).toBe(false)
  })

  it('reconnect is a no-op after stop', async () => {
    const { channel, client } = await makeRunningChannel()
    await channel.stop()
    ;(client as { isConnected: boolean }).isConnected = true
    channel.reconnect()
    expect((client as { isConnected: boolean }).isConnected).toBe(true)
  })
})

describe('WecomChannel streaming', () => {
  function makeStreamingSetup(stream: unknown[], replyText: string) {
    const events: unknown[] = []
    const sessionHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
    const fireAgent = (event: string, ...args: unknown[]): void => {
      for (const handler of sessionHandlers.get(event) ?? []) handler(...args)
    }
    const agent = {
      status: 'idle',
      options: { provider: 'p', model: 'm' },
      session: { events },
      ctx: {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          const set = sessionHandlers.get(event) ?? new Set<(...args: unknown[]) => void>()
          set.add(handler)
          sessionHandlers.set(event, set)
          return () => set.delete(handler)
        },
      },
      cancel: () => undefined,
      followup: () => {
        agent.status = 'running'
        for (const event of stream) {
          events.push(event)
          fireAgent('session/event', agent.session, event)
        }
        events.push({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: replyText }] } },
        })
        events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      },
      whenIdle: () => {
        agent.status = 'idle'
        return Promise.resolve()
      },
    }
    const ctx = {
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
      on: vi.fn(() => () => undefined),
      sessionPersistence: { list: vi.fn(async () => []) },
      credentials: { resolve: vi.fn(async () => ({ value: 'secret' })) },
      agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'p', model: 'm' })) },
      attachments: {
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 10_000 },
        saveImage: vi.fn(),
        readImage: vi.fn(async () => ({ ref: {}, data: new Uint8Array([1, 2, 3]) })),
      },
      llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
      agentPresets: {
        resolve: vi.fn(async () => ({ id: 'standard' })),
        mount: vi.fn(async () => undefined),
      },
      agents: {
        create: vi.fn(
          async (options: { sessionId: string; setup?: (agentCtx: unknown) => Promise<void> }) => {
            if (options.setup) await options.setup({ systemPrompt: { section() {} } })
            return { agent, dispose: vi.fn(async () => undefined) }
          },
        ),
        resume: vi.fn(),
        get: vi.fn(() => agent),
      },
      get: vi.fn(() => undefined),
    }
    return ctx
  }

  async function runStreamingMessage(stream: unknown[], replyText: string): Promise<unknown[][]> {
    const { client, fire } = makeClient()
    const channel = new WecomChannel(
      makeStreamingSetup(stream, replyText) as never,
      testConfig({ streamFlushMs: 5_000 }),
      () => client,
    )
    await channel.start()
    await fire('message', {
      headers: { req_id: 'r1' },
      body: {
        msgid: 'm1',
        aibotid: 'bot',
        chattype: 'single',
        from: { userid: 'u1' },
        msgtype: 'text',
        text: { content: 'hi' },
      },
    })
    return (client as unknown as { replyStream: ReturnType<typeof vi.fn> }).replyStream.mock.calls
  }

  it('streams text deltas and tucks the tool-call list inside the think block', async () => {
    const calls = await runStreamingMessage(
      [
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
        },
        {
          type: 'tool/call',
          data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' },
        },
        {
          type: 'tool/result',
          data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' } } },
        },
      ],
      'Hello',
    )

    expect(calls).toHaveLength(3)
    expect(calls[0]?.[2]).toBe('Working…')
    expect(calls[0]?.[3]).toBe(false)
    // Intermediate frames carry only the visible answer (no tools yet).
    expect(calls[1]?.[2]).toBe('Hello')
    expect(calls[1]?.[3]).toBe(false)
    const final = calls[2]
    expect(final?.[3]).toBe(true)
    expect(String(final?.[2])).toBe('<think>工具调用:\n- read: a</think>\nHello')
  })

  it('combines reasoning and tool calls inside one think block', async () => {
    const calls = await runStreamingMessage(
      [
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
          data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        },
        {
          type: 'tool/result',
          data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' } } },
        },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hi' } },
        },
      ],
      'Hi',
    )

    const final = calls[2]
    expect(String(final?.[2])).toBe('<think>thinking…\n\n工具调用:\n- bash: ls</think>\nHi')
  })

  it('wraps reasoning in a native <think> block ahead of the answer', async () => {
    const calls = await runStreamingMessage(
      [
        {
          type: 'assistant/chunk',
          data: {
            turn: 1,
            step: 1,
            chunk: { type: 'reasoning-delta', index: 1, text: 'thinking…' },
          },
        },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hi' } },
        },
      ],
      'Hi',
    )

    const final = calls[2]
    expect(final?.[3]).toBe(true)
    expect(String(final?.[2])).toBe('<think>thinking…</think>\nHi')
    // Intermediate stream frames carry the think block too, so the client can
    // render its thinking card while the answer is still streaming.
    expect(calls[1]?.[2]).toBe('<think>thinking…</think>\nHi')
    expect(calls[1]?.[3]).toBe(false)
  })

  it('strips nested think tags so the client sees a single block', async () => {
    const calls = await runStreamingMessage(
      [
        {
          type: 'assistant/chunk',
          data: {
            turn: 1,
            step: 1,
            chunk: { type: 'reasoning-delta', index: 1, text: 'a<think>b</think>c' },
          },
        },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hi' } },
        },
      ],
      'Hi',
    )

    const final = calls[2]
    expect(String(final?.[2])).toBe('<think>abc</think>\nHi')
  })

  it('routes /clear as a /new alias', async () => {
    const { client, fire } = makeClient()
    const channel = new WecomChannel(
      makeStreamingSetup([], 'unused') as never,
      testConfig({ streamFlushMs: 5_000 }),
      () => client,
    )
    await channel.start()
    await sendText(fire, '/clear')

    const calls = (client as unknown as { replyStream: ReturnType<typeof vi.fn> }).replyStream.mock
      .calls
    expect(calls.at(-1)?.[2]).toBe('Started a new conversation.')
    expect(calls.at(-1)?.[3]).toBe(true)
  })

  it('sends the approval ack through the proactive channel, never the passive stream', async () => {
    // A pending approval exists for this chat: the pool's interceptor
    // (normally installed by wireApprovals) returns an outcome.
    const { client, fire } = makeClient()
    const channel = new WecomChannel(
      makeStreamingSetup([], 'unused') as never,
      testConfig({ streamFlushMs: 5_000 }),
      () => client,
    )
    await channel.start()
    const intercept = (
      channel as unknown as { interceptApprovalReply: (m: unknown) => string | undefined }
    ).interceptApprovalReply
    ;(channel as unknown as { interceptApprovalReply: unknown }).interceptApprovalReply = () =>
      'allowed-once'
    expect(intercept).toBeDefined()

    await sendText(fire, '批准', 'm-approve')

    const replyCalls = (client as unknown as { replyStream: ReturnType<typeof vi.fn> }).replyStream
      .mock.calls
    const sendCalls = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage
      .mock.calls
    // The ack MUST ride sendMessage (proactive): a passive stream here can
    // displace the conversation's still-open reply stream.
    expect(replyCalls).toHaveLength(0)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]?.[0]).toBe('u1')
    expect(String(sendCalls[0]?.[1]?.markdown?.content)).toContain('已批准')
  })

  it('falls back to a proactive push when the final stream reply fails', async () => {
    const { client, fire } = makeClient()
    // The final finish=true frame is rejected by the server (e.g. stream
    // window expired, errcode 846608); every retry fails too.
    let callCount = 0
    ;(
      client as unknown as { replyStream: ReturnType<typeof vi.fn> }
    ).replyStream.mockImplementation(async () => {
      callCount += 1
      if (callCount >= 2) throw new Error('Reply ack error: errcode 846608')
      return undefined
    })
    const channel = new WecomChannel(
      makeStreamingSetup([], 'Final answer') as never,
      testConfig({ streamFlushMs: 5_000, sendAttempts: 1 }),
      () => client,
    )
    await channel.start()
    await sendText(fire, 'hi', 'm1')

    const sendCalls = (client as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage
      .mock.calls
    // The finished answer still reaches the user through sendMessage.
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]?.[0]).toBe('u1')
    expect(String(sendCalls[0]?.[1]?.markdown?.content)).toContain('Final answer')
  })

  it('sends rendered cards as uploaded media via the proactive channel, not stream msg_item', async () => {
    // A turn that produces an image block (card) must ship it through
    // uploadMedia → sendMediaMessage(media_id) on the PROACTIVE channel
    // (aibot_send_msg), NOT as a stream msg_item (which the WeCom doc says is
    // unsupported).
    const { client, fire } = makeClient()
    const stream = [
      {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '结论' } },
      },
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'c1', name: 'render_card', arguments: '{}' },
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
                content: [{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 3, width: 1080, height: 800 } }],
              },
            ],
          },
        },
      },
    ]
    const channel = new WecomChannel(
      makeStreamingSetup(stream, '结论') as never,
      testConfig({ streamFlushMs: 5_000 }),
      () => client,
    )
    await channel.start()
    await sendText(fire, 'hi', 'm1')

    const media = client as unknown as { uploadMedia: ReturnType<typeof vi.fn>; sendMediaMessage: ReturnType<typeof vi.fn> }
    // One upload (to get media_id) and one sendMediaMessage per rendered card.
    expect(media.uploadMedia).toHaveBeenCalled()
    expect(media.sendMediaMessage).toHaveBeenCalled()
    // The upload targets an image; the push targets the media_id from the stub.
    const uploadCalls = media.uploadMedia.mock.calls
    expect(uploadCalls[0]?.[1]).toMatchObject({ type: 'image' })
    const sendCalls = media.sendMediaMessage.mock.calls
    expect(sendCalls[0]?.[1]).toBe('image')
    expect(sendCalls[0]?.[2]).toBe('media-1')
    // Target is the single-chat userid from the inbound message.
    expect(sendCalls[0]?.[0]).toBe('u1')
  })
})

describe('buildStreamContent', () => {
  it('leaves the think tag open while only reasoning exists', () => {
    expect(buildStreamContent('still thinking…', '', false)).toBe('<think>still thinking…')
  })

  it('closes the think block once visible text arrives', () => {
    expect(buildStreamContent('thinking…', 'Hi', false)).toBe('<think>thinking…</think>\nHi')
  })

  it('closes the think block when the stream finishes without visible text', () => {
    expect(buildStreamContent('thinking…', '', true)).toBe('<think>thinking…</think>')
  })

  it('returns only the visible text when there is no reasoning', () => {
    expect(buildStreamContent('', 'Hi', false)).toBe('Hi')
  })

  it('strips nested and foreign think variants', () => {
    expect(buildStreamContent('a<think>b</think>c<thinking>d</thinking>', 'Hi', true)).toBe(
      '<think>abcd</think>\nHi',
    )
  })
})
