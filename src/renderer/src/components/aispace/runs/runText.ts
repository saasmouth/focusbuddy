// Plain-words formatting shared by the Runs list and the run inspector.
//
// Every free-text field that came from a provider or a run step goes through
// safeText() before it is shown: a key pasted into an instruction or echoed in
// an error must never reach the screen (SPEC-CONNECTIONS §6 "without secrets").

import type { RunSummary } from '@shared/aispace/api'
import type { RunStatus } from '@shared/aispace/model'
import { isTerminalRun } from '@shared/aispace/model'
import { payerLabel, redactSecrets } from '@shared/aispace/connections'
import { providerById } from '@shared/aispace/catalogue'
import { fmtAgo, fmtDuration, fmtWhen, statusInfo } from '../ui'

export function safeText(text: string | null | undefined): string {
  return text ? redactSecrets(text) : ''
}

export function providerName(providerId: string | null | undefined): string {
  if (!providerId) return 'Unknown provider'
  return providerById(providerId)?.name ?? providerId
}

// Where the provider says data goes when this connection is used.
export function providerDestination(providerId: string | null | undefined): string | null {
  return providerId ? providerById(providerId)?.dataDestination ?? null : null
}

export function modelLabel(providerId: string | null | undefined, model: string | null | undefined): string {
  if (!model) return 'No model'
  const m = providerId ? providerById(providerId)?.models.find((x) => x.id === model) : undefined
  return m?.label ?? model
}

// "Unknown payer" when nobody recorded who pays (Connections acceptance).
export function payerText(billedTo: string | null | undefined): string {
  return payerLabel({ billedTo: billedTo ?? null })
}

export function paidByLine(billedTo: string | null | undefined): string {
  const p = payerText(billedTo)
  return p === 'Unknown payer' ? p : `Paid by ${p}`
}

// Still going, or might be (an unobservable external run may still be running).
export function isActiveStatus(status: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting' || status === 'unavailable'
}

export function isTerminal(status: RunStatus): boolean {
  return isTerminalRun(status)
}

export function statusWord(status: RunStatus): string {
  return status === 'unavailable' ? 'status unavailable' : status
}

export function statusLabel(status: RunStatus): string {
  return statusInfo(status).label
}

// The time column: when it started (or was queued) and how long it took.
export function timing(r: Pick<RunSummary, 'createdAt' | 'startedAt' | 'endedAt'>, now = Date.now()): { primary: string; secondary: string | null; title: string } {
  const startedOrQueued = r.startedAt ?? r.createdAt
  const primary = r.startedAt ? `Started ${fmtAgo(r.startedAt, now)}` : `Queued ${fmtAgo(r.createdAt, now)}`
  const secondary = r.endedAt ? `Took ${fmtDuration(r.endedAt - startedOrQueued)}` : null
  const parts = [`${r.startedAt ? 'Started' : 'Queued'} ${fmtWhen(startedOrQueued)}`]
  if (r.endedAt) parts.push(`ended ${fmtWhen(r.endedAt)}`)
  return { primary, secondary, title: parts.join(', ') }
}

// The last step Plexii confirmed, for runs whose duration is uncertain (§5).
export function lastConfirmedLine(r: Pick<RunSummary, 'lastConfirmedStep' | 'lastConfirmedAt'>, now = Date.now()): string | null {
  const step = safeText(r.lastConfirmedStep).trim()
  if (!step) return null
  return r.lastConfirmedAt ? `Last confirmed: ${step} · ${fmtAgo(r.lastConfirmedAt, now)}` : `Last confirmed: ${step}`
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// Main's start-run style answer (retry, hand over): a new run, or a refusal
// with the reason and the checks that decided it.
export type RunStartAnswer =
  | { ok: true; runId: string; duplicate: boolean }
  | { ok: false; code: string; reason: string; checks: Array<{ name: string; ok: boolean; detail: string }> }

export function readStartAnswer(x: unknown): RunStartAnswer {
  const o = (x ?? {}) as Record<string, unknown>
  if (o.ok === true) {
    const run = (o.run ?? {}) as { id?: unknown }
    if (typeof run.id === 'string') return { ok: true, runId: run.id, duplicate: o.duplicate === true }
  }
  if (o.ok === false) {
    const checks = Array.isArray(o.checks)
      ? (o.checks as Array<Record<string, unknown>>).map((c) => ({ name: String(c.name ?? ''), ok: c.ok === true, detail: String(c.detail ?? '') }))
      : []
    return { ok: false, code: String(o.code ?? 'refused'), reason: String(o.reason ?? 'Plexii couldn’t start it.'), checks }
  }
  return { ok: false, code: 'unexpected', reason: 'Plexii got an answer it didn’t understand, so nothing is shown as started.', checks: [] }
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Electron prefixes IPC errors with the channel; the person needs the reason.
  return safeText(msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''))
}
