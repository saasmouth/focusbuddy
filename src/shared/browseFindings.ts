// What a browsing run LEARNED, as structured data rather than prose.
//
// Before this module a run's entire yield was one `summary` string: the model
// read twenty pages, named ten businesses with ratings and URLs, and the loop
// threw all of it away on the way out. Nothing downstream could use it, so a
// task like "find ten photographers so they can be added to a table" ended with
// an empty table and a sentence.
//
// Findings are deliberately shape-agnostic. A run yields RECORDS (a list of
// things, each a bag of named fields) and/or an ANSWER (prose, when the task
// was not list-shaped). That covers photographers, flights, prices, contacts
// and "what is their refund policy" without the browser loop knowing anything
// about tables, contacts or documents — routing to a destination is a separate
// decision made downstream, from the user's original intent.
//
// Pure: no Electron, no SDK. Main builds these, the renderer consumes them,
// and this module unit-tests directly.

// One found thing. Field names are chosen by the model per run (e.g. name,
// specialty, rating, website) and shared across the run's records.
export type BrowseRecord = Record<string, string>

export interface BrowseFindings {
  // Field names in the order the model reported them. This IS the column order
  // for any tabular destination, so order is meaningful and preserved.
  fields: string[]
  records: BrowseRecord[]
  // Prose answer for tasks that are questions rather than lists. A run may
  // have both (a list plus a sentence about it), or only one.
  answer: string
}

// Caps. A browsing run is adversarial input — it reads whatever the open web
// hands it — so every bound is enforced here rather than trusted.
export const MAX_RECORDS = 200
export const MAX_FIELDS = 16
const MAX_FIELD_NAME = 60
const MAX_CELL = 500
const MAX_ANSWER = 4000

export function emptyFindings(): BrowseFindings {
  return { fields: [], records: [], answer: '' }
}

export function hasFindings(f: BrowseFindings | null | undefined): boolean {
  return !!f && (f.records.length > 0 || f.answer.trim().length > 0)
}

function cleanText(v: unknown, cap: number): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v !== 'string') return ''
  // Collapse whitespace: scraped cells arrive full of newlines and runs of
  // spaces that would wreck any table they land in.
  return v.replace(/\s+/g, ' ').trim().slice(0, cap)
}

// Normalise whatever the model returned into findings we can store and route.
// Unknown shapes degrade to empty rather than throwing — a malformed findings
// block must never kill a run that otherwise succeeded.
export function normalizeFindings(raw: unknown): BrowseFindings {
  if (!raw || typeof raw !== 'object') return emptyFindings()
  const o = raw as Record<string, unknown>
  const answer = cleanText(o.answer, MAX_ANSWER)

  const rawRecords = Array.isArray(o.records) ? o.records.slice(0, MAX_RECORDS) : []

  // Field order comes from the model's `fields` when given, then from the order
  // keys first appear across records — so a field only some records carry still
  // gets a column, and it lands after the fields everything shares.
  const order: string[] = []
  const seen = new Set<string>()
  const pushField = (name: string): void => {
    const f = cleanText(name, MAX_FIELD_NAME)
    if (!f || seen.has(f) || order.length >= MAX_FIELDS) return
    seen.add(f)
    order.push(f)
  }
  if (Array.isArray(o.fields)) for (const f of o.fields) pushField(String(f))

  const records: BrowseRecord[] = []
  for (const r of rawRecords) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const entries = Object.entries(r as Record<string, unknown>)
    for (const [k] of entries) pushField(k)
    const rec: BrowseRecord = {}
    for (const [k, v] of entries) {
      const key = cleanText(k, MAX_FIELD_NAME)
      if (!key || !seen.has(key)) continue
      const cell = cleanText(v, MAX_CELL)
      if (cell) rec[key] = cell
    }
    // A record with no usable cell is noise, not a row.
    if (Object.keys(rec).length > 0) records.push(rec)
  }

  // Drop fields no surviving record actually uses, so a destination never gets
  // a column that is empty in every row.
  const used = order.filter((f) => records.some((r) => r[f] !== undefined))
  return { fields: used, records, answer }
}

// Merge findings captured across rounds. Records are deduped on their first
// field (the identity column in practice — a name, a title), last write
// winning so a later round can enrich a record it already saw with fields it
// only found on a detail page.
export function mergeFindings(a: BrowseFindings, b: BrowseFindings): BrowseFindings {
  const fields: string[] = []
  const seen = new Set<string>()
  for (const f of [...a.fields, ...b.fields]) {
    if (seen.has(f) || fields.length >= MAX_FIELDS) continue
    seen.add(f)
    fields.push(f)
  }
  const keyOf = (r: BrowseRecord): string => {
    const first = fields.find((f) => r[f] !== undefined)
    return first ? `${first}:${(r[first] ?? '').toLowerCase()}` : JSON.stringify(r)
  }
  const byKey = new Map<string, BrowseRecord>()
  for (const r of [...a.records, ...b.records]) {
    const k = keyOf(r)
    const prior = byKey.get(k)
    byKey.set(k, prior ? { ...prior, ...r } : r)
  }
  const records = [...byKey.values()].slice(0, MAX_RECORDS)
  const used = fields.filter((f) => records.some((r) => r[f] !== undefined))
  return { fields: used, records, answer: b.answer.trim() || a.answer }
}

// A compact text rendering of the findings so far, fed back to the model each
// round as its durable memory. This is what lets the loop DROP old page
// observations without losing what those pages said — the cost fix and the
// data-capture fix are the same mechanism.
export function findingsDigest(f: BrowseFindings, maxChars = 4000): string {
  if (!hasFindings(f)) return 'NOTHING RECORDED YET.'
  const lines: string[] = []
  if (f.answer) lines.push(`ANSWER SO FAR: ${f.answer}`)
  if (f.records.length) {
    lines.push(`RECORDS SO FAR (${f.records.length}):`)
    f.records.forEach((r, i) => {
      const cells = f.fields.filter((k) => r[k]).map((k) => `${k}=${r[k]}`)
      lines.push(`  ${i + 1}. ${cells.join(' | ')}`)
    })
  }
  const out = lines.join('\n')
  return out.length <= maxChars ? out : `${out.slice(0, maxChars)}\n  …(truncated)`
}
