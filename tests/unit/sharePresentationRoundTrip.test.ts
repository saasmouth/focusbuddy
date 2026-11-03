// A desk shared with a presentation, packed by the real buildDeskBundle on a
// sender's database and unpacked by the share page's real Worker code on a
// visitor's (src/web/worker/shareCopy.ts). Real SQLite on both sides; only the
// file store is a map.
//
// What must hold, and why each is here:
//   - a website picture travels inside the presentation and lands in the file
//     store under the id derived from its widget -- and nowhere else
//   - the sender's layout row becomes the visitor's ('local'), because a visitor
//     has no account and the Workcentre otherwise came up auto-arranged with the
//     sender's hidden tiles showing (live link, 2026-11-03)
//   - replacing or removing the desk takes its pictures with it
//   - nothing a stranger's bundle says gets a file written that is not a JPEG
//     under its own widget's id
//   - pictures give way to the link's size budget, smallest kept, never a blank
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
const blobs = new Map<string, Uint8Array>()

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'sender@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))
vi.mock('../../src/main/db/fileBlobs', () => ({
  fileBlobs: {
    write: async (id: string, ext: string, bytes: Uint8Array) => { blobs.set(id + ext, bytes) },
    read: async (id: string, ext: string) => blobs.get(id + ext) ?? null,
    exists: async (id: string, ext: string) => blobs.has(id + ext),
    remove: async (id: string, ext: string) => { blobs.delete(id + ext) },
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))

const NOW = 1_700_000_000_000
type Bundles = typeof import('../../src/main/db/deskBundle')
type Copy = typeof import('../../src/web/worker/shareCopy')
let bundles: Bundles
let copy: Copy

async function freshDb(): Promise<SqliteDb> {
  await initSqlite()
  const d = openMemoryDatabase()
  d.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(d)
  return d
}

function node(d: SqliteDb, id: string, title: string): void {
  d.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id)
             VALUES (?,NULL,'task',?,'','open',3,3,3,0,?,?,0,'personal')`).run(id, title, NOW, NOW)
}
function widget(d: SqliteDb, id: string, kind: string, content: string, x: number, y: number): void {
  d.prepare(`INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,created_at,updated_at)
             VALUES (?,'desk',?,'',?,?,?,1418,797,1,?,?)`).run(id, kind, content, x, y, NOW, NOW)
}
function layout(d: SqliteDb, user: string, json: Record<string, unknown>, updatedAt: string): void {
  d.prepare(`INSERT INTO desk_layouts (user_id, desk_id, device_class, layout_json, updated_at) VALUES (?, 'desk', 'desktop', ?, ?)`)
    .run(user, JSON.stringify({ userId: user, deskId: 'desk', deviceClass: 'desktop', ...json }), updatedAt)
}

/** A JPEG in all the ways the import checks: FF D8 FF, then n more bytes. */
const jpeg = (n: number, fill = 7): Uint8Array => {
  const b = new Uint8Array(3 + n).fill(fill)
  b.set([0xff, 0xd8, 0xff], 0)
  return b
}

const WORKCENTRE = { cols: 15, items: { 'w-sticky': { x: 0, y: 0, w: 5, h: 6 }, 'w-finviz': { x: 5, y: 0, w: 10, h: 12 } }, hidden: ['w-reuters'] }

function senderDesk(d: SqliteDb): void {
  node(d, 'desk', 'Day Trading Workcentre')
  widget(d, 'w-sticky', 'sticky', 'Hard rules', 300, 500)
  widget(d, 'w-finviz', 'webview', 'https://finviz.com/futures', 331, 2128)
  widget(d, 'w-eia', 'webview', 'https://www.eia.gov/petroleum/weekly/', 331, 3232)
  widget(d, 'w-reuters', 'webview', 'https://www.reuters.com/business/', 331, 4336)
  widget(d, 'w-tv', 'webview', 'https://www.tradingview.com/chart/', 331, 5440)
  // The sender's current row: their workcentre, and a camera looking at empty canvas.
  layout(d, 'acc_sender', { customLayout: false, objects: [], scroll: { x: -7768, y: -583 }, zoom: 0.5, selectedObjectIds: ['w-eia'], workcentre: WORKCENTRE }, '2026-11-03T01:00:00.000Z')
  // A stale row from when the sender once used the app signed out.
  layout(d, 'local', { scroll: { x: 0, y: 0 }, zoom: 1, selectedObjectIds: [], workcentre: { cols: 12, items: {}, hidden: [] } }, '2026-09-01T00:00:00.000Z')
}

function presentation(over: Record<string, unknown> = {}): import('../../src/main/db/deskBundle').PresentationInput {
  return {
    view: 'workcentre',
    lockView: true,
    layoutUserId: 'acc_sender',
    columns: { groupBy: 'kind', columns: [{ id: 'col-1', title: 'Charts' }], assign: {}, order: {} },
    sites: {
      'w-finviz': { url: 'https://finviz.com/futures', show: 'picture', picture: { bytes: jpeg(40), width: 1440, height: 810, capturedAt: NOW } },
      'w-eia': { url: 'https://www.eia.gov/petroleum/weekly/', show: 'live' },
      'w-reuters': { url: 'https://www.reuters.com/business/', show: 'link' },
      'w-tv': { url: 'https://www.tradingview.com/chart/', show: 'embed' },
      // Not on this desk: ignored.
      'w-elsewhere': { url: 'https://example.com/', show: 'picture', picture: { bytes: jpeg(10), width: 1, height: 1, capturedAt: NOW } }
    },
    ...over
  }
}

const visitorLayout = (d: SqliteDb): Record<string, unknown> | null => {
  const row = d.prepare(`SELECT layout_json FROM desk_layouts WHERE user_id = 'local' AND desk_id = 'desk' AND device_class = 'desktop'`).get() as
    | { layout_json: string }
    | undefined
  return row ? (JSON.parse(row.layout_json) as Record<string, unknown>) : null
}

let sender: SqliteDb
let visitor: SqliteDb

beforeEach(async () => {
  blobs.clear()
  sender = await freshDb()
  db = sender
  // The sender's desktop has had a desk open, so its layout table exists. The
  // visitor's fresh browser database does not have one (see below).
  const { ensureDeskLayoutSchema } = await import('../../src/main/db/deskLayoutStore')
  ensureDeskLayoutSchema(sender as never)
  senderDesk(sender)
  bundles = await import('../../src/main/db/deskBundle')
  copy = await import('../../src/web/worker/shareCopy')
  visitor = await freshDb()
})

describe('packing a presentation', () => {
  it('carries the view, the lock, the columns setup, whose layout is the sender’s, and each site', async () => {
    const b = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    const p = b.presentation!
    expect(p.view).toBe('workcentre')
    expect(p.lockView).toBe(true)
    expect(p.layoutUserId).toBe('acc_sender')
    expect(p.columns).toEqual(presentation().columns)
    expect(p.sites?.['w-finviz']?.show).toBe('picture')
    expect(p.sites?.['w-finviz']?.picture?.id).toBe('sitepic-w-finviz')
    expect(p.sites?.['w-finviz']?.picture?.data.length).toBeGreaterThan(0)
    expect(p.sites?.['w-eia']).toEqual({ url: 'https://www.eia.gov/petroleum/weekly/', show: 'live' })
    expect(p.sites?.['w-reuters']).toEqual({ url: 'https://www.reuters.com/business/', show: 'link' })
    expect(p.sites?.['w-tv']).toEqual({ url: 'https://www.tradingview.com/chart/', show: 'embed' })
    expect(p.sites?.['w-elsewhere']).toBeUndefined()
    // Not a Drive file: the desk's own file list is untouched.
    expect(b.files).toEqual([])
    expect(b.tables.fb_files).toEqual([])
  })

  it('packs no presentation when none is asked for (every older caller)', async () => {
    const b = await bundles.buildDeskBundle('desk')
    expect('presentation' in b).toBe(false)
  })

  it('lets pictures give way to the budget, smallest kept, the rest as link cards', async () => {
    const sites = presentation().sites!
    sites['w-eia'] = { url: 'https://www.eia.gov/petroleum/weekly/', show: 'picture', picture: { bytes: jpeg(2000), width: 1, height: 1, capturedAt: NOW } }
    sites['w-finviz'] = { url: 'https://finviz.com/futures', show: 'picture', picture: { bytes: jpeg(60_000), width: 1, height: 1, capturedAt: NOW } }
    const base = await bundles.buildDeskBundle('desk', { presentation: presentation({ sites: { ...sites, 'w-eia': { ...sites['w-eia'] }, 'w-finviz': { url: sites['w-finviz'].url, show: 'link' } } }) })
    // Room for the small picture, not the large one.
    const max = bundles.bundleBodyBytes(base) + 10_000
    const b = await bundles.buildDeskBundle('desk', { maxBodyBytes: max, presentation: presentation({ sites }) })
    expect(b.presentation?.sites?.['w-eia']?.show).toBe('picture')
    expect(b.presentation?.sites?.['w-finviz']).toEqual({ url: 'https://finviz.com/futures', show: 'link' })
    expect(bundles.bundleBodyBytes(b)).toBeLessThanOrEqual(max)
  })
})

describe('unpacking it in a visitor’s browser', () => {
  it('has somewhere to put the layout: a fresh browser database has no layout table yet', async () => {
    const tables = (d: SqliteDb): string[] =>
      (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'desk_layouts'`).all() as Array<{ name: string }>).map((r) => r.name)
    expect(tables(visitor)).toEqual([])
    const b = await bundles.buildDeskBundle('desk')
    db = visitor
    await copy.importDeskForShare(b)
    expect(tables(visitor)).toEqual(['desk_layouts'])
    // The sender's rows arrived as well as the visitor's copy.
    expect((visitor.prepare(`SELECT COUNT(*) AS n FROM desk_layouts`).get() as { n: number }).n).toBe(2)
  })

  it('writes the picture under its widget’s id, and only that', async () => {
    const b = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    db = visitor
    const res = await copy.importDeskForShare(b)
    expect(res.ok).toBe(true)
    expect([...blobs.keys()].sort()).toEqual(['sitepic-w-finviz.jpg'])
    expect(blobs.get('sitepic-w-finviz.jpg')).toEqual(jpeg(40))
  })

  it('makes the sender’s layout the visitor’s: their workcentre, a camera on the desk’s content', async () => {
    const b = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    db = visitor
    await copy.importDeskForShare(b)
    const l = visitorLayout(visitor)!
    expect(l.workcentre).toEqual(WORKCENTRE)
    expect(l.userId).toBe('local')
    // Content starts at (300, 500): the camera puts it 40px in from the corner.
    expect(l.scroll).toEqual({ x: 40 - 300, y: 40 - 500 })
    expect(l.zoom).toBe(1)
    expect(l.selectedObjectIds).toEqual([])
  })

  it('without a presentation (a link made before), still adopts the most recent layout row', async () => {
    const b = await bundles.buildDeskBundle('desk')
    db = visitor
    await copy.importDeskForShare(b)
    expect(visitorLayout(visitor)?.workcentre).toEqual(WORKCENTRE)
  })

  it('the plain desktop import is unchanged: no pictures, no copied layout', async () => {
    const b = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    db = visitor
    // A desktop has its layout table, as the sender's does.
    const { ensureDeskLayoutSchema } = await import('../../src/main/db/deskLayoutStore')
    ensureDeskLayoutSchema(visitor as never)
    await bundles.importDeskBundle(b)
    expect(blobs.size).toBe(0)
    // Only the rows the bundle brought; the stale 'local' one among them, untouched.
    expect((visitorLayout(visitor)?.workcentre as { cols: number }).cols).toBe(12)
  })

  it('replacing the desk takes the old version’s pictures and brings the new one’s', async () => {
    const v1 = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    sender.prepare(`DELETE FROM widgets WHERE id = 'w-finviz'`).run()
    widget(sender, 'w-coingecko', 'webview', 'https://www.coingecko.com/', 331, 6544)
    const v2 = await bundles.buildDeskBundle('desk', {
      presentation: presentation({
        sites: { 'w-coingecko': { url: 'https://www.coingecko.com/', show: 'picture', picture: { bytes: jpeg(30, 9), width: 1, height: 1, capturedAt: NOW + 1 } } }
      })
    })
    db = visitor
    await copy.importDeskForShare(v1)
    expect(blobs.has('sitepic-w-finviz.jpg')).toBe(true)
    const out = await copy.replaceDesk(['desk'], v2)
    expect(out.ok).toBe(true)
    expect(blobs.has('sitepic-w-finviz.jpg')).toBe(false)
    expect(blobs.get('sitepic-w-coingecko.jpg')).toEqual(jpeg(30, 9))
    expect(visitorLayout(visitor)?.workcentre).toEqual(WORKCENTRE)
  })

  it('removing the desk takes its pictures', async () => {
    const b = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    db = visitor
    await copy.importDeskForShare(b)
    await copy.removeDesk('desk')
    expect(blobs.size).toBe(0)
    expect(visitorLayout(visitor)).toBeNull()
  })

  it('writes nothing for a picture that is not a JPEG, or that names another widget’s id', async () => {
    const b = await bundles.buildDeskBundle('desk', { presentation: presentation() })
    const pic = b.presentation!.sites!['w-finviz'].picture!
    // An HTML page dressed as a picture.
    pic.data = Buffer.from('<html><script>alert(1)</script></html>').toString('base64')
    // And a second entry trying to plant bytes under somebody else's id.
    b.presentation!.sites!['w-eia'] = {
      url: 'https://www.eia.gov/petroleum/weekly/',
      show: 'picture',
      picture: { ...pic, id: 'sitepic-w-finviz', data: Buffer.from(jpeg(5)).toString('base64') }
    }
    db = visitor
    const res = await copy.importDeskForShare(b)
    expect(res.ok).toBe(true)
    expect(blobs.size).toBe(0)
  })
})
