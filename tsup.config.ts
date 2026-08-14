import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2024',
  },
  {
    entry: { client: 'src/client.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'es2024',
  },
])
