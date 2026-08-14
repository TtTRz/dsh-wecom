import { describe, expect, it } from 'vitest'
import { wrapClient } from '../scripts/wrap-client.mjs'

describe('wrapClient', () => {
  it('wraps a CommonJS bundle into the module-loader factory form', () => {
    const out = wrapClient('dsh-wecom', 'exports.inject = []; exports.apply = function () {}')
    expect(out).toContain('window.__ModuleLoader__.load({')
    expect(out).toContain('id: "dsh-wecom"')
    expect(out).toContain('factory: (require) => {')
    expect(out).toContain('var module = { exports: {} }')
    expect(out).toContain('exports.inject = []')
    expect(out).toContain('return module.exports')
  })
})
