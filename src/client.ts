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

/** Wire shape of `GET /api/wecom/status` (unknown when the host is down). */
interface StatusView {
  available?: boolean
  connected?: boolean
  stopping?: boolean
  conversations?: number
  authenticatedAgoMs?: number | null
  lastError?: string | null
  agents?: Array<{
    sessionId: string
    status: string
    model: string
    wecom: boolean
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

/** Compact row label for one live agent. */
export function agentLabel(agent: { sessionId: string; wecom: boolean }): string {
  if (agent.wecom) {
    const parts = agent.sessionId.split('-')
    const scope = parts[2] ?? 'chat'
    return `WeCom · ${scope}`
  }
  return `Web · ${agent.sessionId.slice(-6)}`
}

const CSS = [
  '.wecom-nav-btn{display:flex;align-items:center;gap:6px;cursor:pointer;background:transparent;border:none;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-radius:8px;font-size:13px}',
  '.wecom-nav-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
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

  const store: Store = { open: false, status: null }
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
      setStatus((await response.json()) as StatusView)
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
    return React.createElement(
      'button',
      {
        type: 'button',
        className: 'wecom-nav-btn',
        title: connected ? 'WeCom bot connected' : 'WeCom bot status',
        onClick: () => setOpen(!store.open),
      },
      React.createElement('span', { className: 'wecom-dot', style: { background: color } }),
      props.wide === true ? 'WeCom' : null,
    )
  }

  function StatusPanel(): React.ReactNode {
    useStore()
    const [restarting, setRestarting] = React.useState(false)
    const restart = async (): Promise<void> => {
      setRestarting(true)
      try {
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
    const connected = status.available === true && status.connected === true
    const dotColor = connected
      ? 'var(--dsw-alias-state-success-primary)'
      : 'var(--dsw-alias-state-warn-primary)'
    const connectionText =
      status.available !== true
        ? 'Unavailable'
        : status.stopping === true
          ? 'Stopping'
          : connected
            ? 'Connected'
            : 'Disconnected'
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
    const agents = status.agents ?? []
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

    return React.createElement(
      'div',
      { className: 'wecom-panel' },
      React.createElement(
        'div',
        { className: 'wecom-panel-head' },
        React.createElement('span', null, 'WeCom Bot'),
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
      React.createElement(
        'div',
        { className: 'wecom-panel-row' },
        React.createElement('span', { className: 'wecom-panel-label' }, 'Connection'),
        React.createElement(
          'span',
          null,
          React.createElement('span', { className: 'wecom-dot', style: { background: dotColor } }),
          ` ${connectionText}`,
        ),
      ),
      React.createElement(
        'div',
        { className: 'wecom-panel-row' },
        React.createElement('span', { className: 'wecom-panel-label' }, 'Conversations'),
        React.createElement(
          'span',
          null,
          status.available === true ? String(status.conversations) : '—',
        ),
      ),
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
            React.createElement('span', null, `${counts.wecom} WeCom · ${counts.total} total`),
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
