// A copyable read link opened as a desk in the browser (src/web/api/readShare.ts,
// src/web/api/snapshotDesk.ts), and the snapshot change that lets its tables
// keep their choices (lib/shareSnapshot.ts serializeColumn).
//
// The token rules and the copy/view gate are pure. The snapshot is turned into
// a desk bundle and unpacked by the REAL Worker import (shareCopy.importDeskForShare)
// into REAL SQLite with the browser runtime's schema, and read back the way the
// app reads it -- so "it imports" means the rows the table widget looks for are
// there, not that a function returned an object.
//
// The fixture is shaped like a real read link's snapshot (a day-trading desk:
// pages, two tables with select columns, fields, a timer, websites, a section)
// with invented ids and values.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/fileBlobs', () => ({
  fileBlobs: {
    write: async () => undefined,
    read: async () => null,
    exists: async () => false,
    remove: async () => undefined,
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'https://signal.test', wsUrl: 'wss://signal.test/ws' },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))

import { readTokenFromUrl, READ_TOKEN_ALPHABET, copyRefusal, readRefusalFrom, offerWithRecordedDesk } from '../../src/web/api/readShare'
import { shareTokenFromUrl, linkIsGone, readInstead, refusalLine, whenRefused } from '../../src/web/api/share'
import { snapshotToDeskBundle } from '../../src/web/api/snapshotDesk'
import { generateShareToken } from '../../src/renderer/src/lib/shareTokens'
import { serializeColumn, buildTaskSnapshot } from '../../src/renderer/src/lib/shareSnapshot'

const READ = 'wq7k2m9xhbz3cdfa' // 16 characters of the read alphabet
const USE = 'linkA_abcdefghijklmnopqrstuvwxyz' // 32 characters of base64url

// ── The token ───────────────────────────────────────────────────────────────

describe('a read token in the address bar', () => {
  it('is read from /share/c/<token> and /c/<token>', () => {
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ}`)).toBe(READ)
    expect(readTokenFromUrl(`http://127.0.0.1:5180/c/${READ}`)).toBe(READ)
  })

  it('survives what a mail or chat client sticks on the end', () => {
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ}.`)).toBe(READ)
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ})`)).toBe(READ)
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ}/`)).toBe(READ)
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ}?utm_source=x`)).toBe(READ)
  })

  it('is exactly sixteen letters of the alphabet the desktop mints with', () => {
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ.slice(0, 15)}`)).toBeNull()
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ}x`)).toBeNull() // 17
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${READ.toUpperCase()}`)).toBeNull()
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/0000000000000000`)).toBeNull() // 0 is never minted
    expect(readTokenFromUrl('https://plexiidesk.com/share/')).toBeNull()
    expect(readTokenFromUrl('not a url')).toBeNull()
  })

  it('reads every token the desktop actually mints, and the alphabet is the minting one', () => {
    for (let i = 0; i < 500; i++) {
      const t = generateShareToken()
      expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${t}`)).toBe(t)
    }
    const minted = new Set<string>()
    for (let i = 0; i < 2000; i++) for (const ch of generateShareToken()) minted.add(ch)
    expect([...minted].sort().join('')).toBe([...READ_TOKEN_ALPHABET].sort().join(''))
  })

  it('never collides with a use link, in either direction', () => {
    // A use link is not a read link...
    expect(readTokenFromUrl(`https://plexiidesk.com/share/s/${USE}`)).toBeNull()
    // ...a 32-character use token put after /c/ is not read as a 16-character one...
    expect(readTokenFromUrl(`https://plexiidesk.com/share/c/${'a'.repeat(32)}`)).toBeNull()
    // ...and the use page does not read a read link.
    expect(shareTokenFromUrl(`https://plexiidesk.com/share/c/${READ}`)).toBeNull()
    expect(shareTokenFromUrl(`https://plexiidesk.com/share/s/${USE}`)).toBe(USE)
  })
})

// ── The gate ────────────────────────────────────────────────────────────────

