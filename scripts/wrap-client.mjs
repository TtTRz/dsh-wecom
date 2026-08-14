import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Wrap a CommonJS client bundle into the factory form the web module loader
 * executes (`window.__ModuleLoader__.load`), matching the shipped DSH client
 * bundles: the factory receives the loader's `require` and returns
 * `module.exports` as the client plugin face.
 *
 * Usage: node scripts/wrap-client.mjs <input.cjs> <output.js> <id>
 */

/** @param {string} id module-table id (the package name)
 *  @param {string} cjsCode CommonJS bundle body
 *  @returns {string} factory-form script */
export function wrapClient(id, cjsCode) {
  return [
    `window.__ModuleLoader__.load({`,
    `  id: ${JSON.stringify(id)},`,
    `  factory: (require) => {`,
    `    var module = { exports: {} }`,
    `    var exports = module.exports`,
    ``,
    cjsCode,
    ``,
    `    return module.exports`,
    `  },`,
    `})`,
    ``,
  ].join('\n')
}

/** @param {string} inputPath @param {string} outputPath @param {string} id */
export function buildClient(inputPath, outputPath, id) {
  writeFileSync(outputPath, wrapClient(id, readFileSync(inputPath, 'utf8')))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath, id] = process.argv.slice(2)
  if (inputPath === undefined || outputPath === undefined || id === undefined) {
    console.error('usage: node scripts/wrap-client.mjs <input.cjs> <output.js> <id>')
    process.exit(2)
  }
  buildClient(inputPath, outputPath, id)
}
