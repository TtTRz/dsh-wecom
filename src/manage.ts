import { readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { sanitizeNamespace } from './config.js'

/**
 * WeCom-bot manager. Reads the deployment's `cordis.patch.yml` and hands the
 * browser a list of dsh-wecom rows plus surgical edits — change a bot's
 * `preset`/`workspaceTitle` (the name that replaced the "WeCom" workspace
 * prefix), add a row, or delete one. Edits rewrite the patch file in place
 * WITHOUT re-emitting the whole document, so hand-maintained comments and
 * `!!js process.env.*` expressions survive. Changes apply at the next
 * dsh-web restart (patch is read at boot), which the UI states explicitly.
 */

/** One mounted dsh-wecom row projected to the browser (scalars only). */
export interface BotSpec {
  id: string
  namespace: string
  preset: string
  workspaceTitle: string
  credentialName: string
  /** The raw `botId` value exactly as written (e.g. `!!js process.env.WECOM_BOT_ID`). */
  botIdExpr: string
  /** Whether this is the `default` namespace row (carries the aggregate list). */
  isDefault: boolean
}

export const DEFAULT_PATCH_PATH = join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')

/** Split a patch on top-level list items, keeping leading comments with the row. */
function findRows(lines: string[]): Array<{ start: number; end: number; text: string }> {
  const rows: Array<{ start: number; end: number; text: string }> = []
  let i = 0
  while (i < lines.length) {
    if (/^-\s/.test(lines[i]!)) {
      const start = i
      let j = i + 1
      while (j < lines.length && !/^-\s/.test(lines[j]!)) j += 1
      rows.push({ start, end: j, text: lines.slice(start, j).join('\n') })
      i = j
    } else {
      i += 1
    }
  }
  return rows
}

function fieldValue(text: string, field: string): string {
  const match = new RegExp(`^[ \\t]+${field}:[ \\t]*(.*)$`, 'm').exec(text)
  return match?.[1]?.trim() ?? ''
}

function rowId(text: string): string | undefined {
  return /^-\s*id:\s*(\S+)/m.exec(text)?.[1]
}

function isWecomRow(text: string): boolean {
  return /\bname:\s*dsh-wecom\b/.test(text)
}

/** Extract every dsh-wecom row from a patch document. */
export function listBots(text: string): BotSpec[] {
  const lines = text.split('\n')
  const bots: BotSpec[] = []
  for (const row of findRows(lines)) {
    if (!isWecomRow(row.text)) continue
    const id = rowId(row.text)
    if (id === undefined) continue
    const namespace = fieldValue(row.text, 'namespace') || 'default'
    bots.push({
      id,
      namespace,
      preset: fieldValue(row.text, 'preset') || 'standard',
      workspaceTitle: fieldValue(row.text, 'workspaceTitle') || 'WeCom',
      credentialName: fieldValue(row.text, 'credentialName') || 'WECOM_BOT_SECRET',
      botIdExpr: fieldValue(row.text, 'botId') || '',
      isDefault: namespace === 'default',
    })
  }
  return bots
}

/** @returns the zero-based line index of the `config:` line in a row, or -1. */
function configLineIndex(lines: string[], start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (/^[ \t]+config:[ \t]*$/.test(lines[i]!)) return i
  }
  return -1
}

/** Set one scalar line inside a row's config, inserting it after `config:` if missing. */
function setField(
  lines: string[],
  start: number,
  end: number,
  field: string,
  value: string,
): boolean {
  const pattern = new RegExp(`^(\\s+)${field}:[ \\t]*.*$`)
  for (let i = start; i < end; i += 1) {
    const match = pattern.exec(lines[i]!)
    if (match !== null) {
      lines[i] = `${match[1]}${field}: ${value}`
      return true
    }
  }
  const configIdx = configLineIndex(lines, start, end)
  if (configIdx < 0) return false
  // Insert as a field two spaces deeper than `config:`.
  const indent = /^(\s+)config:/m.exec(lines[configIdx]!)?.[1] ?? '  '
  lines.splice(configIdx + 1, 0, `${indent}  ${field}: ${value}`)
  return true
}

/** Apply preset / workspaceTitle edits to one wecom row; returns a new document. */
export function editBot(
  text: string,
  id: string,
  patch: { preset?: string; workspaceTitle?: string },
): string {
  const lines = text.split('\n')
  for (const row of findRows(lines)) {
    if (rowId(row.text) !== id || !isWecomRow(row.text)) continue
    if (patch.preset !== undefined) setField(lines, row.start, row.end, 'preset', patch.preset)
    if (patch.workspaceTitle !== undefined)
      setField(lines, row.start, row.end, 'workspaceTitle', patch.workspaceTitle)
    return lines.join('\n')
  }
  throw new Error(`dsh-wecom: no bot row with id ${JSON.stringify(id)}`)
}

