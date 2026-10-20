import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import { listTables, getTable, listRows } from './tables'
import { sendChat } from '../ai/anthropic'
import { advanceSchedule } from '@shared/schedule'
import type {
  ReportDef,
  ReportDraft,
  ReportPatch,
  ReportSchedule,
  GenerateReportResult
} from '@shared/reports'

// PlexiReports store. A report is a saved selection of tables plus a schedule and
// recipients. Generating one reads the real table data, builds an honest data
// summary, and (when an Anthropic key is set) asks the model to narrate it. With
// no key it saves the data summary itself and marks lastOutputIsAi false, so a
// deterministic summary is never presented as a written narrative. Delivery and
// scheduling are driven from the renderer over the existing mail and timer paths.

interface ReportRow {
  id: string
  title: string
  source_table_ids: string
  schedule: string
  recipients: string
  last_run_at: number | null
  last_output: string | null
  last_output_is_ai: number
  next_run_at: number | null
  created_at: number
  updated_at: number
}

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as string[]) : []
  } catch {
    return []
  }
}

function rowToReport(r: ReportRow): ReportDef {
  return {
    id: r.id,
    title: r.title,
    sourceTableIds: parseList(r.source_table_ids),
    schedule: r.schedule as ReportSchedule,
    recipients: parseList(r.recipients),
    lastRunAt: r.last_run_at,
    lastOutput: r.last_output,
    lastOutputIsAi: r.last_output_is_ai === 1,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listReports(): ReportDef[] {
  const db = getDb()
  return (
    db.prepare('SELECT * FROM fb_reports WHERE org_id = ? ORDER BY updated_at DESC').all(getActiveOrgId()) as ReportRow[]
  ).map(rowToReport)
}

export function getReport(id: string): ReportDef | null {
  const db = getDb()
  const r = db.prepare('SELECT * FROM fb_reports WHERE id = ?').get(id) as ReportRow | undefined
  return r ? rowToReport(r) : null
}

export function createReport(draft: ReportDraft): ReportDef {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO fb_reports (id, title, source_table_ids, schedule, recipients, last_output_is_ai, created_at, updated_at, org_id)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    draft.title || 'Untitled report',
    JSON.stringify(draft.sourceTableIds ?? []),
    draft.schedule ?? 'manual',
    JSON.stringify(draft.recipients ?? []),
    now,
    now,
    getActiveOrgId()
  )
  return getReport(id)!
}

export function updateReport(id: string, patch: ReportPatch): ReportDef | null {
  const db = getDb()
  const sets: string[] = []
  const vals: Array<string | number> = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.sourceTableIds !== undefined) {
    sets.push('source_table_ids = ?')
    vals.push(JSON.stringify(patch.sourceTableIds))
  }
  if (patch.schedule !== undefined) {
    sets.push('schedule = ?')
    vals.push(patch.schedule)
  }
  if (patch.recipients !== undefined) {
    sets.push('recipients = ?')
    vals.push(JSON.stringify(patch.recipients))
  }
  if (sets.length === 0) return getReport(id)
  sets.push('updated_at = ?')
  vals.push(Date.now())
  vals.push(id)
  db.prepare(`UPDATE fb_reports SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getReport(id)
}

export function deleteReport(id: string): boolean {
  const db = getDb()
  return db.prepare('DELETE FROM fb_reports WHERE id = ?').run(id).changes > 0
}

// Build an honest, real data summary in Markdown from the chosen tables. This is
// the grounding for the AI narrative and the fallback output when there is no
// key. Numbers come straight from the rows; nothing is estimated.
function buildDataSummary(rawTableIds: string[]): string {
  // De-duplicate so a table chosen twice does not double-count or render twice,
  // and so the "N of M no longer exist" line stays accurate.
  const tableIds = Array.from(new Set(rawTableIds))
  const usingSelection = tableIds.length > 0
  const tables = usingSelection
    ? tableIds.map((id) => getTable(id)).filter((t): t is NonNullable<typeof t> => t !== null)
    : listTables()
  // Be honest when selected tables have since been deleted: say so rather than
  // narrate a smaller set as if it were the whole report.
  const missing = usingSelection ? tableIds.length - tables.length : 0
  if (tables.length === 0) {
    return usingSelection
      ? 'Every table this report was built on has since been deleted, so there is no data to report on.'
      : 'No tables exist yet, so there is no data to report on.'
  }
  const parts: string[] = []
  if (missing > 0) parts.push(`${missing} of the ${tableIds.length} selected tables no longer exist and were skipped.`, '')
  for (const t of tables) {
    const rows = listRows(t.id)
    const cols = t.schema.columns
    parts.push(`## ${t.title || 'Untitled table'}`)
    parts.push(`${rows.length} row${rows.length === 1 ? '' : 's'}, ${cols.length} column${cols.length === 1 ? '' : 's'}.`)
    if (cols.length) parts.push(`Columns: ${cols.map((c) => c.label || c.id).join(', ')}.`)
    // Per single-select column, a real value breakdown so the summary carries
    // signal, not just counts.
    for (const c of cols) {
      if (c.type !== 'single-select') continue
      const counts = new Map<string, number>()
      for (const r of rows) {
        const v = r.cells[c.id]
        if (typeof v === 'string' && v) counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      if (counts.size) {
        const breakdown = [...counts.entries()].map(([k, n]) => `${k}: ${n}`).join(', ')
        parts.push(`By ${c.label || c.id}: ${breakdown}.`)
      }
    }
    parts.push('')
  }
  return parts.join('\n')
}

export function computeNextRun(schedule: ReportSchedule, fromMs: number): number | null {
  if (schedule === 'manual') return null
  return advanceSchedule(schedule, fromMs)
}

// Generate the report now: build the data summary, narrate it with the model when
// a key is set, otherwise keep the summary and flag it as not-AI. Persists the
// output and advances the schedule.
export async function generateReport(id: string): Promise<GenerateReportResult> {
  const report = getReport(id)
  if (!report) return { ok: false, output: 'Report not found.', isAi: false }
  const summary = buildDataSummary(report.sourceTableIds)

  let output = summary
  let isAi = false
  let needsApiKey = false

  const prompt =
    `Write a concise executive report titled "${report.title}" based only on the real workspace data below. ` +
    `Summarise the current state and call out anything notable in two to four short paragraphs. ` +
    `Do not invent any numbers or facts beyond what the data shows.\n\n${summary}`
  // The model call is best-effort: any failure falls back to the honest data
  // summary, marked not-AI, rather than throwing and leaving the report unwritten.
  try {
    const res = await sendChat({
      taskId: null,
      messages: [{ role: 'user', content: prompt, ts: Date.now() }],
      // Scheduled runs never search the web: that would send the prompt to
      // DuckDuckGo with nobody at the keyboard (webSearchOptIn.ts).
      webSearch: false
    })
    if (res.ok && res.message?.content) {
      output = res.message.content
      isAi = true
    } else if (res.needsApiKey) {
      needsApiKey = true
    }
  } catch {
    // Keep the data summary; isAi stays false so it is never shown as a narrative.
  }

  const now = Date.now()
  const db = getDb()
  db.prepare(
    'UPDATE fb_reports SET last_output = ?, last_output_is_ai = ?, last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
  ).run(output, isAi ? 1 : 0, now, computeNextRun(report.schedule, now), now, id)

  return { ok: true, output, isAi, needsApiKey }
}

// Reports whose schedule has come due. The renderer ticks this and generates each.
export function listDueReports(nowMs = Date.now()): ReportDef[] {
  return listReports().filter((r) => r.schedule !== 'manual' && r.nextRunAt != null && r.nextRunAt <= nowMs)
}

// Generate every due report. Returns how many ran, for an honest "N generated"
// message. Never invents a run: a report with no schedule is skipped.
export async function runDueReports(nowMs = Date.now()): Promise<{ generated: number; failed: number }> {
  const due = listDueReports(nowMs)
  let generated = 0
  let failed = 0
  // Guard each report so one failure does not abort the rest of the batch, and
  // report a real count rather than assuming every due report succeeded.
  for (const r of due) {
    try {
      const res = await generateReport(r.id)
      if (res.ok) generated++
      else failed++
    } catch {
      failed++
    }
  }
  return { generated, failed }
}
