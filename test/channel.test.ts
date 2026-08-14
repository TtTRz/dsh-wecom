import { describe, expect, it, vi } from 'vitest'
import { type BotClient, WecomChannel } from '../src/channel.js'
import { testConfig } from './test-config.js'

function makeClient() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const client = {
    isConnected: false,
    on(event: string, handler: (...args: unknown[]) => void) {
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
    replyWelcome: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => ({ buffer: new Uint8Array() })),
  }
  const botClient = client as unknown as BotClient
  const fire = (event: string, ...args: unknown[]): void => {
    handlers.get(event)?.(...args)
  }
  return { client: botClient, fire }
}

function makeCtx() {
  return {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
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
})
