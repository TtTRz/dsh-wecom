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
    options: { name: string; id: string; order?: number },
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
].join('')

interface Store {
  open: boolean
  status: StatusView | null
  /** Sibling bot list from the primary payload; empty when single-bot. */
  bots: InstanceView[]
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

  const store: Store = { open: false, status: null, bots: [] }
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
      const color = available !== true
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
      pushBot(
        bot.id,
        bot.available,
        bot.connected,
        bot.conversations,
        bot.lastError,
      )
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
}
