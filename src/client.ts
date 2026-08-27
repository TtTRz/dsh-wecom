import * as React from 'react'
import { createRoot } from 'react-dom/client'

/**
 * Browser half of dsh-wecom: a WeCom status action in the sidebar foot plus a
 * floating status panel over `shell.overlay`, and a WeCom-bot manager panel
 * rendered as a center-column takeover (the skill-center pattern) under the
 * dock's「企微机器人」entry. All read `GET /api/wecom/status` and
 * `/api/wecom/bots` served by the host half, so this plugin never touches
 * channel internals.
 *
 * The bundle is built to CommonJS and wrapped by `scripts/wrap-client.mjs`
 * into the factory form the web module loader executes.
 * @module dsh-wecom/client
 */

// ── Bot manager takeover state (module scope, mirrors the skill-center) ─────
const WM_PANEL_NAME = 'wecom-bots'
const WM_ACTIVE_ATTR = 'data-dsh-wecom-active'
const WM_VIEW_ATTR = 'data-dsh-wecom-view'
// Shared "one takeover panel at a time" bus; the skill center dispatches the
// same event so opening one closes the other.
const WM_PANEL_EVENT = 'dsh-panel-activate'

type WMListener = () => void
const wmListeners = new Set<WMListener>()
let wmActive = false
function wmIsActive(): boolean {
  return wmActive
}
function wmSetActive(next: boolean): void {
  if (wmActive === next) return
  wmActive = next
  if (next) {
    document.documentElement.setAttribute(WM_ACTIVE_ATTR, '')
    window.dispatchEvent(new CustomEvent(WM_PANEL_EVENT, { detail: { name: WM_PANEL_NAME } }))
  } else {
    document.documentElement.removeAttribute(WM_ACTIVE_ATTR)
  }
  for (const fn of [...wmListeners]) fn()
}
function wmSubscribe(l: WMListener): () => void {
  wmListeners.add(l)
  return () => {
    wmListeners.delete(l)
  }
}
function useLocalStore(subscribe: (l: () => void) => () => void, get: () => boolean): boolean {
  const [value, setValue] = React.useState(get)
  React.useEffect(() => subscribe(() => setValue(get())), [subscribe, get])
  return value
}

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
  // Bot manager takeover (center-column, skill-center pattern): hidden until
  // `html[data-dsh-wecom-active]`, and hides the other center-column children.
  `[${WM_VIEW_ATTR}]{display:none}`,
  `html[${WM_ACTIVE_ATTR}] [${WM_VIEW_ATTR}]{display:flex;flex-direction:column;position:fixed;top:0;bottom:0;right:0;z-index:60;overflow:auto;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);padding:20px 24px;box-sizing:border-box}`,
  `html[${WM_ACTIVE_ATTR}] [class*="centerCol"] > :not([${WM_VIEW_ATTR}]){display:none !important}`,
  '.wecom-mgr-inner{max-width:720px;margin:0 auto;width:100%}',
  '.wecom-mgr-head{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:2px}',
  '.wecom-mgr-hint{color:var(--dsw-alias-state-warn-primary);font-size:12px;margin:4px 0 10px}',
  '.wecom-mgr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px;margin:10px 0}',
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
  /** Whether the bottom-right status floating panel is open. */
  open: boolean
  status: StatusView | null
  /** Sibling bot list from the primary payload; empty when single-bot. */
  bots: InstanceView[]
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
  /** Whether a channel service for this namespace is live in the process. */
  live?: boolean
  connected?: boolean
  conversations?: number
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

  const store: Store = { open: false, status: null, bots: [], botsData: null }
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
    const open = useLocalStore(wmSubscribe, wmIsActive)
    return React.createElement(
      'button',
      {
        type: 'button',
        'data-dsh-logo-dock-item': '',
        onClick: () => wmSetActive(!open),
        'aria-pressed': open,
        style: open ? { background: 'rgba(51,112,255,.12)' } : undefined,
      },
      React.createElement(BotIcon, { size: 16 }),
      React.createElement('span', null, '企微机器人'),
    )
  }
  // ── Bot manager: one card per bot (task-runner styling) ───────────────────
  const v = {
    labelPrimary: 'var(--dsw-alias-label-primary, #1f2329)',
    labelSecondary: 'var(--dsw-alias-label-secondary, #646a73)',
    labelTertiary: 'var(--dsw-alias-label-tertiary, #8f959e)',
    labelError: 'var(--dsw-alias-label-error, #d83931)',
    borderL1: 'var(--dsw-alias-border-l1, #dee0e3)',
    borderL2: 'var(--dsw-alias-border-l2, #dee0e3)',
    bgBase: 'var(--dsw-alias-bg-base, #ffffff)',
    bgLayer1: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
    bgLayer2: 'var(--dsw-alias-bg-layer-2, #f5f6f7)',
    brand: 'var(--dsw-alias-state-business-primary, #3370ff)',
    ok: 'var(--dsw-alias-state-success-primary, #00b42a)',
  }

  function BotModal(props: {
    mode: 'create' | 'edit'
    bot?: BotView
    presets: string[]
    onClose: () => void
    onSaved: () => void
  }): React.ReactNode {
    const isEdit = props.mode === 'edit'
    const [name, setName] = React.useState(props.bot?.workspaceTitle ?? '')
    const [namespace, setNamespace] = React.useState(props.bot?.namespace ?? '')
    const [preset, setPreset] = React.useState(props.bot?.preset ?? props.presets[0] ?? 'standard')
    const [busy, setBusy] = React.useState(false)
    const [err, setErr] = React.useState<string | null>(null)
    const save = async (): Promise<void> => {
      setBusy(true)
      setErr(null)
      try {
        const method = isEdit ? 'PUT' : 'POST'
        const body = isEdit
          ? { id: props.bot?.id, preset, workspaceTitle: name, namespace }
          : { namespace, name, preset }
        const res = await fetch('/api/wecom/bots', {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          throw new Error(
            ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '保存失败',
          )
        }
        props.onSaved()
      } catch (e) {
        setErr(String(e))
      } finally {
        setBusy(false)
      }
    }
    const fieldLabel = (text: string): React.ReactNode =>
      React.createElement(
        'label',
        {
          style: {
            display: 'block',
            fontSize: '12px',
            color: v.labelSecondary,
            marginBottom: '4px',
          },
        },
        text,
      )
    const input = (
      value: string,
      onChange: (next: string) => void,
      placeholder?: string,
    ): React.ReactNode =>
      React.createElement('input', {
        value,
        placeholder,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
        style: {
          width: '100%',
          boxSizing: 'border-box',
          background: v.bgBase,
          border: `1px solid ${v.borderL1}`,
          borderRadius: '6px',
          padding: '7px 10px',
          fontSize: '13px',
          color: v.labelPrimary,
          outline: 'none',
          fontFamily: 'inherit',
        },
      })
    return React.createElement(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 70,
          background: 'rgba(0,0,0,.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        },
        onClick: props.onClose,
      },
      React.createElement(
        'div',
        {
          onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
          style: {
            background: v.bgLayer2,
            border: `1px solid ${v.borderL1}`,
            borderRadius: '12px',
            boxShadow: '0 12px 32px rgba(0,0,0,.18)',
            width: '100%',
            maxWidth: '520px',
            maxHeight: '86vh',
            overflow: 'auto',
            padding: '20px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          React.createElement(
            'h3',
            { style: { margin: 0, fontSize: '15px', fontWeight: 600, color: v.labelPrimary } },
            isEdit ? '编辑机器人' : '新建机器人',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: props.onClose,
              style: {
                marginLeft: 'auto',
                border: 'none',
                background: 'transparent',
                color: v.labelTertiary,
                cursor: 'pointer',
                fontSize: '18px',
                lineHeight: 1,
                padding: '2px 6px',
                flex: 'none',
              },
            },
            '×',
          ),
        ),
        React.createElement(
          'div',
          null,
          fieldLabel('名字（替换工作区「WeCom」前缀）'),
          input(name, setName),
        ),
        React.createElement(
          'div',
          null,
          fieldLabel('namespace（唯一标识，小写字母/数字/-）'),
          input(namespace, setNamespace, '例如：support'),
          isEdit
            ? React.createElement(
                'div',
                {
                  style: {
                    marginTop: '4px',
                    fontSize: '11px',
                    color: v.labelTertiary,
                    lineHeight: 1.5,
                  },
                },
                '改 namespace 会重排会话 id / 路由 / 状态文件，已有会话将不再归属此 bot，需重启生效。',
              )
            : null,
        ),
        React.createElement(
          'div',
          null,
          fieldLabel('preset（决定这个 bot 的 persona 与工具）'),
          React.createElement(
            'select',
            {
              value: preset,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                setPreset(event.target.value),
              style: {
                width: '100%',
                boxSizing: 'border-box',
                background: v.bgBase,
                border: `1px solid ${v.borderL1}`,
                borderRadius: '6px',
                padding: '7px 10px',
                fontSize: '13px',
                color: v.labelPrimary,
                fontFamily: 'inherit',
              },
            },
            props.presets.map((p) => React.createElement('option', { key: p, value: p }, p)),
          ),
        ),
        err !== null
          ? React.createElement(
              'div',
              { style: { fontSize: '12px', color: v.labelError, wordBreak: 'break-word' } },
              err,
            )
          : null,
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              borderTop: `1px solid ${v.borderL1}`,
              paddingTop: '12px',
            },
          },
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: props.onClose,
              style: {
                border: `1px solid ${v.borderL1}`,
                background: 'transparent',
                color: v.labelPrimary,
                borderRadius: '6px',
                padding: '6px 14px',
                cursor: 'pointer',
                fontSize: '13px',
              },
            },
            '取消',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy || name.trim() === '' || (!isEdit && namespace.trim() === ''),
              onClick: () => void save(),
              style: {
                border: 'none',
                background:
                  busy || name.trim() === '' || (!isEdit && namespace.trim() === '')
                    ? v.bgLayer1
                    : v.brand,
                color:
                  busy || name.trim() === '' || (!isEdit && namespace.trim() === '')
                    ? v.labelTertiary
                    : '#fff',
                borderRadius: '6px',
                padding: '6px 14px',
                cursor: 'pointer',
                fontSize: '13px',
              },
            },
            busy ? '保存中…' : '保存',
          ),
        ),
      ),
    )
  }

  function renderBotCard(
    bot: BotView,
    presets: string[],
    deps: {
      editing: string | null
      setEditing: (id: string | null) => void
      busy: string | null
      onDelete: (id: string) => void
      onChanged: () => void
    },
  ): React.ReactNode {
    const live = bot.live === true
    // When the host hasn't been restarted to enrich the list (live ===
    // undefined), avoid the misleading「未挂载」— stay neutral until real state
    // arrives.
    const statusKnown = bot.live !== undefined
    const connected = live && bot.connected === true
    const statusText = statusKnown ? (connected ? '已连接' : live ? '未连接' : '未挂载') : ''
    const statusColor = connected ? v.ok : live ? v.labelSecondary : v.labelTertiary
    const dotColor = connected
      ? v.ok
      : live
        ? 'var(--dsw-alias-state-warn-primary, #ff7d00)'
        : v.labelTertiary
    return React.createElement(
      'div',
      {
        key: bot.id,
        style: {
          border: `1px solid ${v.borderL1}`,
          borderRadius: '10px',
          background: v.bgBase,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          overflow: 'hidden',
          boxShadow: '0 1px 2px rgba(0,0,0,.04)',
        },
      },
      // ── Row 1: status dot + name + pill + actions (all inline, compact) ──
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px' } },
        React.createElement('span', {
          className: 'wecom-dot',
          style: { background: dotColor, width: '8px', height: '8px' },
          title: statusText,
        }),
        React.createElement(
          'span',
          {
            style: {
              fontWeight: 600,
              fontSize: '14px',
              color: v.labelPrimary,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.4,
              flex: 1,
            },
          },
          bot.workspaceTitle,
        ),
        statusText !== ''
          ? React.createElement(
              'span',
              {
                style: { flex: 'none', fontSize: '11px', color: statusColor, whiteSpace: 'nowrap' },
              },
              statusText,
            )
          : null,
        bot.isDefault
          ? React.createElement(
              'span',
              {
                style: {
                  flex: 'none',
                  fontSize: '11px',
                  color: v.brand,
                  background: 'rgba(51,112,255,.1)',
                  border: '1px solid rgba(51,112,255,.3)',
                  borderRadius: '999px',
                  padding: '1px 8px',
                  whiteSpace: 'nowrap',
                },
              },
              '默认',
            )
          : null,
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => deps.setEditing(bot.id),
            style: {
              flex: 'none',
              border: `1px solid ${v.borderL1}`,
              background: 'transparent',
              color: v.labelPrimary,
              borderRadius: '6px',
              padding: '3px 10px',
              cursor: 'pointer',
              fontSize: '12px',
            },
          },
          '编辑',
        ),
        bot.isDefault
          ? null
          : React.createElement(
              'button',
              {
                type: 'button',
                disabled: deps.busy === bot.id,
                onClick: () => deps.onDelete(bot.id),
                style: {
                  flex: 'none',
                  border: `1px solid ${v.borderL1}`,
                  background: 'transparent',
                  color: v.labelError,
                  borderRadius: '6px',
                  padding: '3px 10px',
                  cursor: 'pointer',
                  fontSize: '12px',
                },
              },
              deps.busy === bot.id ? '删除中…' : '删除',
            ),
      ),
      // ── Row 2: preset + conversations + id (single compact line) ──
      React.createElement(
        'div',
        {
          style: {
            padding: '0 14px 10px',
            fontSize: '12px',
            color: v.labelTertiary,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          },
        },
        React.createElement(
          'span',
          {
            style: {
              flex: 'none',
              fontWeight: 600,
              color: v.labelSecondary,
            },
          },
          `preset: ${bot.preset}`,
        ),
        React.createElement('span', null, '·'),
        React.createElement('span', null, `${bot.conversations ?? 0} 会话`),
        React.createElement('span', null, '·'),
        React.createElement(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
          bot.id,
        ),
      ),
    )
  }

  function BotsManagerPanel(): React.ReactNode {
    // The store subscription re-renders when botsData changes (the list), and
    // the wm subscription re-renders when the panel opens/closes. Both are
    // needed: without the store one the first open stays on「加载中」.
    useStore()
    useLocalStore(wmSubscribe, wmIsActive)
    const [editing, setEditing] = React.useState<string | null>(null)
    const [creating, setCreating] = React.useState(false)
    const [busy, setBusy] = React.useState<string | null>(null)
    const [panelErr, setPanelErr] = React.useState<string | null>(null)
    const active = wmIsActive()
    React.useEffect(() => {
      if (active) void loadBots()
    }, [active])
    React.useEffect(() => {
      if (timer === undefined || !active) return undefined
      return timer.interval(() => {
        void loadBots()
      }, 15_000)
    }, [active])
    const data = store.botsData ?? { path: '', presets: [], bots: [], error: '加载中…' }
    const onChanged = (): void => {
      setPanelErr(null)
      void loadBots()
    }
    const del = async (id: string): Promise<void> => {
      setBusy(id)
      setPanelErr(null)
      try {
        const res = await fetch(`/api/wecom/bots?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          throw new Error(
            ((await res.json().catch(() => ({}))) as { error?: string }).error ?? '删除失败',
          )
        }
        onChanged()
      } catch (e) {
        setPanelErr(String(e))
      } finally {
        setBusy(null)
      }
    }
    const cards = data.bots.map((bot) =>
      renderBotCard(bot, data.presets, {
        editing,
        setEditing,
        busy,
        onDelete: (id) => void del(id),
        onChanged,
      }),
    )
    const editingBot = editing !== null ? data.bots.find((b) => b.id === editing) : undefined
    const modal =
      creating === true
        ? React.createElement(BotModal, {
            mode: 'create',
            presets: data.presets,
            onClose: () => setCreating(false),
            onSaved: () => {
              setCreating(false)
              onChanged()
            },
          })
        : editingBot !== undefined
          ? React.createElement(BotModal, {
              mode: 'edit',
              bot: editingBot,
              presets: data.presets,
              onClose: () => setEditing(null),
              onSaved: () => {
                setEditing(null)
                onChanged()
              },
            })
          : null
    return React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          padding: '16px 24px 40px',
          width: '100%',
          boxSizing: 'border-box',
          minWidth: 0,
        },
      },
      React.createElement(
        'header',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            paddingBottom: '12px',
            borderBottom: `1px solid ${v.borderL1}`,
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => wmSetActive(false),
            style: {
              border: `1px solid ${v.borderL1}`,
              background: 'transparent',
              color: v.labelPrimary,
              borderRadius: '6px',
              padding: '4px 12px',
              cursor: 'pointer',
              fontSize: '12px',
              flex: 'none',
            },
          },
          '← 返回',
        ),
        React.createElement(
          'h2',
          {
            style: {
              margin: 0,
              fontSize: '15px',
              fontWeight: 600,
              color: v.labelPrimary,
              flex: 'none',
            },
          },
          '企微机器人',
        ),
        React.createElement(
          'span',
          {
            style: {
              marginLeft: 'auto',
              fontSize: '12px',
              color: v.labelTertiary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          data.path !== '' ? '更改需重启 dsh-web 生效' : '',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setCreating(true),
            style: {
              flex: 'none',
              border: 'none',
              background: v.brand,
              color: '#fff',
              borderRadius: '6px',
              padding: '5px 14px',
              cursor: 'pointer',
              fontSize: '12px',
            },
          },
          '新建机器人',
        ),
      ),
      data.error !== undefined
        ? React.createElement(
            'div',
            { style: { fontSize: '12px', color: v.labelError, wordBreak: 'break-word' } },
            data.error,
          )
        : null,
      panelErr !== null
        ? React.createElement(
            'div',
            { style: { fontSize: '12px', color: v.labelError, wordBreak: 'break-word' } },
            panelErr,
          )
        : null,
      cards.length === 0 && data.error === undefined
        ? React.createElement(
            'div',
            { style: { fontSize: '13px', color: v.labelTertiary, padding: '8px 0' } },
            '暂无机器人',
          )
        : cards,
      modal,
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
  // WeCom bot manager: a dock entry below the skill center opening a
  // center-column takeover panel (skill-center pattern) that lists the
  // deployment's dsh-wecom rows with per-bot preset and workspace-name editing
  // (write-back to cordis.patch.yml, restart to apply).
  slots.inject('sidebar.logo.dock', () =>
    slots.register(
      { name: 'sidebar.logo.dock', id: 'wecom-bots', order: 40, label: 'WeCom Bots' },
      () => React.createElement(BotDockEntry),
    ),
  )
  installWecomBots(ctx)

  function installWecomBots(context: typeof ctx): void {
    context.effect(() => {
      const onPanelEvent = (event: Event): void => {
        const detail = (event as CustomEvent<{ name?: string }>).detail
        if (detail !== null && detail !== undefined && detail.name !== WM_PANEL_NAME)
          wmSetActive(false)
      }
      window.addEventListener(WM_PANEL_EVENT, onPanelEvent)

      // Clicking anywhere in the sidebar (outside the dock rows) closes the
      // takeover panel — selecting a session ends the overlay.
      const onSidebarClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null
        if (target === null) return
        if (target.closest('[class*="sidebarCol"]') === null) return
        if (target.closest('[data-dsh-logo-dock]') !== null) return
        wmSetActive(false)
      }
      document.addEventListener('click', onSidebarClick, { capture: true })

      let container: HTMLDivElement | null = null
      let root: ReturnType<typeof createRoot> | null = null
      let rafId = 0
      let stopped = false
      const ensure = (): void => {
        const center = document.querySelector<HTMLElement>('[class*="centerCol"]')
        if (center === null) return
        if (container === null) {
          container = document.createElement('div')
          container.setAttribute(WM_VIEW_ATTR, '')
        }
        if (container.parentNode !== center) center.appendChild(container)
        const sidebar = document.querySelector<HTMLElement>('[class*="sidebarCol"]')
        if (sidebar !== null) {
          const right = Math.round(sidebar.getBoundingClientRect().right)
          if (container.style.left !== `${right}px`) container.style.left = `${right}px`
        }
        if (root === null) {
          root = createRoot(container)
          root.render(React.createElement(BotsManagerPanel))
        }
      }
      const tick = (): void => {
        if (stopped) return
        ensure()
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
      return () => {
        stopped = true
        cancelAnimationFrame(rafId)
        window.removeEventListener(WM_PANEL_EVENT, onPanelEvent)
        document.removeEventListener('click', onSidebarClick, true)
        root?.unmount()
        if (container !== null && container.parentNode !== null)
          container.parentNode.removeChild(container)
        wmSetActive(false)
      }
    }, 'dsh-wecom.bots-manager')
  }
}
