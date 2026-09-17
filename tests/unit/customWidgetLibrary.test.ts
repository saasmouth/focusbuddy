// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import {
  listCustomWidgets,
  getCustomWidget,
  saveCustomWidget,
  deleteCustomWidget,
  renameCustomWidget,
  markCustomWidgetUsed,
  type CustomWidgetDb
} from '../../src/main/db/customWidgets'
import { CUSTOM_WIDGET_MAX_CODE_BYTES } from '../../src/shared/types'

// The library is where a one-off generation becomes a tool the user owns, so the
// things worth asserting are the ones that would quietly lose their work: a save
// that does not round-trip, an overwrite that duplicates instead of replacing, a
// rename that blanks the name.

function freshDb(): CustomWidgetDb {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE fb_custom_widgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Untitled widget',
      spec TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'widgets',
      net INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 420,
      height INTEGER NOT NULL DEFAULT 360,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return raw as unknown as CustomWidgetDb
}

const base = { name: 'Retainer tracker', spec: 'hours used vs bought', code: '<p>hi</p>' }

describe('saving to the library', () => {
  it('round-trips everything the widget needs to be rebuilt', () => {
    const db = freshDb()
    const r = saveCustomWidget(db, { ...base, icon: 'timer', net: true, width: 500, height: 300 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const got = getCustomWidget(db, r.widget.id)
    expect(got).toMatchObject({
      name: 'Retainer tracker',
      spec: 'hours used vs bought',
      code: '<p>hi</p>',
      icon: 'timer',
      net: true,
      width: 500,
      height: 300,
      useCount: 0
    })
  })

  it('refuses to save a widget that has not been built', () => {
    const db = freshDb()
    expect(saveCustomWidget(db, { ...base, code: '' })).toEqual({
      ok: false,
      error: 'There is no generated widget to save yet.'
    })
    expect(saveCustomWidget(db, { ...base, code: '   ' }).ok).toBe(false)
    expect(listCustomWidgets(db)).toHaveLength(0)
  })

  it('refuses a document past the size ceiling', () => {
    const db = freshDb()
    const huge = 'x'.repeat(CUSTOM_WIDGET_MAX_CODE_BYTES + 1)
    const r = saveCustomWidget(db, { ...base, code: huge })
    expect(r.ok).toBe(false)
    expect(listCustomWidgets(db)).toHaveLength(0)
  })

  it('falls back to a usable name rather than storing an empty one', () => {
    const db = freshDb()
    const r = saveCustomWidget(db, { ...base, name: '   ' })
    expect(r.ok && r.widget.name).toBe('Untitled widget')
  })

  it('overwrites in place when given an existing id, instead of duplicating', () => {
    const db = freshDb()
    const first = saveCustomWidget(db, base)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = saveCustomWidget(db, {
      id: first.widget.id,
      name: 'Retainer tracker v2',
      spec: 'now with a warning band',
      code: '<p>v2</p>'
    })
    expect(second.ok).toBe(true)
    expect(listCustomWidgets(db)).toHaveLength(1)
    const got = getCustomWidget(db, first.widget.id)
    expect(got?.name).toBe('Retainer tracker v2')
    expect(got?.code).toBe('<p>v2</p>')
  })

  it('treats an id that no longer exists as a fresh save, not a silent no-op', () => {
    // The user deleted the library entry, then pressed Save on the widget still
    // open on their desk. Losing that save would be losing their work.
    const db = freshDb()
    const r = saveCustomWidget(db, { ...base, id: 'id-that-was-deleted' })
    expect(r.ok).toBe(true)
    expect(listCustomWidgets(db)).toHaveLength(1)
    expect(getCustomWidget(db, 'id-that-was-deleted')).not.toBeNull()
  })
})

describe('managing the library', () => {
  it('lists most recently touched first', () => {
    const db = freshDb()
    const a = saveCustomWidget(db, { ...base, name: 'A' })
    const b = saveCustomWidget(db, { ...base, name: 'B' })
    expect(a.ok && b.ok).toBe(true)
    const names = listCustomWidgets(db).map((w) => w.name)
    expect(names).toHaveLength(2)
    expect(names).toContain('A')
    expect(names).toContain('B')
  })

  it('deletes only the entry named', () => {
    const db = freshDb()
    const a = saveCustomWidget(db, { ...base, name: 'A' })
    saveCustomWidget(db, { ...base, name: 'B' })
    if (!a.ok) return
    deleteCustomWidget(db, a.widget.id)
    expect(listCustomWidgets(db).map((w) => w.name)).toEqual(['B'])
  })

  it('refuses a blank rename rather than erasing the name', () => {
    const db = freshDb()
    const r = saveCustomWidget(db, base)
    if (!r.ok) return
    expect(renameCustomWidget(db, r.widget.id, '   ')).toEqual({ ok: false })
    expect(getCustomWidget(db, r.widget.id)?.name).toBe('Retainer tracker')
    expect(renameCustomWidget(db, r.widget.id, 'Renamed')).toEqual({ ok: true })
    expect(getCustomWidget(db, r.widget.id)?.name).toBe('Renamed')
  })

  it('counts uses so the library can order by what is actually reached for', () => {
    const db = freshDb()
    const r = saveCustomWidget(db, base)
    if (!r.ok) return
    markCustomWidgetUsed(db, r.widget.id)
    markCustomWidgetUsed(db, r.widget.id)
    expect(getCustomWidget(db, r.widget.id)?.useCount).toBe(2)
  })

  it('returns null for an unknown id rather than throwing', () => {
    expect(getCustomWidget(freshDb(), 'nope')).toBeNull()
  })
})

// ── the bug this feature surfaced in the IPC contract deriver ────────────────
const require_ = createRequire(import.meta.url)
const { specOf } = require_('../../scripts/derive-ipc-contracts.cjs') as {
  specOf: (p: string) => { kind: string; optional: boolean; nullable: boolean }
}

describe('IPC contract derivation reads the parameter, not its type members', () => {
  it('treats a required object with optional members as REQUIRED', () => {
    // This was the live bug: `input: { a?: string }` matched /\?\s*:/ on the whole
    // parameter string, so the argument was recorded optional; a channel with no
    // enforceable required argument is then dropped from the registry entirely.
    // 32 handlers -- agents:invoke, chat:sendStream, files:ingestBuffer among them
    // -- were silently unvalidated as a result.
    expect(specOf('input: { spec: string; currentCode?: string }')).toEqual({
      kind: 'object',
      optional: false,
      nullable: false
    })
  })

  it('treats a required object with a nullable member as NON-nullable itself', () => {
    expect(specOf('input: { token: string; email: string | null }')).toEqual({
      kind: 'object',
      optional: false,
      nullable: false
    })
  })

  it('still recognises a genuinely optional parameter', () => {
    expect(specOf('opts?: { a: string }').optional).toBe(true)
    expect(specOf('limit: number = 10').optional).toBe(true)
  })

  it('still recognises a genuinely nullable parameter', () => {
    expect(specOf('email: string | null')).toEqual({
      kind: 'string',
      optional: false,
      nullable: true
    })
  })

  it('flattens nested inline types rather than being confused by them', () => {
    expect(specOf('input: { a: { b?: string }; c: number }')).toEqual({
      kind: 'object',
      optional: false,
      nullable: false
    })
  })

  it('leaves the primitives it already derived correctly untouched', () => {
    expect(specOf('id: string')).toEqual({ kind: 'string', optional: false, nullable: false })
    expect(specOf('n: number')).toEqual({ kind: 'number', optional: false, nullable: false })
    expect(specOf('b: boolean')).toEqual({ kind: 'boolean', optional: false, nullable: false })
  })
})
