/** Exercise the channel pool against an installed rc.2 JSONL backend in a temporary directory. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'tsup'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
assert.ok(process.argv[2], 'Usage: node scripts/persistence-smoke.mjs <dsh-install-prefix>')
const runtime = createRequire(join(resolve(process.argv[2]), 'package.json'))
const local = createRequire(join(root, 'package.json'))
const load = (name) => import(pathToFileURL(runtime.resolve(name)).href)
const manifest = JSON.parse(
  await readFile(runtime.resolve('@deepseek-ai/dsh/package.json'), 'utf8'),
)
assert.equal(manifest.version, '0.1.7-rc.2')
const { Context } = await load('@deepseek-ai/cordis')
const { default: JsonlPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { SESSION_FORMAT_VERSION, SessionId } = await load('@deepseek-ai/dsh-session')
const home = await mkdtemp(join(tmpdir(), 'wecom-persistence-smoke-'))
const ctx = new Context()
let pool
try {
  await mkdir(join(home, 'node_modules'), { recursive: true })
  await symlink(
    dirname(dirname(runtime.resolve('@deepseek-ai/dsh/package.json'))),
    join(home, 'node_modules/@deepseek-ai'),
    'dir',
  )
  await symlink(
    dirname(dirname(local.resolve('@wecom/aibot-node-sdk/package.json'))),
    join(home, 'node_modules/@wecom'),
    'dir',
  )
  await build({
    config: false,
    entry: [join(root, 'src/pool.ts'), join(root, 'src/config.ts'), join(root, 'src/helpers.ts')],
    format: ['esm'],
    outDir: join(home, 'plugin'),
    outExtension: () => ({ js: '.mjs' }),
    target: 'es2024',
    silent: true,
  })
  const { AgentPool } = await import(pathToFileURL(join(home, 'plugin/pool.mjs')).href)
  const { Config } = await import(pathToFileURL(join(home, 'plugin/config.mjs')).href)
  const { conversationId } = await import(pathToFileURL(join(home, 'plugin/helpers.mjs')).href)
  const backend = new JsonlPersistence(ctx, { root: join(home, 'sessions') })
  const message = { chattype: 'single', from: { userid: 'example-user' } }
  const base = conversationId('default', message)
  const workspace = join(home, 'workspaces')
  const attached = []
  const registry = {
    create: async (path) => ({ path, attachSession: async (id) => attached.push(id) }),
  }
  const config = Config({ botId: 'test-bot', cwd: workspace })
  const persistencePort = {
    list: (...args) => backend.list(...args),
    open: (...args) => backend.open(...args),
  }
  const makePool = () =>
    new AgentPool(
      {
        on: () => () => undefined,
        logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
        sessionPersistence: persistencePort,
        agents: { get: () => undefined },
        get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
      },
      config,
    )
  const seed = async (epoch) => {
    const id = epoch === 0 ? base : `${base}~g${epoch}`
    const handle = await backend.create({
      id: SessionId(id),
      version: SESSION_FORMAT_VERSION,
      createdAt: 1_700_000_000_000 + epoch * 1000,
      isSeeded: false,
      cwd: join(workspace, `WeCom-example-user-0101-120000-${id.slice(-6)}`),
    })
    try {
      await handle.append([
        {
          type: 'session/title',
          seq: 0,
          time: 1_700_000_000_000,
          data: { title: `Topic ${epoch}`, messageSeqs: [], source: { kind: 'user' } },
          ignorable: true,
        },
      ])
      await handle.flush()
    } finally {
      await handle.close()
    }
  }
  for (const epoch of [0, 1, 2]) await seed(epoch)
  const fixtureReader = await backend.open(SessionId(base), 'read')
  try {
    assert.equal((await fixtureReader.read()).events[0]?.data.title, 'Topic 0')
  } finally {
    await fixtureReader.close()
  }
  pool = makePool()
  await pool.start()
  assert.equal(attached.length, 3, 'startup must retain stored cwd metadata')
  const rows = await pool.listSessions(message)
  assert.deepEqual(
    rows.map((row) => row.epoch),
    [2, 1, 0],
  )
  assert.deepEqual(
    rows.map((row) => row.title),
    ['Topic 2', 'Topic 1', 'Topic 0'],
  )
  assert.ok(rows.every((row) => row.turns === 0 && row.createdAt !== null))
  assert.equal((await pool.currentSession(message)).epoch, 0)
  assert.match(await pool.resumeSession(message, '1'), /已切换到 session #1/)
  assert.equal((await pool.currentSession(message)).epoch, 1)
  await pool.dispose()
  pool = makePool()
  await pool.start()
  assert.equal((await pool.currentSession(message)).epoch, 1, 'routing must survive restart')
  await seed(7)
  assert.equal(await pool.forget(message), 8, 'new sessions must skip epochs added after startup')
  console.log(
    'PASS: rc.2 JSONL history, cold-log titles, workspace regrouping, resume/restart, and fresh epoch allocation',
  )
} finally {
  try {
    await pool?.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}
