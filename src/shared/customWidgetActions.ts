// What a generated widget is allowed to DO, and to what.
//
// ADR-0009 settled where generated code executes: its own origin, a sandbox
// without allow-same-origin, no network by default. That boundary is not being
// moved. What changes here is the BRIDGE — the postMessage channel the host
// already owns — so a widget can ask the host to do something and the host
// decides whether to.
//
// Three rules, in order of how much they matter:
//
// 1. CLOSED VERB LIST. A widget can request exactly the things enumerated here
//    and nothing else. An unknown verb is not "unsupported yet", it is refused.
//
// 2. SCOPED TO ITS WIRES. A widget may only act on a widget the user has drawn
//    a wire INTO it from. A widget wired to the invoices table can add a row to
//    the invoices table; it cannot touch the table on the other side of the
//    desk. This is the rule that makes the feature safe to offer at all — it
//    means granting a widget the ability to act grants it nothing beyond the
//    sources the user chose, and the grant is visible as a line on the canvas.
//
// 3. CONSENT ONCE, NOT NEVER AND NOT CONSTANTLY. Writes are off by default. A
//    widget with `acts` off has every write proposed for approval. A widget the
//    user has switched on writes within its scope directly — because a tool
//    that asks permission on every row is a tool nobody keeps. Same shape as
//    the existing `net` opt-in, deliberately.
//
// Pure: no stores, no IPC, no DOM. The host supplies the scope; this decides.

/** The verbs a generated widget may request. Deliberately short. */
export type WidgetActionKind =
  | 'add-table-row'
  | 'set-cell'
  | 'create-knowledge-entry'
  | 'open-url'

export const WIDGET_ACTION_KINDS: ReadonlySet<string> = new Set<WidgetActionKind>([
  'add-table-row',
  'set-cell',
  'create-knowledge-entry',
  'open-url'
])

export type WidgetAction =
  | { kind: 'add-table-row'; tableId: string; cells: Record<string, unknown> }
  | { kind: 'set-cell'; tableId: string; rowId: string; cells: Record<string, unknown> }
  | { kind: 'create-knowledge-entry'; title: string; body: string; tags?: string[] }
  | { kind: 'open-url'; url: string }

/** What the host knows about this widget's wired-in sources. */
export interface ActionScope {
  /** Table ids reachable through a wire drawn into this widget. */
  tableIds: readonly string[]
  /** Whether the user has switched this widget's ability to make changes on. */
  acts: boolean
}

export type ActionVerdict =
  /** Run it now. */
  | { ok: true; action: WidgetAction; needsApproval: false }
  /** Legal, but the user has not granted this widget write access — propose it. */
  | { ok: true; action: WidgetAction; needsApproval: true }
  /** Refused. `reason` is shown to the widget AND is what the user would see. */
  | { ok: false; reason: string }

// Bounds. A generated widget is untrusted code in a loop; it can ask for a
// million-character title as easily as a sensible one.
const MAX_TEXT = 4000
const MAX_TITLE = 200
const MAX_CELLS = 64
const MAX_TAGS = 12

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Cells, with anything unusable dropped rather than guessed at. */
function cleanCells(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_CELLS) break
    if (!k || k.length > 200) continue
    const t = typeof val
    if (t === 'string') {
      out[k] = (val as string).slice(0, MAX_TEXT)
      n++
    } else if (t === 'number' || t === 'boolean' || val === null) {
      // NaN and Infinity round-trip through JSON as null, so a non-finite
      // number never reaches a cell as a number.
      if (t === 'number' && !Number.isFinite(val as number)) continue
      out[k] = val
      n++
    }
    // Objects and arrays are dropped: a cell holds a value, not a structure.
  }
  return out
}

/**
 * Decide what to do with an action a sandboxed widget asked for.
 *
 * Everything arriving here crossed a postMessage boundary from untrusted code,
 * so nothing is assumed about its shape.
 */
export function judgeWidgetAction(raw: unknown, scope: ActionScope): ActionVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'An action must be an object.' }
  }
  const a = raw as Record<string, unknown>
  const kind = str(a.kind)
  if (!WIDGET_ACTION_KINDS.has(kind)) {
    return {
      ok: false,
      reason: `"${kind || '(none)'}" is not something a widget can do. Allowed: ${[...WIDGET_ACTION_KINDS].join(', ')}.`
    }
  }

  switch (kind as WidgetActionKind) {
    case 'add-table-row':
    case 'set-cell': {
      const tableId = str(a.tableId).trim()
      if (!tableId) return { ok: false, reason: 'That action needs a tableId.' }
      // THE scope rule. Not a nicety: without it, switching one widget on would
      // grant it every table in the workspace.
      if (!scope.tableIds.includes(tableId)) {
        return {
          ok: false,
          reason:
            'This widget can only change a table that is wired into it. Draw a wire from that table to this widget first.'
        }
      }
      const cells = cleanCells(a.cells)
      if (!cells || Object.keys(cells).length === 0) {
        return { ok: false, reason: 'That action needs at least one cell to write.' }
      }
      if (kind === 'set-cell') {
        const rowId = str(a.rowId).trim()
        if (!rowId) return { ok: false, reason: 'Changing a cell needs a rowId.' }
        return {
          ok: true,
          action: { kind: 'set-cell', tableId, rowId, cells },
          needsApproval: !scope.acts
        }
      }
      return {
        ok: true,
        action: { kind: 'add-table-row', tableId, cells },
        needsApproval: !scope.acts
      }
    }

    case 'create-knowledge-entry': {
      const title = str(a.title).trim().slice(0, MAX_TITLE)
      const body = str(a.body).trim().slice(0, MAX_TEXT)
      if (!title && !body) {
        return { ok: false, reason: 'Saving to PlexiBrain needs a title or a body.' }
      }
      const tags = Array.isArray(a.tags)
        ? (a.tags as unknown[])
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            .slice(0, MAX_TAGS)
            .map((t) => t.trim().slice(0, 60))
        : undefined
      return {
        ok: true,
        action: { kind: 'create-knowledge-entry', title: title || 'Untitled', body, tags },
        needsApproval: !scope.acts
      }
    }

    case 'open-url': {
      const url = str(a.url).trim()
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, reason: 'Only http and https links can be opened.' }
      }
      // Opening a link leaves nothing behind and is what the user just clicked,
      // so it does not wait for a second consent. It is still refused unless it
      // is a real web address.
      return { ok: true, action: { kind: 'open-url', url: url.slice(0, 2000) }, needsApproval: false }
    }
  }
}

/** One line describing an action, for the approval card and the activity log. */
export function describeWidgetAction(a: WidgetAction): string {
  switch (a.kind) {
    case 'add-table-row': {
      const first = Object.values(a.cells).find((v) => typeof v === 'string' && v.trim())
      return first ? `Add a row: “${String(first).slice(0, 60)}”` : 'Add a row'
    }
    case 'set-cell': {
      const fields = Object.keys(a.cells).slice(0, 3).join(', ')
      return `Update ${fields || 'a cell'}`
    }
    case 'create-knowledge-entry':
      return `Save “${a.title}” to PlexiBrain`
    case 'open-url':
      return `Open ${a.url.replace(/^https?:\/\//i, '').slice(0, 60)}`
  }
}
