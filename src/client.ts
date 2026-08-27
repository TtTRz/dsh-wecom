import * as React from 'react'

/**
 * Browser half of dsh-wecom: a WeCom status action in the sidebar foot plus a
 * floating status panel over `shell.overlay`. Both poll `GET /api/wecom/status`
 * served by the host half, so this plugin never touches channel internals.
 *
 * The bundle is built to CommonJS and wrapped by `scripts/wrap-client.mjs`
 * into the factory form the web module loader executes.
 * @module dsh-wecom/client
 */

/** Minimal structural faces for the browser services this half consumes. */
interface SlotRenderProps {
  wide?: boolean
}
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(
    options: { name: string; id: string; order?: number; label?: string },
    render: (props: SlotRenderProps) => React.ReactNode,
  ): () => void
}
interface TimerService {
  interval(callback: () => void, delay: number): () => void
}

/** One sibling bot aggregated into the default row's status payload. */
interface InstanceView {
  id: string
  available: boolean
  connected?: boolean
  conversations?: number
  lastError?: string | null
}

/** Wire shape of `GET <base>/status` (unknown when the host is down). */
interface StatusView {
  available?: boolean
  connected?: boolean
  stopping?: boolean
  /** Namespace of the row that answered (`default` on the legacy route). */
  namespace?: string
  /** Sibling bots aggregated by the default row (panel switcher data). */
  instances?: InstanceView[]
  conversations?: number
  authenticatedAgoMs?: number | null
  lastError?: string | null
  agents?: Array<{
    sessionId: string
    status: string
    model: string
    wecom: boolean
    peer?: string
  }>
  process?: {
    memoryRss: number
    uptimeSec: number
    loadavg: number[]
    totalmem: number
    freemem: number
  }
  sessions?: {
    total: number
    wecom: number
  }
}

