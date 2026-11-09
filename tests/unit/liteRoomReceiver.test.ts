// @vitest-environment node
// "Open This Room in Plexii", the app end (main/liteRoomReceiver.ts): the link is
// kept until someone is signed in; begin reads the room, ASKS, and only on yes
// copies the files (the drop pipeline's ingest) into a new desk laid out as the
// room was. The database layer is stood in for here (the e2e spec drives the
// real one); the files, the handoff and PlexiiLite's folder are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const h = vi.hoisted(() => ({ userData: '', appData: '', packaged: false, sent: [] as unknown[] }))
vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'userData' ? h.userData : h.appData),
    get isPackaged() {
      return h.packaged
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() }
}))
const db = vi.hoisted(() => ({
  nodes: [] as Array<Record<string, unknown>>,
  widgets: [] as Array<Record<string, unknown>>,
  folders: [] as Array<{ id: string; name: string; parentId: string | null }>,
  ingested: [] as Array<{ from: string; name: string; parentId: string | null }>,
  events: [] as Array<{ eventType: string; objectId: string }>,
  reviewed: [] as string[]
}))
vi.mock('../../src/main/db/nodes', () => ({
  createNode: (d: Record<string, unknown>) => {
    const n = { id: `desk-${db.nodes.length + 1}`, parentId: d.parentId, kind: d.kind, title: d.title, importance: 0, status: 'active' }
    db.nodes.push(n)
    return n
  }
}))
vi.mock('../../src/main/db/widgets', () => ({
  createWidget: (d: Record<string, unknown>) => {
    const w = { ...d, id: `w-${db.widgets.length + 1}`, zIndex: db.widgets.length + 1 }
    db.widgets.push(w)
    return w
  }
}))
vi.mock('../../src/main/db/files', () => ({
  createFolder: (parentId: string | null, name: string) => {
    const f = { id: `folder-${db.folders.length + 1}`, name, parentId }
    db.folders.push(f)
    return f
  }
}))
vi.mock('../../src/main/db/filesFromDisk', () => ({
  ingestFromPath: async (from: string, opts: { originalName: string; parentId: string | null }) => {
    // The copy reads the file: proof it was there to read.
    readFileSync(from)
    db.ingested.push({ from, name: opts.originalName, parentId: opts.parentId })
    return { id: `file-${db.ingested.length}` }
  }
}))
vi.mock('../../src/main/context/engine', () => ({
  emitObjectEvent: (e: { eventType: string; objectId: string }) => db.events.push({ eventType: e.eventType, objectId: e.objectId }),
  markReviewed: (id: string) => db.reviewed.push(id)
}))

const R = await import('../../src/main/liteRoomReceiver')

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/plexiilite-room-v1.json'), 'utf8')) as Record<string, unknown>
const ID = '3b241101-e2bb-4255-8caf-4136c566a962'

let base: string
let lite: string
let room: string
/** The fixture's room on disk (the iCloud recording isn't: it must never be looked for), and its handoff. */
function handOver(patch: (f: Record<string, unknown>) => void = () => {}): void {
  const f = JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>
  f.folder = room
  f.name = 'Launch'
  f.createdAt = new Date().toISOString()
  patch(f)
  writeFileSync(join(lite, 'handoff', `${ID}.json`), JSON.stringify(f))
}
const asked: Array<{ message: string; detail: string }> = []
const answer =
  (yes: boolean) =>
  async (q: { message: string; detail: string }): Promise<boolean> => {
    asked.push(q)
    return yes
  }

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plexii-literoom-recv-')))
  h.userData = join(base, 'userData')
  h.appData = join(base, 'appData')
  mkdirSync(h.userData)
  lite = join(base, 'lite')
  mkdirSync(join(lite, 'handoff'), { recursive: true })
  room = join(base, 'Launch')
  mkdirSync(join(room, 'Ideas'), { recursive: true })
  writeFileSync(join(room, 'budget.csv'), 'item,cost\npaper,3\npens,12\n')
  writeFileSync(join(room, 'notes.txt'), 'first line\n')
  writeFileSync(join(room, 'photo.png'), Buffer.alloc(69, 1))
  writeFileSync(join(room, 'plan.md'), '# Plan\n\nShip the thing.\n')
  for (const k of Object.keys(db)) (db as Record<string, unknown[]>)[k]!.length = 0
  asked.length = 0
  R.resetLiteRoomForTests()
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('keeping the link until someone is signed in', () => {
  it('kept on disk, read back after a restart, forgotten when done', () => {
    expect(R.pendingLiteRoom()).toBeNull()
    expect(R.rememberLiteRoom(ID, 1000)).toEqual({ id: ID, at: 1000 })
    R.resetLiteRoomForTests()
    expect(R.pendingLiteRoom(2000)).toEqual({ id: ID, at: 1000 })
    // Another id's clear leaves it.
    R.clearLiteRoom('00000000-0000-4000-8000-000000000000')
    expect(R.pendingLiteRoom(2000)).toEqual({ id: ID, at: 1000 })
    R.clearLiteRoom(ID)
    expect(R.pendingLiteRoom(2000)).toBeNull()
    expect(existsSync(join(h.userData, 'lite-room.json'))).toBe(false)
  })
  it('not an id: not kept', () => {
    expect(R.rememberLiteRoom('../../etc/passwd')).toBeNull()
    expect(R.pendingLiteRoom()).toBeNull()
  })
  it('a day later it has expired with PlexiiLite\'s handoff, and is dropped', () => {
    R.rememberLiteRoom(ID, 1000)
    expect(R.pendingLiteRoom(1000 + 24 * 60 * 60 * 1000 + 1)).toBeNull()
    R.resetLiteRoomForTests()
    expect(R.pendingLiteRoom(1000)).toBeNull()
  })
  it('a file on disk that isn\'t one of ours is ignored', () => {
    writeFileSync(join(h.userData, 'lite-room.json'), JSON.stringify({ id: 'nope', at: 1 }))
    expect(R.pendingLiteRoom()).toBeNull()
  })
})

