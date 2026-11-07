// "Download this desk on Plexii": a visitor's copy of a shared desk, carried
// from their browser into the desktop app (owner, 2026-11-07).
//
// A public link opens the full app in the browser. A visitor may look around,
// arrange the desk and drag apps, widgets, files and tools onto it. Anything
// else ("create a desk", AI, editing, settings...) says "Download this desk on
// Plexii", starts the installer download, and the desk -- the visitor's copy,
// with everything they added -- opens in the app once they have signed up.
//
// The copy lives only in the visitor's browser, so the share page uploads it to
// Signal as an anonymous HANDOFF (POST /desk-handoffs) and gets an id back. The
// id travels to the desktop as a deep link (plexii://desk?handoff=<id>); the
// app keeps it until someone is signed in, claims it with that session
// (POST /desk-handoffs/:id/claim) and imports the desk.
//
// This file is the part both ends share: the link, and REKEYING. The visitor's
// copy carries the SENDER's row ids (the share page imported the sender's
// bundle as it was). Imported into the visitor's own workspace as they are,
// those rows would sync to the visitor's account under ids that belong to the
// sender's -- and a person opening their own link would get nothing at all,
// because importDeskBundle skips rows whose ids already exist. So every row is
// given a fresh id on the way in, and every reference to it is rewritten.

import { DEEP_LINK_SCHEME, isKnownDeepLinkProtocol } from './deepLink'

/** A handoff id as Signal mints it: url-safe, long enough to be unguessable. */
export const DESK_HANDOFF_ID = /^[A-Za-z0-9_-]{16,128}$/

/** The deep link that hands a desk to the app. */
export function deskHandoffLink(id: string): string {
  return `${DEEP_LINK_SCHEME}://desk?handoff=${encodeURIComponent(id)}`
}

/** The handoff id in a deep link, or null if it is not one. */
export function parseDeskHandoffLink(url: string): string | null {
  try {
    const u = new URL(url)
    if (!isKnownDeepLinkProtocol(u.protocol) || u.host !== 'desk') return null
    const id = u.searchParams.get('handoff') ?? ''
    return DESK_HANDOFF_ID.test(id) ? id : null
  } catch {
    return null
  }
}

// ── Rekeying ────────────────────────────────────────────────────────────────

/** The bundle shape this needs (main/db/deskBundle.ts DeskBundle, structurally). */
export interface RekeyableBundle {
  format: string
  formatVersion: number
  desk: { id: string; title: string }
  tables: Record<string, Array<Record<string, unknown>>>
  files: Array<{ id: string; data: string } & Record<string, unknown>>
  filesOmitted?: Array<{ id: string } & Record<string, unknown>>
  presentation?: unknown
  [k: string]: unknown
}

/** The tables whose `id` is a row id that must be made fresh. */
const ID_TABLES = ['nodes', 'widgets', 'widget_links', 'fb_tables', 'fb_rows', 'documents', 'fb_files'] as const

/**
 * Columns that say where a row stands with a sync server. They belong to the
 * workspace the row came from, so they are dropped and the importing
 * database's defaults apply: never synced (sync_rev 0), waiting to be pushed
 * (needs_sync 1), and the person's own (org_id 'personal').
 */
const SYNC_COLUMNS = ['sync_rev', 'needs_sync', 'org_id'] as const

/**
 * Ids shorter than this are never rewritten inside text. Row ids are UUIDs or
 * long random strings; a short id (a select choice's "o2") is not a row id,
 * and rewriting every "o2" in a document would be vandalism.
 */
const MIN_ID_LENGTH = 12

export interface RekeyOptions {
  /** A fresh id for a row of `table`. Must be unique and, for fb_files, [A-Za-z0-9_-]. */
  newId: (table: string) => string
  /**
   * Whose arrangement the desk's layouts become. The renderer keys layouts by
   * the signed-in account's id; the visitor's own (the browser's 'local' row)
   * wins over the sender's when both are there.
   */
  layoutUser: string
  /** The browser's layout user ('local', sitePresentation VISITOR_LAYOUT_USER). */
  visitorLayoutUser: string
}

