import { describe, expect, it, vi } from 'vitest'
import type { ChannelStatus } from '../src/channel.js'
import { processView, registerRestartRoute, registerStatusRoute, statusPayload } from '../src/status.js'

const snapshot: ChannelStatus = {
  connected: true,
  stopping: false,
  conversations: 2,
  authenticatedAt: Date.now() - 90_000,
  lastError: null,
}

const agents = [
  {
    session: { id: 'dsh-wecom-single-abc123' },
    status: 'idle',
    options: { model: 'deepseek-v4-flash' },
  },
  { session: { id: 'session-xyz-456' }, status: 'running', options: { model: 'deepseek-v4-pro' } },
]

describe('statusPayload', () => {
  it('projects scalars and computes the authentication age', () => {
    const payload = statusPayload(snapshot, [], [])
    expect(payload.connected).toBe(true)
    expect(payload.conversations).toBe(2)
    expect(payload.authenticatedAgoMs).toBeGreaterThanOrEqual(90_000)
    expect(payload.lastError).toBeNull()
  })

  it('keeps null for a channel that never authenticated', () => {
    const payload = statusPayload({ ...snapshot, authenticatedAt: null }, [], [])
    expect(payload.authenticatedAgoMs).toBeNull()
  })

  it('projects live agents as scalars, running first, with the wecom flag', () => {
    const payload = statusPayload(snapshot, agents, [])
    expect(payload.agents).toEqual([
      {
        sessionId: 'session-xyz-456',
        status: 'running',
        model: 'deepseek-v4-pro',
        wecom: false,
      },
      {
        sessionId: 'dsh-wecom-single-abc123',
        status: 'idle',
        model: 'deepseek-v4-flash',
        wecom: true,
      },
    ])
  })

  it('counts total and WeCom sessions', () => {
    const payload = statusPayload(
      snapshot,
      [],
      ['dsh-wecom-single-a', 'dsh-wecom-group-b', 'session-c'],
    )
    expect(payload.sessions).toEqual({ total: 3, wecom: 2 })
  })
})

describe('processView', () => {
  it('reports process and machine scalars', () => {
    const view = processView()
    expect(view.memoryRss).toBeGreaterThan(0)
    expect(view.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(view.loadavg).toHaveLength(3)
    expect(view.totalmem).toBeGreaterThan(0)
    expect(view.freemem).toBeGreaterThanOrEqual(0)
  })
})

describe('registerStatusRoute', () => {
  it('registers GET /api/wecom/status with live agents and sessions', async () => {
    const routes: unknown[] = []
    const ctx = {
      get: vi.fn((name: string) => {
        if (name === 'webServer') {
          return {
            register: (route: unknown) => {
              routes.push(route)
              return () => undefined
            },
          }
        }
        if (name === 'agents') return { list: () => agents }
        if (name === 'sessionPersistence') {
          return { list: async () => [{ id: 'dsh-wecom-single-a' }, { id: 'session-b' }] }
        }
        return undefined
      }),
    }
    const dispose = registerStatusRoute(ctx as never, () => snapshot)
    expect(routes).toHaveLength(1)

    const route = routes[0] as {
      kind: string
      path: string
      handler: (
        req: unknown,
        res: {
          statusCode: number
          headers: Record<string, string>
          body: string
          setHeader(name: string, value: string): void
          end(body: string): void
        },
      ) => Promise<void> | void
    }
    expect(route.kind).toBe('exact')
    expect(route.path).toBe('/api/wecom/status')

    const res: {
      statusCode: number
      headers: Record<string, string>
      body: string
      setHeader(name: string, value: string): void
      end(body: string): void
    } = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value
      },
      end(body: string) {
        this.body = body
      },
    }
    await route.handler({}, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['cache-control']).toBe('no-store')
    const parsed = JSON.parse(res.body)
    expect(parsed.available).toBe(true)
    expect(parsed.agents).toHaveLength(2)
    expect(parsed.sessions).toEqual({ total: 2, wecom: 1 })
    expect(typeof dispose).toBe('function')
  })

  it('answers 500 with a structured error when providers throw', async () => {
    const routes: unknown[] = []
    const ctx = {
      get: vi.fn((name: string) => {
        if (name === 'webServer') {
          return {
            register: (route: unknown) => {
              routes.push(route)
              return () => undefined
            },
          }
        }
        if (name === 'agents') return { list: () => [{ session: { id: 'x' }, status: 'idle' }] }
        if (name === 'sessionPersistence') return { list: async () => [] }
        return undefined
      }),
    }
    registerStatusRoute(ctx as never, () => {
      throw new Error('snapshot broken')
    })
    const route = routes[0] as {
      handler: (
        req: unknown,
        res: {
          statusCode: number
          body: string
          setHeader(name: string, value: string): void
          end(body: string): void
        },
      ) => Promise<void>
    }
    const res = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(body: string) {
        this.body = body
      },
    }
    await route.handler({}, res as never)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ available: false, error: 'Error: snapshot broken' })
  })

  it('is a no-op disposer without a web server', () => {
    const ctx = { get: vi.fn(() => undefined) }
    const dispose = registerStatusRoute(ctx as never, () => snapshot)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})

describe('registerRestartRoute', () => {
  it('registers POST /api/wecom/restart and invokes the restart callback', () => {
    const routes: unknown[] = []
    let restarted = 0
    const ctx = {
      get: vi.fn((name: string) => {
        if (name === 'webServer') {
          return {
            register: (route: unknown) => {
              routes.push(route)
              return () => undefined
            },
          }
        }
        return undefined
      }),
    }
    registerRestartRoute(ctx as never, () => {
      restarted += 1
    })
    const route = routes[0] as {
      kind: string
      path: string
      handler: (req: unknown, res: { statusCode: number; body: string; setHeader(): void; end(b: string): void }) => void
    }
    expect(route.kind).toBe('exact')
    expect(route.path).toBe('/api/wecom/restart')

    const res = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(body: string) {
        this.body = body
      },
    }
    route.handler({}, res as never)
    expect(restarted).toBe(1)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it('answers 500 when the restart callback throws', () => {
    const routes: unknown[] = []
    const ctx = {
      get: vi.fn((name: string) => {
        if (name === 'webServer') {
          return {
            register: (route: unknown) => {
              routes.push(route)
              return () => undefined
            },
          }
        }
        return undefined
      }),
    }
    registerRestartRoute(ctx as never, () => {
      throw new Error('no socket')
    })
    const route = routes[0] as {
      handler: (req: unknown, res: { statusCode: number; body: string; setHeader(): void; end(b: string): void }) => void
    }
    const res = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(body: string) {
        this.body = body
      },
    }
    route.handler({}, res as never)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'Error: no socket' })
  })

  it('is a no-op disposer without a web server', () => {
    const ctx = { get: vi.fn(() => undefined) }
    const dispose = registerRestartRoute(ctx as never, () => undefined)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})