/** A new dsh-wecom row, appended at the end of the patch (distinct ids, order-free). */
export function addBot(
  text: string,
  spec: { namespace: string; name: string; preset: string },
): string {
  const namespace = sanitizeNamespace(spec.namespace)
  const envSuffix = namespace.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const block = [
    '',
    `- id: wecom-channel-${namespace}`,
    '  name: dsh-wecom',
    '  config:',
    `    botId: !!js process.env.WECOM_BOT_ID_${envSuffix}`,
    `    credentialName: WECOM_BOT_SECRET_${envSuffix}`,
    `    namespace: ${namespace}`,
    `    preset: ${spec.preset}`,
    `    workspaceTitle: ${spec.name}`,
  ].join('\n')
  return `${text.replace(/\n*$/, '\n')}${block}\n`
}

/** Delete one wecom row plus its immediately-preceding comment/blank lines. */
export function removeBot(text: string, id: string): string {
  const lines = text.split('\n')
  for (const row of findRows(lines)) {
    if (rowId(row.text) !== id || !isWecomRow(row.text)) continue
    let start = row.start
    // Pull in the comment/blank lines just above the row so the deletion
    // leaves no orphaned "# wecom-channel 行覆盖…" header behind.
    while (start > 0 && /^\s*(#.*)?$/.test(lines[start - 1]!)) start -= 1
    lines.splice(start, row.end - start)
    return lines.join('\n')
  }
  throw new Error(`dsh-wecom: no bot row with id ${JSON.stringify(id)}`)
}

/** Read one JSON request body. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

interface PresetsLike {
  list(): Promise<readonly { id: string }[]> | readonly { id: string }[]
}

/**
 * Serve `/api/wecom/bots` (GET list, PUT edit, POST add, DELETE remove) — a
 * single-registration surface for the default row. `/api/wecom/bots` must not
 * be mounted by more than one row, so callers gate this on `namespace ===
 * 'default'`. In web-less profiles this is a no-op disposer.
 */
export function registerManageRoutes(ctx: Context, patchPath: string): () => void {
  const webServer = ctx.get('webServer') as
    | {
        register(route: {
          kind: 'exact'
          path: string
          handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
        }): () => void
      }
    | undefined
  if (webServer === undefined) return () => undefined

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const read = (): string => readFileSync(patchPath, 'utf8')
  const presets = async (): Promise<string[]> => {
    const svc = ctx.get('agentPresets') as PresetsLike | undefined
    const list = svc?.list?.()
    if (list === undefined) return []
    const rows = await list
    return rows.map((r) => r.id)
  }
  const respondList = async (res: ServerResponse): Promise<void> => {
    try {
      send(res, 200, {
        path: patchPath,
        presets: await presets(),
        bots: listBots(read()),
      })
    } catch (error) {
      send(res, 500, { available: false, error: String(error) })
    }
  }

  return webServer.register({
    kind: 'exact',
    path: '/api/wecom/bots',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          await respondList(res)
          return
        }
        if (req.method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            id?: string
            preset?: string
            workspaceTitle?: string
          }
          if (body.id === undefined) throw new Error('missing id')
          const next = editBot(read(), body.id, {
            ...(body.preset === undefined ? {} : { preset: body.preset }),
            ...(body.workspaceTitle === undefined ? {} : { workspaceTitle: body.workspaceTitle }),
          })
          writeFileSync(patchPath, next, 'utf8')
          await respondList(res)
          return
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            namespace?: string
            name?: string
            preset?: string
          }
          if (
            body.namespace === undefined ||
            body.name === undefined ||
            body.preset === undefined
          ) {
            throw new Error('missing namespace / name / preset')
          }
          const next = addBot(read(), {
            namespace: body.namespace,
            name: body.name,
            preset: body.preset,
          })
          writeFileSync(patchPath, next, 'utf8')
          await respondList(res)
          return
        }
        if (req.method === 'DELETE') {
          const query = new URL(req.url ?? '/', 'http://local').searchParams
          const id = query.get('id')
          if (id === null) throw new Error('missing id')
          const next = removeBot(read(), id)
          writeFileSync(patchPath, next, 'utf8')
          await respondList(res)
          return
        }
        send(res, 405, { available: false, error: 'method not allowed' })
      } catch (error) {
        send(res, 400, { available: false, error: String(error) })
      }
    },
  })
}