export interface RekeyResult {
  bundle: RekeyableBundle
  /** old id -> new id, for every row id that was replaced. */
  ids: Map<string, string>
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A copy of `bundle` with every row id replaced, every reference rewritten,
 * sync bookkeeping cleared and layouts made the importing person's.
 *
 * References are rewritten by value, not by column: a desk points at its rows
 * from foreign keys (parent_id, task_id, table_id, source_widget_id...), but
 * also from inside text -- a document widget's content is its document's id, a
 * file widget's content is JSON naming its file, a document body embeds files,
 * a layout lists its widgets. Listing every such place would be a list that is
 * wrong the day a widget kind is added. Every string in the bundle is searched
 * instead, for the exact ids this bundle defines and nothing else, bounded so
 * one id can never match inside a longer token. File bytes are not searched.
 */
export function rekeyDeskBundle(source: RekeyableBundle, opts: RekeyOptions): RekeyResult {
  const ids = new Map<string, string>()
  for (const table of ID_TABLES) {
    for (const row of source.tables?.[table] ?? []) {
      const id = typeof row.id === 'string' ? row.id : null
      if (id && !ids.has(id)) ids.set(id, opts.newId(table))
    }
  }
  // A file the bundle names but could not carry (filesOmitted) or carries
  // without a row keeps the same treatment, so its widget and its bytes agree.
  for (const f of [...(source.files ?? []), ...(source.filesOmitted ?? [])]) {
    if (typeof f.id === 'string' && !ids.has(f.id)) ids.set(f.id, opts.newId('fb_files'))
  }

  const rewritable = [...ids.keys()].filter((id) => id.length >= MIN_ID_LENGTH)
  // Longest first, so an id that happens to contain a shorter one is replaced whole.
  rewritable.sort((a, b) => b.length - a.length)
  const pattern = rewritable.length
    ? new RegExp(`(?<![A-Za-z0-9_-])(${rewritable.map(escapeRe).join('|')})(?![A-Za-z0-9_-])`, 'g')
    : null
  const rewriteText = (s: string): string => {
    // An id shorter than MIN_ID_LENGTH is still replaced when it IS the value
    // (a foreign key), just never inside other text.
    const whole = ids.get(s)
    if (whole) return whole
    return pattern ? s.replace(pattern, (m) => ids.get(m) ?? m) : s
  }
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return rewriteText(v)
    if (Array.isArray(v)) return v.map(rewrite)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = rewrite(val)
      return out
    }
    return v
  }

  const tables: Record<string, Array<Record<string, unknown>>> = {}
  for (const [table, rows] of Object.entries(source.tables ?? {})) {
    if (!Array.isArray(rows)) continue
    tables[table] = rows.map((row) => {
      const next = rewrite(row) as Record<string, unknown>
      for (const c of SYNC_COLUMNS) delete next[c]
      return next
    })
  }

  // Layouts: one per desk and device class, the visitor's own first, then made
  // the importing person's.
  if (tables.desk_layouts) {
    const chosen = new Map<string, Record<string, unknown>>()
    const rank = (r: Record<string, unknown>): number => (r.user_id === opts.visitorLayoutUser ? 0 : 1)
    for (const r of tables.desk_layouts) {
      const key = `${String(r.desk_id)}\u0000${String(r.device_class)}`
      const have = chosen.get(key)
      if (!have || rank(r) < rank(have)) chosen.set(key, r)
    }
    tables.desk_layouts = [...chosen.values()].map((r) => ({ ...r, user_id: opts.layoutUser }))
  }

  const files = (source.files ?? []).map((f) => ({ ...f, id: ids.get(f.id) ?? f.id }))
  const filesOmitted = (source.filesOmitted ?? []).map((f) => ({ ...f, id: ids.get(f.id) ?? f.id }))

  // The rest of the bundle (presentation, counts...) is the browser's business:
  // how a link presents a desk means nothing in a workspace of one's own.
  const bundle: RekeyableBundle = {
    format: source.format,
    formatVersion: source.formatVersion,
    exportedAt: source.exportedAt,
    desk: { id: ids.get(source.desk.id) ?? source.desk.id, title: source.desk.title },
    counts: source.counts,
    tables,
    files,
    filesOmitted
  }
  return { bundle, ids }
}
