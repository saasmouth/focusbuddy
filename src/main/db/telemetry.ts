// Local usage telemetry. Reads aggregate counts from this machine's database
// (widgets by kind, tasks, folders, focus minutes) plus a cumulative AI-call
// counter, and shapes them into a snapshot the renderer reports to the signal
// server. Aggregate numbers only, never titles or content.

import { getDb } from './database'
import { estimateCostMicros } from '../ai/aiCost'

export interface TelemetrySnapshot {
  appVersion: string
  platform: string
  widgetTotal: number
  widgetsByKind: Record<string, number>
  taskCount: number
  folderCount: number
  focusSessions: number
  focusMinutes: number
  aiCalls: number
  // Real cumulative token usage from the model API, plus an estimated dollar
  // spend at the rates in ai/aiCost. Tokens are exact; cost is an estimate.
  aiInputTokens: number
  aiOutputTokens: number
  aiEstCostUsd: number
  // Onboarding progress, so the admin can see per-user whether someone completed
  // the first-run flow and how many tours they finished. Aggregate flags only.
  onboardingCoreCompleted: boolean
  onboardingModules: number
}

function bumpCounter(key: string, n: number): void {
  if (!n) return
  getDb()
    .prepare(
      `INSERT INTO usage_counters (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + ?`
    )
    .run(key, n, n)
}

// Record REAL token usage from one model response, plus its estimated cost.
// `inputTokens` is the uncached input (Anthropic's `input_tokens`, i.e. tokens
// after the last cache breakpoint). Cache reads/writes are billed at different
// rates (reads ~0.1x, 5-minute writes ~1.25x of base input), so they are counted
// separately and priced accordingly — the cost estimate reflects the caching
// saving rather than pretending every token was full price. Never throws.
export function recordAiUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): void {
  try {
    const inp = Math.max(0, Math.round(inputTokens || 0))
    const out = Math.max(0, Math.round(outputTokens || 0))
    const cr = Math.max(0, Math.round(cacheReadTokens || 0))
    const cw = Math.max(0, Math.round(cacheWriteTokens || 0))
    bumpCounter('ai_input_tokens', inp)
    bumpCounter('ai_output_tokens', out)
    bumpCounter('ai_cache_read_tokens', cr)
    bumpCounter('ai_cache_write_tokens', cw)
    let micros = estimateCostMicros(model, inp, out)
    if (cr) micros += Math.round(estimateCostMicros(model, cr, 0) * 0.1)
    if (cw) micros += Math.round(estimateCostMicros(model, cw, 0) * 1.25)
    bumpCounter('ai_cost_micros', micros)
  } catch {
    // swallow
  }
}

// Increment the cumulative AI-call counter. Called whenever the app makes a
// model request, so usage reflects real activity rather than an estimate.
export function recordAiCall(n = 1): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO usage_counters (key, value) VALUES ('ai_calls', ?)
         ON CONFLICT(key) DO UPDATE SET value = value + ?`
      )
      .run(n, n)
  } catch {
    // Telemetry must never break a real feature; swallow.
  }
}

// Overwrite (not increment) an onboarding summary counter. Called from the
// renderer via IPC when a module completes/skips, so the value rides the next
// telemetry snapshot up to the admin. Never throws.
export function setOnboardingSummary(summary: { coreCompleted: boolean; modulesCompleted: number }): void {
  try {
    const db = getDb()
    const put = db.prepare(
      `INSERT INTO usage_counters (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    put.run('onboarding_core', summary.coreCompleted ? 1 : 0)
    put.run('onboarding_modules', Math.max(0, Math.round(summary.modulesCompleted || 0)))
  } catch {
    // swallow — telemetry must never break a feature
  }
}

function counter(key: string): number {
  try {
    const row = getDb().prepare('SELECT value FROM usage_counters WHERE key = ?').get(key) as
      | { value: number }
      | undefined
    return row?.value ?? 0
  } catch {
    return 0
  }
}

export function collectTelemetry(): TelemetrySnapshot {
  const db = getDb()
  const widgetsByKind: Record<string, number> = {}
  let widgetTotal = 0
  let taskCount = 0
  let folderCount = 0
  let focusSessions = 0
  let focusMinutes = 0
  try {
    const rows = db.prepare('SELECT kind, COUNT(*) AS c FROM widgets GROUP BY kind').all() as Array<{
      kind: string
      c: number
    }>
    for (const r of rows) {
      widgetsByKind[r.kind] = r.c
      widgetTotal += r.c
    }
    const nodeRows = db.prepare('SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind').all() as Array<{
      kind: string
      c: number
    }>
    for (const r of nodeRows) {
      if (r.kind === 'task') taskCount = r.c
      else if (r.kind === 'folder') folderCount = r.c
    }
    const focus = db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(actual_seconds), 0) AS seconds
         FROM focus_sessions WHERE completed_at IS NOT NULL`
      )
      .get() as { sessions: number; seconds: number }
    focusSessions = focus.sessions
    focusMinutes = Math.round(focus.seconds / 60)
  } catch {
    // partial DB; report whatever we could read
  }

  return {
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
    platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : process.platform,
    widgetTotal,
    widgetsByKind,
    taskCount,
    folderCount,
    focusSessions,
    focusMinutes,
    aiCalls: counter('ai_calls'),
    aiInputTokens: counter('ai_input_tokens'),
    aiOutputTokens: counter('ai_output_tokens'),
    aiEstCostUsd: Math.round((counter('ai_cost_micros') / 1e6) * 100) / 100,
    onboardingCoreCompleted: counter('onboarding_core') >= 1,
    onboardingModules: counter('onboarding_modules')
  }
}