describe('what a read link lets this page do', () => {
  it('copies only a desk the sender made copyable', () => {
    expect(copyRefusal({ scope: 'copy', kind: 'task' })).toBeNull()
    expect(copyRefusal({ scope: 'view', kind: 'task' })).toBe('view-only')
    expect(copyRefusal({ kind: 'task' })).toBe('view-only') // no scope is not permission
    expect(copyRefusal({ scope: 'copy', kind: 'folder' })).toBe('not-a-desk')
    expect(copyRefusal({ scope: 'copy', kind: 'document' })).toBe('not-a-desk')
    expect(copyRefusal({ scope: 'copy', kind: 'desk' })).toBe('not-a-desk') // a live desk
    expect(copyRefusal({ scope: 'view', kind: 'folder' })).toBe('view-only') // the sender's choice first
    expect(copyRefusal({ scope: 'copy', kind: 'task', revoked: true })).toBe('gone')
  })

  it('calls a link gone only in Signal’s own words', () => {
    expect(readRefusalFrom(404, { ok: false, error: 'Share not found or revoked.' })).toBe('gone')
    // A 404 that is not Signal's (a proxy, a route that moved) says nothing about the link.
    expect(readRefusalFrom(404, { message: 'Route GET:/share/x not found', error: 'Not Found', statusCode: 404 })).toBe('unavailable')
    expect(readRefusalFrom(404, null)).toBe('unavailable')
    expect(readRefusalFrom(503, { ok: false, reason: 'unavailable' })).toBe('unavailable')
    expect(readRefusalFrom(502, '<html>bad gateway</html>')).toBe('unavailable')
    expect(readRefusalFrom(429, { ok: false, error: 'slow down' })).toBe('unavailable')
  })

  it('a gone read link takes only its own copy; a read-only one takes nothing', () => {
    expect(linkIsGone('gone')).toBe(true)
    expect(linkIsGone('view-only')).toBe(false)
    expect(linkIsGone('not-a-desk')).toBe(false)
    expect(linkIsGone('unreadable')).toBe(false)
    expect(readInstead('view-only')).toBe(true)
    expect(readInstead('not-a-desk')).toBe(true)
    expect(readInstead('gone')).toBe(false)
    const offer = { title: 'Desk', expiresAt: null, sizeBytes: 10, rootId: 'desk-1' }
    expect(whenRefused('gone', null, false)).toEqual({ action: 'explain', reason: 'gone' })
    expect(whenRefused('gone', { offer }, false)).toEqual({ action: 'wipe', reason: 'gone' })
    expect(whenRefused('gone', { offer }, true)).toEqual({ action: 'forget', reason: 'gone' })
  })

  it('says each refusal in plain words', () => {
    expect(refusalLine('gone')).toMatch(/no longer working.*expired.*turned it off/)
    expect(refusalLine('view-only')).toMatch(/to be read, not copied/)
    expect(refusalLine('not-a-desk')).toMatch(/something other than a desk/)
    expect(refusalLine('unreadable')).toMatch(/could not be read/)
  })

  it('a returning visitor’s offer names the desk this browser unpacked', () => {
    const meta = { title: 'Desk', expiresAt: null, sizeBytes: 0, rootId: '' }
    expect(offerWithRecordedDesk(meta, null)).toEqual(meta)
    expect(offerWithRecordedDesk(meta, { rootId: 'desk-1', offer: { ...meta, rootId: 'desk-1', sizeBytes: 900 } }))
      .toEqual({ ...meta, rootId: 'desk-1', sizeBytes: 900 })
  })
})

// ── The snapshot carries a table's choices ──────────────────────────────────

