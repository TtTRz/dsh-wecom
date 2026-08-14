import { describe, expect, it, vi } from 'vitest'
import type { ChannelStatus } from '../src/channel.js'
import { registerStatusRoute, statusPayload } from '../src/status.js'

const snapshot: ChannelStatus = {
  connected: true,
  stopping: false,
  conversations: 2,
  authenticatedAt: Date.now() - 90_000,
  lastError: null,
}

describe('statusPayload', () => {
  it('projects scalars and computes the authentication age', () => {
    const payload = statusPayload(snapshot)
    expect(payload).toEqual({
      available: true,
      connected: true,
      stopping: false,
      conversations: 2,
      authenticatedAgoMs: payload.authenticatedAgoMs,
      lastError: null,
    })
    expect(payload.authenticatedAgoMs).toBeGreaterThanOrEqual(90_000)
  })

  it('keeps null for a channel that never authenticated', () => {
    const payload = statusPayload({ ...snapshot, authenticatedAt: null })
    expect(payload.authenticatedAgoMs).toBeNull()
  })
})

describe('registerStatusRoute', () => {
  it('registers GET /api/wecom/status when a web server exists', () => {
    const routes: unknown[] = []
    const ctx = {
      get: vi.fn((name: string) =>
        name === 'webServer'
          ? {
              register: (route: unknown) => {
                routes.push(route)
                return () => undefined
              },
            }
          : undefined,
      ),
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
      ) => void
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
    route.handler({}, res as never)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(res.body)).toMatchObject({
      available: true,
      connected: true,
      conversations: 2,
    })
    expect(typeof dispose).toBe('function')
  })

  it('is a no-op disposer without a web server', () => {
    const ctx = { get: vi.fn(() => undefined) }
    const dispose = registerStatusRoute(ctx as never, () => snapshot)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})
