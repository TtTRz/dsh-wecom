import { describe, expect, it } from 'vitest'
import { agentLabel, formatAgo, formatBytes, formatUptime } from '../src/client.js'

describe('formatAgo', () => {
  it('renders null or undefined as an em dash', () => {
    expect(formatAgo(null)).toBe('—')
    expect(formatAgo(undefined)).toBe('—')
  })

  it('formats seconds, minutes, and hours', () => {
    expect(formatAgo(5_000)).toBe('5s ago')
    expect(formatAgo(90_000)).toBe('1m ago')
    expect(formatAgo(2 * 60 * 60 * 1000)).toBe('2h ago')
  })
})

describe('formatBytes', () => {
  it('renders whole megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB')
    expect(formatBytes(undefined)).toBe('—')
  })
})

describe('formatUptime', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatUptime(30)).toBe('30s')
    expect(formatUptime(90)).toBe('1m')
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe('2h 5m')
    expect(formatUptime(undefined)).toBe('—')
  })
})

describe('agentLabel', () => {
  it('labels WeCom conversations by scope and web sessions by tail', () => {
    expect(agentLabel({ sessionId: 'dsh-wecom-single-abc123', wecom: true })).toBe('WeCom · single')
    expect(agentLabel({ sessionId: 'dsh-wecom-group-xyz789', wecom: true })).toBe('WeCom · group')
    expect(agentLabel({ sessionId: 'session-abc123def456', wecom: false })).toBe('Web · def456')
  })
})