describe('a table column in a snapshot', () => {
  it('carries a select column’s options, and nothing else of its config', () => {
    const options = [{ id: 'o1', label: 'Stocks', color: '#2563eb' }, { id: 'o4', label: 'Watching' }]
    expect(serializeColumn({ id: 'c2', type: 'single-select', label: 'Asset class', config: { options } }))
      .toEqual({ id: 'c2', type: 'single-select', label: 'Asset class', options })
    expect(serializeColumn({ id: 'c3', type: 'multi-select', label: 'Tags', config: { options: [{ id: 'x', label: 'X' }] } }))
      .toEqual({ id: 'c3', type: 'multi-select', label: 'Tags', options: [{ id: 'x', label: 'X' }] })
    // A button column's config is a shell command or a prompt: never on a link.
    expect(serializeColumn({ id: 'c9', type: 'button', label: 'Run', config: { action: 'shell', payload: 'rm -rf ~' } }))
      .toEqual({ id: 'c9', type: 'button', label: 'Run' })
    expect(serializeColumn({ id: 'c1', type: 'text-short', label: 'Symbol', config: {} }))
      .toEqual({ id: 'c1', type: 'text-short', label: 'Symbol' })
  })

  it('reaches the snapshot a read link is minted from', async () => {
    const api = {
      widgets: { listByTask: async () => [{ id: 'w1', kind: 'table', title: 'Watchlist', content: 't1', x: 0, y: 0, width: 400, height: 300, color: null, archived: false }] },
      tables: {
        get: async () => ({
          id: 't1', title: 'Watchlist',
          schema: { columns: [
            { id: 'c1', type: 'text-short', label: 'Symbol', config: {} },
            { id: 'c2', type: 'single-select', label: 'Status', config: { options: [{ id: 'o4', label: 'Watching' }] } },
            { id: 'c3', type: 'button', label: 'Go', config: { action: 'shell', payload: 'open -a Terminal' } }
          ] }
        }),
        listRows: async () => [{ id: 'r1', cells: { c1: 'AAPL', c2: 'o4' } }]
      }
    }
    ;(window as unknown as { api: unknown }).api = api
    const snap = await buildTaskSnapshot({ id: 'desk-1', kind: 'task', title: 'Desk' } as never, 'velvet-badger')
    const cols = snap.task.widgets[0].tableSnapshot!.columns
    expect(cols[1]).toEqual({ id: 'c2', type: 'single-select', label: 'Status', options: [{ id: 'o4', label: 'Watching' }] })
    expect(JSON.stringify(snap)).not.toContain('open -a Terminal')
  })
})

// ── The snapshot, made into a desk, on real SQLite ──────────────────────────

const CAPTURED = 1_793_687_619_562