/** "3m ago"-style duration from an epoch-delta in milliseconds. */
export function formatAgo(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 60 * 1000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / (60 * 1000))}m ago`
  return `${Math.floor(ms / (60 * 60 * 1000))}h ago`
}

/** Whole-megabyte memory rendering. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** "2h 5m"-style process uptime. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** Compact row label for one live WeCom agent. */
export function agentLabel(agent: { sessionId: string; peer?: string }): string {
  if (agent.peer !== undefined && agent.peer !== '') return agent.peer
  const parts = agent.sessionId.split('-')
  const scope = parts[2] ?? 'chat'
  return `WeCom · ${scope}`
}

const CSS = [
  '.wecom-nav-btn{display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;background:transparent;border:none;color:var(--dsw-alias-label-secondary);padding:7px 12px;border-radius:8px;font-size:13px;line-height:20px;width:100%}',
  '.wecom-nav-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
  '.wecom-nav-rail{width:auto;justify-content:center}',
  '.wecom-nav-left{display:flex;align-items:center;gap:6px}',
  '.wecom-nav-sessions{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
  '.wecom-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}',
  '.wecom-panel{position:fixed;right:16px;bottom:16px;width:320px;max-height:70vh;overflow:auto;z-index:9999;pointer-events:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25);padding:14px 16px;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.wecom-panel-head{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:6px}',
  '.wecom-panel-close{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1}',
  '.wecom-panel-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:7px 0}',
  '.wecom-panel-label{color:var(--dsw-alias-label-secondary)}',
  '.wecom-panel-error{color:var(--dsw-alias-state-error-primary);word-break:break-word;margin:4px 0}',
  '.wecom-panel-btn{margin-top:6px;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px}',
  '.wecom-panel-section{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600}',
  '.wecom-agent-row{display:flex;align-items:center;gap:8px;margin:6px 0}',
  '.wecom-agent-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.wecom-agent-model{color:var(--dsw-alias-label-secondary);font-size:12px}',
  '.wecom-mgr-panel{position:fixed;right:16px;bottom:16px;width:420px;max-height:78vh;overflow:auto;z-index:9999;pointer-events:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25);padding:14px 16px;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.wecom-mgr-head{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:2px}',
  '.wecom-mgr-hint{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin:4px 0 10px}',
  '.wecom-mgr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin:8px 0}',
  '.wecom-mgr-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}',
  '.wecom-mgr-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 6px;white-space:nowrap}',
  '.wecom-mgr-meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:8px;word-break:break-all;line-height:1.6}',
  '.wecom-mgr-field{margin:6px 0}',
  '.wecom-mgr-label{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:3px}',
  '.wecom-mgr-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font-size:13px}',
  '.wecom-mgr-row{display:flex;gap:8px;align-items:center}',
  '.wecom-mgr-btn{cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px}',
  '.wecom-mgr-btn:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}',
  '.wecom-mgr-btn[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}',
  '.wecom-mgr-btn:disabled{opacity:.5;cursor:default}',
  '.wecom-mgr-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0;word-break:break-word}',
].join('')

interface Store {
  open: boolean
  status: StatusView | null
  /** Sibling bot list from the primary payload; empty when single-bot. */
  bots: InstanceView[]
  /** Whether the bot manager dock panel is open. */
  botsOpen: boolean
  /** Latest `/api/wecom/bots` payload, or null before the first load. */
  botsData: BotsView | null
}

/** One dsh-wecom row projected by the bot manager. */
interface BotView {
  id: string
  namespace: string
  preset: string
  workspaceTitle: string
  credentialName: string
  botIdExpr: string
  isDefault: boolean
}

interface BotsView {
  path: string
  presets: string[]
  bots: BotView[]
  error?: string
}

export const inject = ['slots', 'timer']

export function apply(ctx: {
  get(name: 'slots'): SlotsService | undefined
  get(name: 'timer'): TimerService | undefined
  get(name: string): unknown
  effect(callback: () => () => void, label?: string): () => void
}): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const timer = ctx.get('timer')

  ctx.effect(() => {
    const element = document.createElement('style')
    element.textContent = CSS
    document.head.append(element)
    return () => element.remove()
  }, 'dsh-wecom.client-style')

  const store: Store = { open: false, status: null, bots: [], botsOpen: false, botsData: null }
  const listeners: Array<() => void> = []
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const setOpen = (value: boolean): void => {
    if (store.open === value) return
    store.open = value
    emit()
  }
  const setStatus = (value: StatusView): void => {
    store.status = value
    emit()
  }
  const setBotsOpen = (value: boolean): void => {
    if (store.botsOpen === value) return
    store.botsOpen = value
    if (value) setOpen(false)
    emit()
  }
  const setBotsData = (value: BotsView): void => {
    store.botsData = value
    emit()
  }
  const loadBots = async (): Promise<void> => {
    try {
      const response = await fetch('/api/wecom/bots')
      if (!response.ok) throw new Error(`bots ${response.status}`)
      setBotsData((await response.json()) as BotsView)
    } catch (error) {
      setBotsData({ path: '', presets: [], bots: [], error: String(error) })
    }
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  }
  const useStore = (): void => {
    const [, force] = React.useState(0)
    React.useEffect(() => subscribe(() => force((value) => value + 1)), [])
  }

  const poll = async (): Promise<void> => {
    try {
      const response = await fetch('/api/wecom/status')
      if (!response.ok) throw new Error(`status ${response.status}`)
      const data = (await response.json()) as StatusView
      store.bots = data.instances ?? []
      setStatus(data)
    } catch {
      setStatus({ available: false })
    }
  }

  function FooterAction(props: SlotRenderProps): React.ReactNode {
    useStore()
    React.useEffect(() => {
      if (timer === undefined) return undefined
      return timer.interval(() => {
        void poll()
      }, 5000)
    }, [])
    const status = store.status
    const connected = status !== null && status.available === true && status.connected === true
    const color = connected
      ? 'var(--dsw-alias-state-success-primary)'
      : status === null
        ? 'var(--dsw-alias-label-secondary)'
        : 'var(--dsw-alias-state-warn-primary)'
    const counts = status?.sessions
    const running = (status?.agents ?? []).filter(
      (agent) => agent.wecom && agent.status === 'running',
    ).length
    const sessionsText =
      status !== null && status.available === true && counts !== undefined
        ? `Active: ${running} Total: ${counts.wecom}`
        : null
    return React.createElement(
      'button',
      {
        type: 'button',
        className: props.wide === true ? 'wecom-nav-btn' : 'wecom-nav-btn wecom-nav-rail',
        title: connected ? 'WeCom bot connected' : 'WeCom bot status',
        onClick: () => setOpen(!store.open),
      },
      React.createElement(
        'span',
        { className: 'wecom-nav-left' },
        React.createElement('span', { className: 'wecom-dot', style: { background: color } }),
        props.wide === true ? 'WeCom' : null,
      ),
      props.wide === true && sessionsText !== null
        ? React.createElement('span', { className: 'wecom-nav-sessions' }, sessionsText)
        : null,
    )
  }

  function StatusPanel(): React.ReactNode {
    useStore()
    const [restarting, setRestarting] = React.useState(false)
    const restart = async (): Promise<void> => {
      setRestarting(true)
      try {
        // Restarts the primary (default) row's long connection, the one this
        // panel's payload comes from.
        await fetch('/api/wecom/restart', { method: 'POST' })
      } catch {
        // status endpoint poll below surfaces the outcome
      }
      setRestarting(false)
      void poll()
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: the dep re-runs the poll when the panel opens
    React.useEffect(() => {
      if (store.open) void poll()
    }, [store.open])
    if (!store.open) return null
    const status = store.status ?? { available: false }
    const rows: React.ReactNode[] = []
    if (status.available !== true) {
      rows.push(
        React.createElement(
          'div',
          { key: 'hint', className: 'wecom-panel-error' },
          'Status endpoint not reachable yet.',
        ),
      )
    }
    if (status.lastError) {
      rows.push(
        React.createElement(
          'div',
          { key: 'error', className: 'wecom-panel-error' },
          status.lastError,
        ),
      )
    }

    const agentNodes: React.ReactNode[] = []
    // Only WeCom conversations belong in this panel; web sessions are noise here.
    const agents = (status.agents ?? []).filter((agent) => agent.wecom)
    for (const agent of agents.slice(0, 8)) {
      agentNodes.push(
        React.createElement(
          'div',
          { key: agent.sessionId, className: 'wecom-agent-row' },
          React.createElement('span', {
            className: 'wecom-dot',
            style: {
              background:
                agent.status === 'running'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-label-secondary)',
            },
          }),
          React.createElement('span', { className: 'wecom-agent-label' }, agentLabel(agent)),
          agent.model
            ? React.createElement('span', { className: 'wecom-agent-model' }, agent.model)
            : null,
        ),
      )
    }
    if (agents.length > 8) {
      agentNodes.push(
        React.createElement(
          'div',
          { key: 'more', className: 'wecom-agent-model' },
          `+${agents.length - 8} more`,
        ),
      )
    }
    const proc = status.process
    const counts = status.sessions

    // Every bot coexists in one panel: the primary row (the one serving this
    // payload) followed by each aggregated sibling. All WeCom conversations
    // already appear in the global agents/sections below, so this list is
    // connection health per bot rather than a switch between them.
    const botRows: React.ReactNode[] = []
    const pushBot = (
      id: string,
      available: boolean | undefined,
      connected: boolean | undefined,
      conversations: number | undefined,
      lastError?: string | null,
    ): void => {
      const ok = available === true && connected === true
      const color =
        available !== true
          ? 'var(--dsw-alias-label-secondary)'
          : ok
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-state-warn-primary)'
      botRows.push(
        React.createElement(
          'div',
          { key: id, className: 'wecom-panel-row' },
          React.createElement(
            'span',
            { className: 'wecom-panel-label', title: lastError ?? undefined },
            React.createElement('span', { className: 'wecom-dot', style: { background: color } }),
            ` ${id}`,
          ),
          React.createElement(
            'span',
            null,
            `${available === true ? String(conversations ?? 0) : '—'} conv`,
          ),
        ),
      )
    }
    pushBot(status.namespace ?? 'default', status.available, status.connected, status.conversations)
    for (const bot of store.bots) {
      pushBot(bot.id, bot.available, bot.connected, bot.conversations, bot.lastError)
    }

    return React.createElement(
      'div',
      { className: 'wecom-panel' },
      React.createElement(
        'div',
        { className: 'wecom-panel-head' },
        React.createElement('span', null, 'WeCom Bots'),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'wecom-panel-close',
            onClick: () => setOpen(false),
            title: 'Close',
          },
          '×',
        ),
      ),
      React.createElement('div', { className: 'wecom-panel-section' }, 'Bots'),
      botRows,
      React.createElement(
        'div',
        { className: 'wecom-panel-row' },
        React.createElement('span', { className: 'wecom-panel-label' }, 'Authenticated'),
        React.createElement(
          'span',
          null,
          status.available === true ? formatAgo(status.authenticatedAgoMs) : '—',
        ),
      ),
      React.createElement('div', { className: 'wecom-panel-section' }, 'Live agents'),
      agentNodes.length > 0
        ? agentNodes
        : React.createElement('div', { className: 'wecom-agent-model' }, 'None'),
      counts
        ? React.createElement(
            'div',
            { className: 'wecom-panel-row' },
            React.createElement('span', { className: 'wecom-panel-label' }, 'Sessions'),
            React.createElement('span', null, String(counts.wecom)),
          )
        : null,
      proc
        ? React.createElement(
            'div',
            null,
            React.createElement('div', { className: 'wecom-panel-section' }, 'Process'),
            React.createElement(
              'div',
              { className: 'wecom-panel-row' },
              React.createElement('span', { className: 'wecom-panel-label' }, 'Memory'),
              React.createElement('span', null, formatBytes(proc.memoryRss)),
            ),
            React.createElement(
              'div',
              { className: 'wecom-panel-row' },
              React.createElement('span', { className: 'wecom-panel-label' }, 'Uptime'),
              React.createElement('span', null, formatUptime(proc.uptimeSec)),
            ),
            React.createElement(
              'div',
              { className: 'wecom-panel-row' },
              React.createElement('span', { className: 'wecom-panel-label' }, 'Load'),
              React.createElement('span', null, (proc.loadavg?.[0] ?? 0).toFixed(2)),
            ),
          )
        : null,
      rows,
      React.createElement(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        React.createElement(
          'button',
          { type: 'button', className: 'wecom-panel-btn', onClick: () => void poll() },
          'Refresh',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'wecom-panel-btn',
            onClick: () => void restart(),
            disabled: restarting,
          },
          restarting ? 'Restarting…' : 'Restart',
        ),
      ),
    )
  }

  // ── Bot manager: dock entry + floating panel ─────────────────────────────

  function BotIcon(props: { size?: number }): React.ReactNode {
    return React.createElement(
      'svg',
      {
        width: props.size ?? 16,
        height: props.size ?? 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      React.createElement('rect', { x: 3, y: 8, width: 18, height: 12, rx: 3 }),
      React.createElement('circle', { cx: 9, cy: 14, r: 1, fill: 'currentColor' }),
      React.createElement('circle', { cx: 15, cy: 14, r: 1, fill: 'currentColor' }),
      React.createElement('path', { d: 'M12 8V4' }),
      React.createElement('circle', { cx: 12, cy: 3, r: 1 }),
    )
  }

  function BotDockEntry(): React.ReactNode {
    useStore()
    const open = store.botsOpen
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-dsh-logo-dock-item': '',
        onClick: () => setBotsOpen(!open),
        'aria-pressed': open,
        style: open ? { background: 'rgba(51,112,255,.12)' } : undefined,
      },
      React.createElement(BotIcon, { size: 16 }),
      React.createElement('span', null, '企微机器人'),
    )
  }

  function BotCard(props: {
    bot: BotView
    presets: string[]
    onChanged: () => void
  }): React.ReactNode {
    const [name, setName] = React.useState(props.bot.workspaceTitle)
    const [preset, setPreset] = React.useState(props.bot.preset)
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState<string | null>(null)
    const save = async (): Promise<void> => {
      setBusy(true)
      setErr(null)
      try {
        const res = await fetch('/api/wecom/bots', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: props.bot.id, preset, workspaceTitle: name }),
        })
        if (!res.ok) {
          throw new Error(
            ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '保存失败',
          )
        }
        props.onChanged()
      } catch (e) {
        setErr(String(e))
      } finally {
        setBusy(false)
      }
    }
    const del = async (): Promise<void> => {
      setBusy(true)
      setErr(null)
      try {
        const res = await fetch(`/api/wecom/bots?id=${encodeURIComponent(props.bot.id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          throw new Error(
            ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '删除失败',
          )
        }
        props.onChanged()
      } catch (e) {
        setErr(String(e))
      } finally {
        setBusy(false)
      }
    }
    return React.createElement(
      'div',
      { className: 'wecom-mgr-card' },
      React.createElement(
        'div',
        { className: 'wecom-mgr-card-head' },
        React.createElement('input', {
          className: 'wecom-mgr-input',
          value: name,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
          'aria-label': 'name',
        }),
        React.createElement(
          'span',
          { className: 'wecom-mgr-badge' },
          props.bot.isDefault ? '默认' : props.bot.namespace,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'wecom-mgr-btn',
            'data-danger': 'true',
            disabled: busy || props.bot.isDefault,
            title: props.bot.isDefault ? '默认机器人不可删除' : '删除',
            onClick: () => void del(),
          },
          '删除',
        ),
      ),
      React.createElement(
        'div',
        { className: 'wecom-mgr-meta' },
        `id: ${props.bot.id} · credential: ${props.bot.credentialName}`,
      ),
      React.createElement(
        'div',
        { className: 'wecom-mgr-field' },
        React.createElement(
          'div',
          { className: 'wecom-mgr-label' },
          'preset（决定这个 bot 的 persona 与工具）',
        ),
        React.createElement(
          'select',
          {
            className: 'wecom-mgr-input',
            value: preset,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              setPreset(event.target.value),
          },
          props.presets.map((p) => React.createElement('option', { key: p, value: p }, p)),
        ),
      ),
      err !== null ? React.createElement('div', { className: 'wecom-mgr-error' }, err) : null,
      React.createElement(
        'div',
        { className: 'wecom-mgr-row', style: { justifyContent: 'flex-end' } },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'wecom-mgr-btn',
            disabled: busy,
            onClick: () => void save(),
          },
          busy ? '保存中…' : '保存',
        ),
      ),
    )
  }

  function AddBotForm(props: { presets: string[]; onChanged: () => void }): React.ReactNode {
    const [name, setName] = React.useState('')
    const [namespace, setNamespace] = React.useState('')
    const [preset, setPreset] = React.useState(props.presets[0] ?? 'standard')
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState<string | null>(null)
    const add = async (): Promise<void> => {
      setBusy(true)
      setErr(null)
      try {
        const res = await fetch('/api/wecom/bots', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ namespace, name, preset }),
        })
        if (!res.ok) {
          throw new Error(
            ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '新增失败',
          )
        }
        setName('')
        setNamespace('')
        props.onChanged()
      } catch (e) {
        setErr(String(e))
      } finally {
        setBusy(false)
      }
    }
    return React.createElement(
      'div',
      { className: 'wecom-mgr-card' },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '新增机器人'),
      React.createElement(
        'div',
        { className: 'wecom-mgr-field' },
        React.createElement(
          'div',
          { className: 'wecom-mgr-label' },
          '名字（替换工作区「WeCom」前缀）',
        ),
        React.createElement('input', {
          className: 'wecom-mgr-input',
          value: name,
          placeholder: '例如：客服助手',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        }),
      ),
      React.createElement(
        'div',
        { className: 'wecom-mgr-field' },
        React.createElement(
          'div',
          { className: 'wecom-mgr-label' },
          'namespace（唯一标识，小写字母/数字/-）',
        ),
        React.createElement('input', {
          className: 'wecom-mgr-input',
          value: namespace,
          placeholder: '例如：support',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setNamespace(event.target.value),
        }),
      ),
      React.createElement(
        'div',
        { className: 'wecom-mgr-field' },
        React.createElement('div', { className: 'wecom-mgr-label' }, 'preset'),
        React.createElement(
          'select',
          {
            className: 'wecom-mgr-input',
            value: preset,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              setPreset(event.target.value),
          },
          props.presets.map((p) => React.createElement('option', { key: p, value: p }, p)),
        ),
      ),
      err !== null ? React.createElement('div', { className: 'wecom-mgr-error' }, err) : null,
      React.createElement(
        'div',
        { className: 'wecom-mgr-row', style: { justifyContent: 'flex-end' } },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'wecom-mgr-btn',
            disabled: busy || name.trim() === '' || namespace.trim() === '',
            onClick: () => void add(),
          },
          busy ? '新增中…' : '新增',
        ),
      ),
    )
  }

  function BotsManagerPanel(): React.ReactNode {
    useStore()
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reload on open only
    React.useEffect(() => {
      if (store.botsOpen) void loadBots()
    }, [store.botsOpen])
    // biome-ignore lint/correctness/useExhaustiveDependencies: timer depends on the open gate
    React.useEffect(() => {
      if (timer === undefined || !store.botsOpen) return undefined
      return timer.interval(() => {
        void loadBots()
      }, 15_000)
    }, [store.botsOpen])
    if (!store.botsOpen) return null
    const data = store.botsData ?? { path: '', presets: [], bots: [], error: '加载中…' }
    return React.createElement(
      'div',
      { className: 'wecom-mgr-panel' },
      React.createElement(
        'div',
        { className: 'wecom-mgr-head' },
        React.createElement('span', null, '企微机器人'),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'wecom-panel-close',
            onClick: () => setBotsOpen(false),
            title: '关闭',
          },
          '×',
        ),
      ),
      React.createElement(
        'div',
        { className: 'wecom-mgr-hint' },
        data.path !== ''
          ? `落盘：${data.path}（更改需重启 dsh-web 生效）`
          : '更改需重启 dsh-web 生效',
      ),
      data.error !== undefined
        ? React.createElement('div', { className: 'wecom-mgr-error' }, data.error)
        : data.bots.map((bot) =>
            React.createElement(BotCard, {
              key: bot.id,
              bot,
              presets: data.presets,
              onChanged: () => void loadBots(),
            }),
          ),
      React.createElement(AddBotForm, { presets: data.presets, onChanged: () => void loadBots() }),
      React.createElement(
        'div',
        { className: 'wecom-mgr-row', style: { justifyContent: 'flex-end' } },
        React.createElement(
          'button',
          { type: 'button', className: 'wecom-mgr-btn', onClick: () => void loadBots() },
          '刷新',
        ),
      ),
    )
  }

  slots.inject('sidebar.footer.action', () =>
    slots.register({ name: 'sidebar.footer.action', id: 'wecom-status', order: 80 }, (props) =>
      React.createElement(FooterAction, { wide: props.wide === true }),
    ),
  )
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'wecom-status-panel', order: 50 }, () =>
      React.createElement(StatusPanel),
    ),
  )
  // WeCom bot manager: a dock entry below the skill center, opening a floating
  // panel that lists the deployment's dsh-wecom rows with per-bot preset and
  // workspace-name editing (write-back to cordis.patch.yml, restart to apply).
  slots.inject('sidebar.logo.dock', () =>
    slots.register(
      { name: 'sidebar.logo.dock', id: 'wecom-bots', order: 40, label: 'WeCom Bots' },
      () => React.createElement(BotDockEntry),
    ),
  )
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'wecom-bots-panel', order: 55 }, () =>
      React.createElement(BotsManagerPanel),
    ),
  )
}
