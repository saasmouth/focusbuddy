// Turning what a browsing run found into something you can actually use.
//
// The findings are ALREADY structured — a list of field names and a list of
// records — which is a table. Delivery nonetheless handed them to a model and
// asked it to emit create-table plus one add-table-row proposal per record,
// and that is where real research went to die:
//
//   TRUNCATION. Forty records had to be retyped as proposals inside an
//   8,000-token reply. A long run's results were simply cut off, and what
//   landed looked like a complete table.
//   DRIFT. Every cell passed through a model that could round a price, tidy a
//   name or drop a field it judged uninteresting. The run scraped the value;
//   nothing should be retyping it afterwards.
//   COST AND LATENCY. Paying to re-emit data we already hold, verbatim.
//
// So the common case is built in code. A model still reads the task to decide
// what the result IS — a comparison, a shortlist, an answer — but it never
// touches the data. Values go from the page to the widget unaltered.

import type { BrowseFindings, BrowseRecord } from '@shared/browseFindings'
import type { ActionProposal } from '@shared/types'

export type ColumnType =
  | 'text-short'
  | 'text-long'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'single-select'
  | 'multi-select'
  | 'attachment'
  | 'button'

export interface PlannedColumn {
  label: string
  type: ColumnType
}

export interface PlannedWidgets {
  /** The table, when the run found a list of things. */
  table: { title: string; columns: PlannedColumn[]; rows: BrowseRecord[] } | null
  /** The prose, when the run answered a question rather than listing. */
  note: { title: string; markdown: string } | null
}

// Beyond this a cell is prose and wants a tall column rather than a line.
const LONG_TEXT = 60

const DATE_RE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/
const NUMBER_RE = /^-?[\d,]+(\.\d+)?$/

/**
 * What kind of column a field's actual values make it.
 *
 * Inferred from the DATA rather than the field's name, because a run names its
 * own fields and "rating" may hold "4.8" or "Highly rated" depending on the
 * site. A column typed number that then rejects half its values is worse than
 * a text column that accepts everything.
 */
export function inferColumnType(values: readonly string[]): ColumnType {
  const filled = values.map((v) => v.trim()).filter(Boolean)
  if (filled.length === 0) return 'text-short'
  // A URL is text, never a number — "12345" as an id must not become numeric
  // and lose its leading zeros, and a link must stay clickable text.
  if (filled.every((v) => /^https?:\/\//i.test(v))) return 'text-short'
  if (filled.every((v) => NUMBER_RE.test(v))) return 'number'
  if (filled.every((v) => DATE_RE.test(v))) return 'date'
  const avg = filled.reduce((n, v) => n + v.length, 0) / filled.length
  return avg > LONG_TEXT ? 'text-long' : 'text-short'
}

/** A readable column header from a field name the model invented. */
export function humaniseField(field: string): string {
  const spaced = field
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A title for the result, from what was asked. */
export function titleFromTask(task: string, fallback: string): string {
  const t = task
    .trim()
    .replace(/^(please\s+)?(can you\s+)?(go\s+)?(and\s+)?/i, '')
    // The instruction half is not a title: "find X and put it in a table" is X.
    .replace(/\s+(and|then)\s+(put|add|place|save|record|write).*$/i, '')
    .replace(/^(find|research|look up|search for|get|gather|collect)\s+/i, '')
    .replace(/[.?!]+$/, '')
    .trim()
  if (!t) return fallback
  const titled = t.charAt(0).toUpperCase() + t.slice(1)
  return titled.length > 60 ? `${titled.slice(0, 57)}…` : titled
}

/**
 * The widgets a set of findings deserves.
 *
 * Records become a table and prose becomes a note, and a run that produced both
 * gets both — the list is the data, the answer is what it means, and dropping
 * either loses half the work.
 */
export function planFindingsWidgets(findings: BrowseFindings, task: string): PlannedWidgets {
  const title = titleFromTask(task, 'Browsing results')

  const table =
    findings.records.length > 0 && findings.fields.length > 0
      ? {
          title,
          columns: findings.fields.map((f) => ({
            label: humaniseField(f),
            type: inferColumnType(findings.records.map((r) => r[f] ?? ''))
          })),
          // Verbatim. Every value came off a page; nothing re-derives it.
          rows: findings.records
        }
      : null

  const answer = findings.answer.trim()
  const note = answer
    ? {
        title: table ? `${title} — what this shows` : title,
        markdown: answer
      }
    : null

  return { table, note }
}

/**
 * Whether these findings are worth placing at all.
 *
 * An empty delivery that reports success is the failure this whole path exists
 * to prevent — better to say plainly that the run found nothing.
 */
export function hasPlaceableFindings(p: PlannedWidgets): boolean {
  return !!(p.table?.rows.length || p.note?.markdown)
}

/**
 * The findings as ordinary action proposals.
 *
 * Deliberately routed through the SAME applyProposal path everything else
 * uses, rather than creating widgets directly: that path already handles the
 * table-then-rows ordering, the schema build, value coercion and the spawn
 * position, and all of it is tested. Only the authorship changes — these come
 * from the data instead of from a model retyping it.
 */
export function planFindingsProposals(
  findings: BrowseFindings,
  task: string,
  deskId: string | null
): ActionProposal[] {
  const plan = planFindingsWidgets(findings, task)
  const out: ActionProposal[] = []
  const desk = deskId ?? undefined

  if (plan.table) {
    const tableProposalId = 'browse-table'
    out.push({
      id: tableProposalId,
      kind: 'create-table',
      title: plan.table.title,
      columns: plan.table.columns,
      deskId: desk,
      reason: 'What the browsing run found'
    } as ActionProposal)

    // Every row, not as many as fit in a reply. This is the whole reason the
    // proposals are built here: a long run's results used to be truncated by
    // the model's output limit and the result still looked complete.
    plan.table.rows.forEach((row, i) => {
      const cells: Record<string, string> = {}
      for (const col of plan.table!.columns) {
        // Columns are keyed by label downstream; map back through the original
        // field name, which is what the record actually carries.
        const field = findings.fields.find((f) => humaniseField(f) === col.label)
        const v = field ? row[field] : undefined
        if (v) cells[col.label] = v
      }
      if (Object.keys(cells).length === 0) return
      out.push({
        id: `browse-row-${i}`,
        kind: 'add-table-row',
        tableId: `$${tableProposalId}`,
        cells
      } as ActionProposal)
    })
  }

  if (plan.note) {
    out.push({
      id: 'browse-note',
      kind: 'create-widget',
      widgetKind: 'markdown',
      title: plan.note.title,
      content: plan.note.markdown,
      deskId: desk,
      reason: 'What the browsing run concluded'
    } as ActionProposal)
  }

  return out
}

/**
 * What was placed, in the run's own numbers.
 *
 * The old sentence came from the model and described what it INTENDED. This
 * describes what the data actually contains, so a run that found three rows
 * cannot be reported as a rich comparison of twenty.
 */
export function describePlacement(findings: BrowseFindings): string {
  const rows = findings.records.length
  const cols = findings.fields.length
  const parts: string[] = []
  if (rows > 0) {
    parts.push(
      `Put ${rows} ${rows === 1 ? 'result' : 'results'} into a table` +
        (cols > 0 ? ` of ${cols} ${cols === 1 ? 'column' : 'columns'}` : '')
    )
  }
  if (findings.answer.trim()) parts.push(parts.length ? 'with a summary beside it' : 'Wrote up what it found')
  return parts.length ? `${parts.join(', ')}.` : 'Nothing was found to place.'
}