function daySnapshot(withOptions = true): Record<string, unknown> {
  const opt = (o: Array<{ id: string; label: string }>) => (withOptions ? { options: o } : {})
  return {
    _version: 1,
    kind: 'task',
    fromHandle: 'velvet-badger',
    capturedAt: CAPTURED,
    task: {
      id: 'desk-day', kind: 'task', title: 'Day Trading Workcentre', description: 'Stocks, crypto and commodities',
      status: 'open', priority: 3, importance: 3, interest: 3, createdAt: CAPTURED - 1000, updatedAt: CAPTURED - 1000,
      completedAt: null, dueDate: null, estimateMinutes: null,
      widgets: [
        { id: 'w-plan', kind: 'page', title: 'Daily game plan', content: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Plan the trade"}]}]}', x: 80, y: 80, width: 480, height: 400, color: null, parentSectionId: null, layout: null },
        {
          id: 'w-watch', kind: 'table', title: 'Watchlist', content: 'tbl-watch', x: 80, y: 968, width: 1072, height: 440, color: null, parentSectionId: null, layout: null,
          tableSnapshot: {
            title: 'Watchlist',
            columns: [
              { id: 'c1', type: 'text-short', label: 'Symbol' },
              { id: 'c2', type: 'single-select', label: 'Asset class', ...opt([{ id: 'o1', label: 'Stocks' }, { id: 'o2', label: 'Crypto' }]) },
              { id: 'c6', type: 'single-select', label: 'Status', ...opt([{ id: 'o4', label: 'Watching' }]) },
              { id: 'c9', type: 'some-future-type', label: 'Later' }
            ],
            rows: [
              { id: 'row-aapl', cells: { c1: 'AAPL', c2: 'o1', c6: 'o4' } },
              { id: 'row-btc', cells: { c1: 'BTC', c2: 'o2', c6: 'o4', c9: 'kept as text' } }
            ]
          }
        },
        { id: 'w-loss', kind: 'field', title: 'Max daily loss ($)', content: '{"def":{"id":"f1","type":"number","label":"Max daily loss ($)","config":{}},"value":500}', x: 80, y: 1432, width: 240, height: 158, color: null },
        { id: 'w-timer', kind: 'timer', title: 'Opening range', content: '{"targetSec":900}', x: 80, y: 1880, width: 224, height: 224, color: null },
        { id: 'w-sec', kind: 'section', title: 'Charts', content: '', x: 300, y: 2000, width: 1500, height: 900, color: null, layout: 'grid' },
        { id: 'w-tv', kind: 'webview', title: 'TradingView', content: 'https://www.tradingview.com/chart/', x: 331, y: 2128, width: 1418, height: 797, color: null, parentSectionId: 'w-sec' },
        { id: 'w-orphan', kind: 'webview', title: 'Orphan', content: 'https://example.com/', x: 0, y: 0, width: 300, height: 200, color: null, parentSectionId: 'w-not-here' },
        {
          id: 'w-deck', kind: 'streamdeck', title: 'Deck', x: 0, y: 0, width: 300, height: 200, color: null,
          // The real DeckConfig shape (shared/streamdeck.ts): pages by id, buttons by position.
          content: JSON.stringify({
            _version: 1, rootPageId: 'p', settings: { defaultSound: 'click', defaultHaptic: 'soft', glow: 0.5 },
            pages: { p: { id: 'p', name: 'Main', buttons: { 0: { id: 'b', kind: 'action', label: 'Wipe', style: {}, action: { type: 'run-shell', command: 'rm -rf ~' } } } } }
          })
        },
        { title: 'no kind, not a widget' },
        'not even an object'
      ]
    }
  }
}

async function freshDb(): Promise<SqliteDb> {
  await initSqlite()
  const d = openMemoryDatabase()
  d.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(d)
  return d
}

const one = <T>(sql: string, ...a: unknown[]): T => db.prepare(sql).get(...a) as T
const all = <T>(sql: string, ...a: unknown[]): T[] => db.prepare(sql).all(...a) as T[]

describe('a read link’s snapshot, made into a desk', () => {
  beforeEach(async () => {
    db = await freshDb()
  })

  it('is a bundle the share page accepts as it stands', async () => {
    const made = snapshotToDeskBundle(daySnapshot())
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const { cannotImport } = await import('../../src/web/worker/shareCopy')
    const { DESK_BUNDLE_FORMAT, DESK_BUNDLE_VERSION } = await import('../../src/main/db/deskBundle')
    expect(made.bundle.format).toBe(DESK_BUNDLE_FORMAT)
    expect(made.bundle.formatVersion).toBe(DESK_BUNDLE_VERSION)
    expect(cannotImport(made.bundle)).toBeNull()
    expect(made.bundle.desk).toEqual({ id: 'desk-day', title: 'Day Trading Workcentre' })
  })

  it('unpacks into a desk with its work widgets, and its tables where the widgets look for them', async () => {
    const made = snapshotToDeskBundle(daySnapshot())
    if (!made.ok) throw new Error('not made')
    const { importDeskForShare } = await import('../../src/web/worker/shareCopy')
    const res = await importDeskForShare(made.bundle)
    expect(res.ok).toBe(true)

    expect(one<{ title: string; kind: string; parent_id: string | null; shared_from_handle: string }>('SELECT title, kind, parent_id, shared_from_handle FROM nodes WHERE id = ?', 'desk-day'))
      .toEqual({ title: 'Day Trading Workcentre', kind: 'task', parent_id: null, shared_from_handle: 'velvet-badger' })
    const kinds = all<{ id: string; kind: string }>('SELECT id, kind FROM widgets WHERE task_id = ? ORDER BY z_index', 'desk-day')
    expect(kinds.map((w) => w.id)).toEqual(['w-plan', 'w-watch', 'w-loss', 'w-timer', 'w-sec', 'w-tv', 'w-orphan', 'w-deck'])

    // The table widget names its table, and the table is there, rows and all.
    const tw = one<{ content: string }>('SELECT content FROM widgets WHERE id = ?', 'w-watch')
    const table = one<{ task_id: string; title: string; schema_json: string }>('SELECT task_id, title, schema_json FROM fb_tables WHERE id = ?', tw.content)
    expect(table.task_id).toBe('desk-day')
    const schema = JSON.parse(table.schema_json) as { columns: Array<{ id: string; type: string; config: { options?: Array<{ id: string; label: string }> } }> }
    const status = schema.columns.find((c) => c.id === 'c6')!
    expect(status.config.options).toEqual([{ id: 'o4', label: 'Watching' }])
    expect(schema.columns.find((c) => c.id === 'c9')!.type).toBe('text-short')
    const rows = all<{ id: string; cells_json: string; sort_order: number }>('SELECT id, cells_json, sort_order FROM fb_rows WHERE table_id = ? ORDER BY sort_order', tw.content)
    expect(rows.map((r) => r.id)).toEqual(['row-aapl', 'row-btc'])
    // What the table shows for row 1's Status: the option named by its cell.
    const cell = (JSON.parse(rows[0].cells_json) as Record<string, string>).c6
    expect(status.config.options!.find((o) => o.id === cell)?.label).toBe('Watching')

    // Sections: kept when the section is here, dropped when it is not.
    expect(one<{ p: string | null }>('SELECT parent_section_id AS p FROM widgets WHERE id = ?', 'w-tv').p).toBe('w-sec')
    expect(one<{ p: string | null }>('SELECT parent_section_id AS p FROM widgets WHERE id = ?', 'w-orphan').p).toBeNull()
    expect(one<{ l: string | null }>('SELECT layout AS l FROM widgets WHERE id = ?', 'w-sec').l).toBe('grid')
    // A delivered SpeedDeck can never offer to run a shell command.
    expect(one<{ content: string }>('SELECT content FROM widgets WHERE id = ?', 'w-deck').content).not.toContain('rm -rf')
  })

  it('a second import of the same snapshot adds nothing', async () => {
    const made = snapshotToDeskBundle(daySnapshot())
    if (!made.ok) throw new Error('not made')
    const { importDeskForShare } = await import('../../src/web/worker/shareCopy')
    await importDeskForShare(made.bundle)
    const again = await importDeskForShare(made.bundle)
    expect(again.imported).toBe(0)
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM nodes').n).toBe(1)
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM widgets').n).toBe(8)
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM fb_rows').n).toBe(2)
  })

  it('is removed whole by the page’s own per-desk removal, tables included', async () => {
    const made = snapshotToDeskBundle(daySnapshot())
    if (!made.ok) throw new Error('not made')
    const { importDeskForShare, removeDesk } = await import('../../src/web/worker/shareCopy')
    await importDeskForShare(made.bundle)
    await removeDesk('desk-day')
    for (const t of ['nodes', 'widgets', 'fb_tables', 'fb_rows']) {
      expect(one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).n, t).toBe(0)
    }
  })

  it('a snapshot made before columns carried their choices keeps its values, with no names to show', async () => {
    const made = snapshotToDeskBundle(daySnapshot(false))
    if (!made.ok) throw new Error('not made')
    const table = made.bundle.tables.fb_tables[0]
    const cols = (JSON.parse(String(table.schema_json)) as { columns: Array<{ id: string; config: { options?: unknown[] } }> }).columns
    expect(cols.find((c) => c.id === 'c2')!.config.options).toEqual([])
    expect(JSON.parse(String(made.bundle.tables.fb_rows[0].cells_json))).toEqual({ c1: 'AAPL', c2: 'o1', c6: 'o4' })
  })

  it('a table widget that lost its table id still finds the table it brought', async () => {
    const snap = daySnapshot() as { task: { widgets: Array<Record<string, unknown>> } }
    snap.task.widgets[1].content = '' // the id is gone; the table data is not
    const made = snapshotToDeskBundle(snap)
    if (!made.ok) throw new Error('not made')
    const { importDeskForShare } = await import('../../src/web/worker/shareCopy')
    await importDeskForShare(made.bundle)
    const tw = one<{ content: string }>('SELECT content FROM widgets WHERE id = ?', 'w-watch')
    expect(tw.content).not.toBe('')
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM fb_rows WHERE table_id = ?', tw.content).n).toBe(2)
  })

  it('refuses what is not a desk or a room, and what it cannot read', () => {
    expect(snapshotToDeskBundle({ _version: 1, kind: 'folder', folder: {}, tasks: [] })).toEqual({ ok: false, why: 'unreadable' }) // a room with no id
    expect(snapshotToDeskBundle({ _version: 1, kind: 'document', title: 'x', html: '' })).toEqual({ ok: false, why: 'not-a-desk' })
    expect(snapshotToDeskBundle(null)).toEqual({ ok: false, why: 'unreadable' })
    expect(snapshotToDeskBundle({ _version: 2, kind: 'task', task: { id: 'd', widgets: [] } })).toEqual({ ok: false, why: 'unreadable' })
    expect(snapshotToDeskBundle({ _version: 1, kind: 'task', task: { widgets: [] } })).toEqual({ ok: false, why: 'unreadable' })
    expect(snapshotToDeskBundle({ _version: 1, kind: 'task', task: { id: 'd' } })).toEqual({ ok: false, why: 'unreadable' })
  })
})