describe('where PlexiiLite\'s handoffs are read from', () => {
  it('PlexiiLite\'s own folder; a test profile alone may point elsewhere', () => {
    expect(R.liteDataDir({}, false)).toBe(join(h.appData, 'PlexiiLite'))
    const test = { NODE_ENV: 'test', FB_TEST_USER_DATA: '/tmp/p', FB_TEST_LITE_DATA: '/tmp/lite' }
    expect(R.liteDataDir(test, false)).toBe('/tmp/lite')
    // A packaged build never, whatever its environment says; nor a run that isn't a test.
    expect(R.liteDataDir(test, true)).toBe(join(h.appData, 'PlexiiLite'))
    expect(R.liteDataDir({ FB_TEST_LITE_DATA: '/tmp/lite' }, false)).toBe(join(h.appData, 'PlexiiLite'))
    expect(R.liteDataDir({ ...test, NODE_ENV: 'production' }, false)).toBe(join(h.appData, 'PlexiiLite'))
  })
})

describe('begin: read, ask, and only then bring in', () => {
  it('asks first, naming the folder, the files, the copy and what is left out', async () => {
    handOver()
    R.rememberLiteRoom(ID)
    await R.beginLiteRoom(ID, answer(false), { liteData: lite, home: base })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.message).toBe('Bring “Launch” into Plexii?')
    expect(asked[0]!.detail).toContain('with its own copy of 4 files (133 bytes) and 1 browser window from ~/Launch')
    expect(asked[0]!.detail).toContain('aren’t changed')
    expect(asked[0]!.detail).toContain('• talk.mov. Only in iCloud')
    expect(asked[0]!.detail).toContain('• Ideas. A folder')
  })

  it('no: nothing is copied or made, and the person is told', async () => {
    handOver()
    R.rememberLiteRoom(ID)
    const r = await R.beginLiteRoom(ID, answer(false), { liteData: lite, home: base })
    expect(r).toEqual({ ok: false, stop: 'declined', message: 'Nothing was brought in from “Launch”.' })
    expect(db.ingested).toEqual([])
    expect(db.nodes).toEqual([])
    expect(db.widgets).toEqual([])
    expect(db.folders).toEqual([])
    expect(R.pendingLiteRoom()).toBeNull()
  })

  it('yes: the files copied in, a desk named after the folder, each placed as it was, in the Desk\'s stacking order', async () => {
    handOver()
    R.rememberLiteRoom(ID)
    const r = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Copied from the room, into a Files folder named after it; the recording only in iCloud never touched.
    expect(db.folders).toEqual([{ id: 'folder-1', name: 'Launch', parentId: null }])
    expect(db.ingested.map((i) => [i.name, i.from, i.parentId])).toEqual(
      ['budget.csv', 'notes.txt', 'photo.png', 'plan.md'].map((n) => [n, join(room, n), 'folder-1'])
    )
    expect(db.nodes).toEqual([{ id: 'desk-1', parentId: null, kind: 'task', title: 'Launch', importance: 0, status: 'active' }])
    // Back to front: the Desk's z order, then the never-placed file.
    expect(db.widgets.map((w) => [w.title, w.kind, w.x, w.y, w.width, w.height])).toEqual([
      ['budget.csv', 'file', 540, 60, 520, 340],
      ['plan.md', 'file', 60, 60, 440, 440],
      ['photo.png', 'file', 60, 540, 340, 260],
      ['Plexii', 'webview', 440, 540, 560, 400],
      ['notes.txt', 'file', 60, 988, 320, 240]
    ])
    // A file widget holds Plexii's own copy; the browser its address. All on the new desk.
    expect(db.widgets.find((w) => w.title === 'plan.md')!.content).toBe('file-4')
    expect(db.widgets.find((w) => w.kind === 'webview')!.content).toBe('https://plexiidesk.com/')
    for (const w of db.widgets) expect(w.taskId).toBe('desk-1')
    // The events a create from the window emits, each reviewed by its maker.
    expect(db.events.map((e) => e.eventType)).toEqual(['DeskCreated', ...Array(5).fill('WidgetCreated')])
    expect(db.reviewed).toEqual(['desk-1', 'w-1', 'w-2', 'w-3', 'w-4', 'w-5'])
    // The Workcentre, keyed by the new widgets.
    expect(r.workcentre).toEqual({
      cols: 12,
      items: { 'w-1': { x: 4, y: 0, w: 5, h: 9 }, 'w-2': { x: 0, y: 0, w: 4, h: 12 }, 'w-3': { x: 9, y: 0, w: 3, h: 7, fixW: true }, 'w-4': { x: 0, y: 12, w: 6, h: 11 } }
    })
    expect(r.view).toBe('canvas')
    expect(r.summary).toBe('4 files and 1 browser window brought in from “Launch”; 2 left out: talk.mov (only in iCloud), Ideas (a folder).')
    expect(R.pendingLiteRoom()).toBeNull()
    // The folder is as it was.
    expect(readFileSync(join(room, 'plan.md'), 'utf8')).toBe('# Plan\n\nShip the thing.\n')
  })

  it('a file that went away, or became a link out of the folder, after the question: left out and named', async () => {
    handOver()
    const r = await R.beginLiteRoom(
      ID,
      async (q) => {
        asked.push(q)
        rmSync(join(room, 'notes.txt'))
        rmSync(join(room, 'budget.csv'))
        writeFileSync(join(base, 'secret.csv'), 'secret')
        ;(await import('fs')).symlinkSync(join(base, 'secret.csv'), join(room, 'budget.csv'))
        return true
      },
      { liteData: lite, home: base }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(db.ingested.map((i) => i.name)).toEqual(['photo.png', 'plan.md'])
    expect(r.leftOut).toEqual([
      { name: 'talk.mov', why: 'in-cloud' },
      { name: 'Ideas', why: 'folder' },
      { name: 'budget.csv', why: 'outside' },
      { name: 'notes.txt', why: 'gone' }
    ])
  })

  it('an unknown id, a tampered handoff, a newer one: nothing asked, nothing brought in, a clear message', async () => {
    R.rememberLiteRoom(ID)
    let r = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(r).toMatchObject({ ok: false, stop: 'missing' })
    expect(r.ok ? '' : r.message).toMatch(/isn’t there any more/)
    expect(R.pendingLiteRoom()).toBeNull()
    R.resetLiteRoomForTests()
    handOver((f) => ((f.tiles as Record<string, unknown>[])[0]!.relPath = '../../etc/hosts'))
    r = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(r).toMatchObject({ ok: false, stop: 'schema' })
    R.resetLiteRoomForTests()
    handOver((f) => (f.version = 2))
    r = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(r).toMatchObject({ ok: false, stop: 'newer' })
    expect(r.ok ? '' : r.message).toMatch(/Update Plexii/)
    expect(asked).toEqual([])
    expect(db.ingested).toEqual([])
    expect(db.nodes).toEqual([])
  })

  it('nothing that could come in: said, never asked', async () => {
    handOver((f) => {
      f.tiles = (f.tiles as Record<string, unknown>[]).filter((t) => t.inCloud)
      f.pages = []
    })
    const r = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(r).toMatchObject({ ok: false, stop: 'empty' })
    expect(asked).toEqual([])
    expect(db.nodes).toEqual([])
  })

  it('the same link twice brings the room in once', async () => {
    handOver()
    expect((await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })).ok).toBe(true)
    const again = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(again).toMatchObject({ ok: false, stop: 'done' })
    expect(db.nodes).toHaveLength(1)
    expect(asked).toHaveLength(1)
  })

  it('while it is being asked about, another window\'s begin waits its turn rather than asking twice', async () => {
    handOver()
    let release: (v: boolean) => void = () => {}
    const first = R.beginLiteRoom(ID, () => new Promise<boolean>((res) => (release = res)), { liteData: lite, home: base })
    await new Promise((r) => setTimeout(r, 10))
    expect(await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })).toEqual({ ok: false, stop: 'busy', message: '' })
    release(false)
    expect(await first).toMatchObject({ stop: 'declined' })
  })

  it('the folder gone, or closed to Plexii by macOS: nothing made, and where to allow it is said', async () => {
    handOver()
    rmSync(room, { recursive: true })
    const r = await R.beginLiteRoom(ID, answer(true), { liteData: lite, home: base })
    expect(r).toMatchObject({ ok: false, stop: 'folder' })
    expect(r.ok ? '' : r.message).toBe('~/Launch isn’t there any more, so nothing was brought in.')
    expect(db.nodes).toEqual([])
  })
})
