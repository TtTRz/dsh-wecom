import * as React from 'react'

/**
 * Browser half of dsh-wecom (legacy helpers).
 *
 * Since dsh-wecom-console took over the web UI (status panel + bot manager),
 * this half ships only the pure formatting helpers that tests cover. No slot
 * registration — everything the browser renders for a WeCom fleet now lives in
 * `dsh-wecom-console`, so no single dsh-wecom bot is privileged as a console
 * host.
 * @module dsh-wecom/client
 */

/** Whole-megabyte memory rendering. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** "3m ago"-style duration from an epoch-delta in milliseconds. */
export function formatAgo(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 60 * 1000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / (60 * 1000))}m ago`
  return `${Math.floor(ms / (60 * 60 * 1000))}h ago`
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

export const inject: string[] = []

/** Browser half is a no-op (the console owns the UI). */
export function apply(): void {}