// A room link opens in the full app too (owner, 2026-11-07: every share link
// opens the full web app). A room snapshot carries every desk in it, each with
// its widgets (renderer lib/shareSnapshot buildFolderSnapshot).
describe('a room, made into the room and its desks', () => {
  const task = (id: string, title: string, widgets: unknown[]) => ({
    id, kind: 'task', title, description: '', status: 'open', priority: 3, importance: 3, interest: 3,
    createdAt: 1, updatedAt: 1, completedAt: null, dueDate: null, estimateMinutes: null, widgets
  })
  const room = {
    _version: 1, kind: 'folder', fromHandle: 'silent-tortoise', capturedAt: 1_793_000_000_000,
    folder: { id: 'room-1', kind: 'folder', title: 'Year 6', description: '', status: 'open' },
    tasks: [
      task('desk-math', 'Math', [
        { id: 'w-1', kind: 'sticky', title: 'Ratios', content: 'Unit 1', x: 0, y: 0, width: 200, height: 160 },
        { id: 'w-t', kind: 'table', title: 'Schedule', content: 'tbl-1', x: 300, y: 0, width: 400, height: 300,
          tableSnapshot: { title: 'Schedule', columns: [{ id: 'c1', name: 'Lesson', kind: 'text-short' }], rows: [{ id: 'r1', cells: { c1: 'Ratios' } }] } }
      ]),
      task('desk-ela', 'ELA', [{ id: 'w-1', kind: 'sticky', title: 'Reading', content: 'RL.6', x: 0, y: 0, width: 200, height: 160 }])
    ]
  }

  it('the room is the root; its desks sit inside it, each with its widgets', () => {
    const r = snapshotToDeskBundle(room)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bundle.desk).toEqual({ id: 'room-1', title: 'Year 6' })
    const nodes = r.bundle.tables.nodes as Array<Record<string, unknown>>
    expect(nodes.map((n) => [n.id, n.kind, n.parent_id])).toEqual([
      ['room-1', 'folder', null], ['desk-math', 'task', 'room-1'], ['desk-ela', 'task', 'room-1']
    ])
    const widgets = r.bundle.tables.widgets as Array<Record<string, unknown>>
    expect(widgets.filter((w) => w.task_id === 'desk-math')).toHaveLength(2)
    expect(widgets.filter((w) => w.task_id === 'desk-ela').map((w) => w.content)).toEqual(['RL.6'])
    // Two desks both used the widget id "w-1": the second is made unique, not dropped.
    expect(new Set(widgets.map((w) => w.id)).size).toBe(3)
    expect((r.bundle.tables.fb_tables as unknown[]).length).toBe(1)
    expect((r.bundle.tables.fb_rows as unknown[]).length).toBe(1)
  })

  it('an empty room is still a room', () => {
    const r = snapshotToDeskBundle({ ...room, tasks: [] })
    expect(r.ok && (r.bundle.tables.nodes as unknown[]).length).toBe(1)
  })
})

