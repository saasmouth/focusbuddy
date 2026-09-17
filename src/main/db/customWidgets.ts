// The user's personal library of AI-built widgets.
//
// A saved widget is a name, the plain-language spec that produced it, and a
// self-contained HTML document. Saving is what turns a one-off generation into a
// tool the user owns: the same widget can be dropped onto any desk, any number
// of times, without asking the model again (and without spending a token).
//
// Stored in SQLite rather than localStorage. The older custom-block templates use
// localStorage and that is a real weakness for anything the user authored -- it
// is not backed up before migrations, not in the workspace export, and is gone
// if the profile's web storage is cleared. Work the user spent effort on belongs
// in the database with the rest of their content.

import { randomUUID } from 'crypto'
import { CUSTOM_WIDGET_MAX_CODE_BYTES, type SavedCustomWidget } from '@shared/types'

// The database handle is injected rather than imported. Everything here is then
// exercisable against an in-memory SQLite in a plain node test, the way
// nodeLifecycle already is -- a store that can only run inside Electron is a
// store whose behaviour is asserted by nothing.
export interface CustomWidgetDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

interface Row {
  id: string
  name: string
  spec: string
  code: string
  icon: string
  net: number
  width: number
  height: number
  use_count: number
  created_at: number
  updated_at: number
}

function toSaved(r: Row): SavedCustomWidget {
  return {
    id: r.id,
    name: r.name,
    spec: r.spec,
    code: r.code,
    icon: r.icon,
    net: r.net === 1,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    useCount: r.use_count
  }
}

/** Every saved widget, most recently touched first. */
export function listCustomWidgets(db: CustomWidgetDb): SavedCustomWidget[] {
  const rows = db
    .prepare('SELECT * FROM fb_custom_widgets ORDER BY updated_at DESC')
    .all() as Row[]
  return rows.map(toSaved)
}

export function getCustomWidget(db: CustomWidgetDb, id: string): SavedCustomWidget | null {
  const r = db.prepare('SELECT * FROM fb_custom_widgets WHERE id = ?').get(id) as Row | undefined
  return r ? toSaved(r) : null
}

export interface SaveCustomWidgetInput {
  // Omit to create; pass an existing id to overwrite that entry in place, which
  // is what "update the saved copy" in the widget's menu does.
  id?: string
  name: string
  spec: string
  code: string
  icon?: string
  net?: boolean
  width?: number
  height?: number
}

export type SaveCustomWidgetResult =
  | { ok: true; widget: SavedCustomWidget }
  | { ok: false; error: string }

/** Create or overwrite a library entry. Refuses an empty or oversized document
 *  rather than storing something that cannot render. */
export function saveCustomWidget(
  db: CustomWidgetDb,
  input: SaveCustomWidgetInput
): SaveCustomWidgetResult {
  const code = typeof input.code === 'string' ? input.code : ''
  if (!code.trim()) return { ok: false, error: 'There is no generated widget to save yet.' }
  if (Buffer.byteLength(code, 'utf8') > CUSTOM_WIDGET_MAX_CODE_BYTES) {
    return { ok: false, error: 'This widget is too large to save.' }
  }
  const name = (input.name || '').trim() || 'Untitled widget'
  const now = Date.now()

  if (input.id) {
    const existing = db.prepare('SELECT id FROM fb_custom_widgets WHERE id = ?').get(input.id)
    if (existing) {
      db.prepare(
        `UPDATE fb_custom_widgets
            SET name = ?, spec = ?, code = ?, icon = ?, net = ?, width = ?, height = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        name,
        input.spec ?? '',
        code,
        input.icon || 'widgets',
        input.net ? 1 : 0,
        Math.round(input.width ?? 420),
        Math.round(input.height ?? 360),
        now,
        input.id
      )
      const w = getCustomWidget(db, input.id)
      return w ? { ok: true, widget: w } : { ok: false, error: 'Saved widget could not be read back.' }
    }
  }

  const id = input.id || randomUUID()
  db.prepare(
    `INSERT INTO fb_custom_widgets
       (id, name, spec, code, icon, net, width, height, use_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    name,
    input.spec ?? '',
    code,
    input.icon || 'widgets',
    input.net ? 1 : 0,
    Math.round(input.width ?? 420),
    Math.round(input.height ?? 360),
    now,
    now
  )
  const w = getCustomWidget(db, id)
  return w ? { ok: true, widget: w } : { ok: false, error: 'Saved widget could not be read back.' }
}

export function deleteCustomWidget(db: CustomWidgetDb, id: string): { ok: boolean } {
  db.prepare('DELETE FROM fb_custom_widgets WHERE id = ?').run(id)
  return { ok: true }
}

export function renameCustomWidget(db: CustomWidgetDb, id: string, name: string): { ok: boolean } {
  const clean = (name || '').trim()
  if (!clean) return { ok: false }
  db.prepare('UPDATE fb_custom_widgets SET name = ?, updated_at = ? WHERE id = ?').run(
    clean,
    Date.now(),
    id
  )
  return { ok: true }
}

/** Bump the use counter when a saved widget is placed on a desk. Ordering the
 *  library by what the user actually reaches for beats ordering it by age. */
export function markCustomWidgetUsed(db: CustomWidgetDb, id: string): void {
  db.prepare('UPDATE fb_custom_widgets SET use_count = use_count + 1 WHERE id = ?').run(id)
}
