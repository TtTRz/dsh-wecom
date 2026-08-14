import { describe, expect, it } from 'vitest'
import { formatAgo } from '../src/client.js'

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
