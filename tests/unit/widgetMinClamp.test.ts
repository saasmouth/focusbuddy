// A widget is stored at the size its frame renders. The canvas frame never
// draws a widget below its kind's minimum (react-rnd minWidth/minHeight from
// shared/widgetSizing), but a create or resize from the API, an agent or MCP
// could ask for less, and the row then held a size nobody could see: Tidy grew
// from it (writing 113 for a widget showing 120). createWidget and updateWidget
// clamp to the minimum; sections and the minimap size themselves and are left
// alone. The real schema and migrations, on SQLite-WASM (see cloudDesktopRoundTrip).

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'
import { clampToKindMin, minSizeFor, BASE_MIN } from '../../src/shared/widgetSizing'

let db: SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'clamp@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

let W: typeof import('../../src/main/db/widgets')
const DESK = 'desk-clamp'

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db)
  const now = Date.now()
  db.prepare("INSERT INTO nodes (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'task', 'Clamp desk', ?, ?)").run(DESK, now, now)
  W = await import('../../src/main/db/widgets')
})

const stored = (id: string): { width: number; height: number } =>
  db.prepare('SELECT width, height FROM widgets WHERE id = ?').get(id) as { width: number; height: number }

describe('clampToKindMin', () => {
  it('raises only what is below the minimum, and only the fields given', () => {
    expect(clampToKindMin('shape', { width: 90, height: 60 })).toEqual({ width: BASE_MIN.w, height: BASE_MIN.h })
    expect(clampToKindMin('shape', { width: 400, height: 60 })).toEqual({ width: 400, height: BASE_MIN.h })
    expect(clampToKindMin('doc', { height: 100 })).toEqual({ height: minSizeFor('doc').h })
    expect(clampToKindMin('doc', { x: 5 } as { x: number; width?: number })).toEqual({ x: 5 })
  })

  it('never grows a widget already at or above its minimum, and has no maximum', () => {
    expect(clampToKindMin('sticky', { width: 180, height: 120 })).toEqual({ width: 180, height: 120 })
    expect(clampToKindMin('sticky', { width: 9000, height: 9000 })).toEqual({ width: 9000, height: 9000 })
  })

  it('leaves self-sized kinds alone', () => {
    expect(clampToKindMin('section', { width: 40, height: 40 })).toEqual({ width: 40, height: 40 })
    expect(clampToKindMin('minimap', { width: 40, height: 40 })).toEqual({ width: 40, height: 40 })
  })
})

describe('the widgets table stores the size the frame renders', () => {
  it('createWidget raises an undersized create to the kind minimum', () => {
    const w = W.createWidget({ taskId: DESK, kind: 'shape', content: '', x: 0, y: 0, width: 250, height: 90 } as never)
    expect([w.width, w.height]).toEqual([250, BASE_MIN.h])
    expect(stored(w.id)).toEqual({ width: 250, height: BASE_MIN.h })
  })

  it('an editor gets its own, larger minimum', () => {
    const w = W.createWidget({ taskId: DESK, kind: 'doc', content: '', width: 200, height: 100 } as never)
    expect(stored(w.id)).toEqual({ width: minSizeFor('doc').w, height: minSizeFor('doc').h })
  })

  it('updateWidget raises an undersized resize, from any caller', () => {
    const w = W.createWidget({ taskId: DESK, kind: 'sticky', content: 'x', width: 300, height: 300 } as never)
    const u = W.updateWidget(w.id, { height: 50 })!
    expect(u.height).toBe(BASE_MIN.h)
    expect(stored(w.id)).toEqual({ width: 300, height: BASE_MIN.h })
    // a resize at or above the minimum is stored exactly
    W.updateWidget(w.id, { width: 181, height: 121 })
    expect(stored(w.id)).toEqual({ width: 181, height: 121 })
  })

  it('a patch with no size is untouched (the clamp never rewrites geometry it was not given)', () => {
    const w = W.createWidget({ taskId: DESK, kind: 'shape', content: '', width: 300, height: 200 } as never)
    db.prepare('UPDATE widgets SET height = 60 WHERE id = ?').run(w.id) // a legacy undersized row
    W.updateWidget(w.id, { x: 40 })
    expect(stored(w.id).height).toBe(60)
  })

  it('a section keeps whatever size it is given', () => {
    const s = W.createWidget({ taskId: DESK, kind: 'section', content: '', width: 60, height: 40 } as never)
    expect(stored(s.id)).toEqual({ width: 60, height: 40 })
    W.updateWidget(s.id, { width: 50 })
    expect(stored(s.id).width).toBe(50)
  })
})
