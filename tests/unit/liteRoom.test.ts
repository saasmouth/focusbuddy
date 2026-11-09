// @vitest-environment node
// "Open This Room in Plexii": the contract with PlexiiLite (shared/liteRoom.ts,
// docs/PLEXIILITE-ROOM-HANDOFF.md). tests/fixtures/plexiilite-room-v1.json is the
// contract's example, kept identical in PlexiiLite's repo, whose tests prove its
// writer makes exactly that file: here the reader is proven to accept it, and to
// refuse it whole when any rule is broken.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  homeShort,
  LITE_ROOM_INFO_KEY,
  LITE_ROOM_MAX_AGE_MS,
  LITE_ROOM_VERSION,
  liteRoomLink,
  liteRoomNothing,
  liteRoomQuestion,
  liteRoomSummary,
  mapLiteRoomLayout,
  parseLiteRoom,
  parseLiteRoomLink,
  planLiteRoom,
  sizeWords,
  type LiteRoom,
  type LiteRoomObject
} from '../../src/shared/liteRoom'
import { claimsDeepLinks } from '../../src/shared/deepLink'

const FIXTURE_TEXT = readFileSync(resolve(__dirname, '../fixtures/plexiilite-room-v1.json'), 'utf8')
const fixture = (): Record<string, unknown> => JSON.parse(FIXTURE_TEXT) as Record<string, unknown>
const NOW = Date.parse('2026-11-09T09:31:00.000Z')
const ID = '3b241101-e2bb-4255-8caf-4136c566a962'

const parsedFixture = (): LiteRoom => {
  const r = parseLiteRoom(fixture(), NOW)
  if (!r.ok) throw new Error(`fixture refused: ${r.refusal} ${r.detail}`)
  return r.room
}

describe('the link', () => {
  it('carries one version 4 UUID, and nothing else is one', () => {
    expect(parseLiteRoomLink(liteRoomLink(ID))).toBe(ID)
    expect(parseLiteRoomLink(`plexii://lite-room?id=${ID}`)).toBe(ID)
    // The legacy scheme is answered, as every link kind is.
    expect(parseLiteRoomLink(`haptyx://lite-room?id=${ID}`)).toBe(ID)
    for (const bad of [
      `plexii://lite-room?id=${ID.toUpperCase()}`,
      'plexii://lite-room?id=3b241101-e2bb-1255-8caf-4136c566a962', // version 1
      'plexii://lite-room?id=../../../etc/passwd',
      'plexii://lite-room?id=%2e%2e%2fhandoff',
      `plexii://lite-room?id=${ID}&id=${ID}`,
      'plexii://lite-room',
      `plexii://desk?id=${ID}`,
      `https://lite-room?id=${ID}`,
      `plexii://lite-room?room=${ID}`,
      'not a url'
    ])
      expect(parseLiteRoomLink(bad), bad).toBeNull()
  })
})

describe('the file', () => {
  it('the contract\'s fixture is accepted, as written', () => {
    const room = parsedFixture()
    expect(room.name).toBe('Launch')
    expect(room.tiles.map((t) => t.name)).toEqual(['budget.csv', 'notes.txt', 'photo.png', 'plan.md', 'talk.mov'])
    expect(room.tiles.find((t) => t.name === 'photo.png')!.workcentre).toEqual({ x: 9, y: 0, w: 3, h: 7, fixW: true })
    expect(room.pages).toHaveLength(1)
  })

  it('fields it doesn\'t know are ignored (a later version 1 writer may add one)', () => {
    const f = fixture()
    f.extra = { anything: true }
    ;(f.tiles as Record<string, unknown>[])[0]!.colour = 'red'
    expect(parseLiteRoom(f, NOW).ok).toBe(true)
  })

  // Each mutation of the fixture, and what it is refused as: the whole file, never part of it.
  const mutations: [string, (f: Record<string, unknown>) => void, string][] = [
    ['not a room', (f) => (f.format = 'plexii.desk'), 'format'],
    ['a newer version', (f) => (f.version = 2), 'newer'],
    ['version 0', (f) => (f.version = 0), 'schema'],
    ['a version that is no integer', (f) => (f.version = '1'), 'schema'],
    ['expired: older than a day', (f) => (f.createdAt = new Date(NOW - LITE_ROOM_MAX_AGE_MS - 1000).toISOString()), 'expired'],
    ['from the future', (f) => (f.createdAt = new Date(NOW + 10 * 60 * 1000).toISOString()), 'future'],
    ['no date', (f) => (f.createdAt = 'yesterday'), 'schema'],
    ['a relative folder', (f) => (f.folder = 'Projects/Launch'), 'schema'],
    ['a folder climbing out', (f) => (f.folder = '/Users/someone/../../etc/Launch'), 'schema'],
    ['a folder with a . part', (f) => (f.folder = '/Users/someone/./Launch'), 'schema'],
    ['a folder with //', (f) => (f.folder = '/Users//someone/Launch'), 'schema'],
    ['a folder with a trailing /', (f) => (f.folder = '/Users/someone/Projects/Launch/'), 'schema'],
    ['the root as the folder', (f) => ((f.folder = '/'), (f.name = '')), 'schema'],
    ['a name that isn\'t the folder\'s', (f) => (f.name = 'Other'), 'schema'],
    ['an unknown view', (f) => (f.view = 'kanban'), 'schema'],
    ['no columns but a number', (f) => (f.cols = 0), 'schema'],
    ['a tile name with /', (f) => tile(f, 0, { name: 'a/b', relPath: 'a/b' }), 'schema'],
    ['a tile named ..', (f) => tile(f, 0, { name: '..', relPath: '..' }), 'schema'],
    ['a relPath climbing out', (f) => tile(f, 0, { relPath: '../secret.txt' }), 'schema'],
    ['a relPath into a sub-folder', (f) => tile(f, 0, { relPath: 'Ideas/idea.md' }), 'schema'],
    ['an absolute relPath', (f) => tile(f, 0, { relPath: '/etc/passwd' }), 'schema'],
    ['a NUL in a name', (f) => tile(f, 0, { name: 'a\0b', relPath: 'a\0b' }), 'schema'],
    ['a name twice', (f) => tile(f, 1, { name: 'budget.csv', relPath: 'budget.csv' }), 'schema'],
    ['a folder named as a tile', (f) => ((f.folders as Record<string, unknown>[])[0] = { name: 'plan.md', relPath: 'plan.md' }), 'schema'],
    ['a folder with a path', (f) => ((f.folders as Record<string, unknown>[])[0] = { name: 'Ideas', relPath: '../Ideas' }), 'schema'],
    ['a kind with capitals', (f) => tile(f, 0, { kind: 'Sheet' }), 'schema'],
    ['a negative size', (f) => tile(f, 0, { size: -1 }), 'schema'],
    ['a size that is no integer', (f) => tile(f, 0, { size: 1.5 }), 'schema'],
    ['inCloud missing', (f) => tile(f, 0, { inCloud: undefined }), 'schema'],
    ['inCloud as a word', (f) => tile(f, 0, { inCloud: 'no' }), 'schema'],
    ['a Desk size of 0', (f) => tile(f, 0, { desk: { x: 0, y: 0, w: 0, h: 10, z: 1 } }), 'schema'],
    ['a Desk place as a word', (f) => tile(f, 0, { desk: { x: '0', y: 0, w: 10, h: 10, z: 1 } }), 'schema'],
    ['a Desk place too far out', (f) => tile(f, 0, { desk: { x: 1e9, y: 0, w: 10, h: 10, z: 1 } }), 'schema'],
    ['a cell of no width', (f) => tile(f, 0, { workcentre: { x: 0, y: 0, w: 0, h: 1 } }), 'schema'],
    ['a cell at half a column', (f) => tile(f, 0, { workcentre: { x: 0.5, y: 0, w: 1, h: 1 } }), 'schema'],
    ['a cell with fixW as a word', (f) => tile(f, 0, { workcentre: { x: 0, y: 0, w: 1, h: 1, fixW: 'yes' } }), 'schema'],
    ['a page that is no web address', (f) => ((f.pages as Record<string, unknown>[])[0]!.url = 'javascript:alert(1)'), 'schema'],
    ['a page on file://', (f) => ((f.pages as Record<string, unknown>[])[0]!.url = 'file:///etc/passwd'), 'schema'],
    ['a page title too long', (f) => ((f.pages as Record<string, unknown>[])[0]!.title = 'x'.repeat(301)), 'schema'],
    ['more than 2,000 tiles', (f) => (f.tiles = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}`, relPath: `f${i}`, kind: 'code', size: 1, inCloud: false, desk: null, workcentre: null }))), 'schema'],
    ['a negative count of more', (f) => (f.more = { files: -1, folders: 0 }), 'schema'],
    ['tiles that are no list', (f) => (f.tiles = {}), 'schema']
  ]
  function tile(f: Record<string, unknown>, i: number, patch: Record<string, unknown>): void {
    const t = (f.tiles as Record<string, unknown>[])[i]!
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete t[k]
      else t[k] = v
    }
  }
  for (const [what, mutate, refusal] of mutations) {
    it(`refuses ${what}`, () => {
      const f = fixture()
      mutate(f)
      const r = parseLiteRoom(f, NOW)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.refusal).toBe(refusal)
    })
  }
  it('refuses what isn\'t an object at all', () => {
    for (const v of [null, 'room', 42, [fixture()]]) expect(parseLiteRoom(v, NOW).ok).toBe(false)
  })
})

describe('what comes in, and what is left out (before asking)', () => {
  it('the fixture: four files and the browser window; the recording only in iCloud and the folder are left out', () => {
    const plan = planLiteRoom(parsedFixture())
    expect(plan.bring.map((t) => t.name)).toEqual(['budget.csv', 'notes.txt', 'photo.png', 'plan.md'])
    expect(plan.bytes).toBe(27 + 11 + 69 + 26)
    expect(plan.pages).toHaveLength(1)
    expect(plan.leftOut).toEqual([
      { name: 'talk.mov', why: 'in-cloud' },
      { name: 'Ideas', why: 'folder' }
    ])
  })
  it('Plexii\'s limits, in the room\'s order: the count, then the size; what PlexiiLite didn\'t list is counted', () => {
    const room = { ...parsedFixture(), more: { files: 12, folders: 1 } }
    const byCount = planLiteRoom(room, { files: 2, bytes: 1e9 })
    expect(byCount.bring.map((t) => t.name)).toEqual(['budget.csv', 'notes.txt'])
    expect(byCount.leftOut.filter((l) => l.why === 'count').map((l) => l.name)).toEqual(['photo.png', 'plan.md'])
    const bySize = planLiteRoom(room, { files: 200, bytes: 40 })
    expect(bySize.bring.map((t) => t.name)).toEqual(['budget.csv', 'notes.txt'])
    expect(bySize.leftOut.filter((l) => l.why === 'size').map((l) => l.name)).toEqual(['photo.png', 'plan.md'])
    expect(byCount.leftOut.filter((l) => l.why === 'unlisted').map((l) => l.name)).toEqual(['12 more files', '1 more folder'])
  })
})

describe('the words', () => {
  const plan = planLiteRoom(parsedFixture())
  it('the question names the folder, how many and how much, the copy, and what is left out and why', () => {
    const q = liteRoomQuestion(plan, '/Users/someone')
    expect(q.message).toBe('Bring “Launch” into Plexii?')
    expect(q.buttons).toEqual(['Bring In', 'Cancel'])
    expect(q.detail).toContain('a new desk, “Launch”, with its own copy of 4 files (133 bytes) and 1 browser window from ~/Projects/Launch')
    expect(q.detail).toContain('The folder and its files aren’t changed: Plexii keeps its own copy.')
    expect(q.detail).toContain('Left out (2):')
    expect(q.detail).toContain('• talk.mov. Only in iCloud, so Plexii doesn’t download it.')
    expect(q.detail).toContain('• Ideas. A folder: only the files directly in the room come in.')
  })
  it('the summary after says what came in and what didn\'t', () => {
    expect(liteRoomSummary('Projects', 24, 0, [])).toBe('24 files brought in from “Projects”.')
    expect(liteRoomSummary('Launch', 4, 1, plan.leftOut)).toBe('4 files and 1 browser window brought in from “Launch”; 2 left out: talk.mov (only in iCloud), Ideas (a folder).')
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, why: 'gone' as const }))
    expect(liteRoomSummary('X', 1, 0, many)).toBe('1 file brought in from “X”; 5 left out: a (no longer there), b (no longer there), c (no longer there) and 2 more.')
  })
  it('nothing to bring: says why instead of asking', () => {
    const empty = planLiteRoom({ ...parsedFixture(), tiles: parsedFixture().tiles.filter((t) => t.inCloud), pages: [] })
    expect(liteRoomNothing(empty)).toBe('Nothing in “Launch” can be brought into Plexii. talk.mov. Only in iCloud, so Plexii doesn’t download it. Ideas. A folder: only the files directly in the room come in.')
  })
  it('sizes and paths as people read them', () => {
    expect(sizeWords(133)).toBe('133 bytes')
    expect(sizeWords(18_200_000)).toBe('18 MB')
    expect(sizeWords(3_400_000)).toBe('3.4 MB')
    expect(sizeWords(1_200_000_000)).toBe('1.2 GB')
    expect(homeShort('/Users/someone/Desktop/X', '/Users/someone')).toBe('~/Desktop/X')
    expect(homeShort('/Users/someoneelse/X', '/Users/someone')).toBe('/Users/someoneelse/X')
  })
})

describe('where things go on the desk', () => {
  const room = parsedFixture()
  const objects: LiteRoomObject[] = [
    ...planLiteRoom(room).bring.map((t) => ({ key: t.name, kind: 'file' as const, desk: t.desk, cell: t.workcentre })),
    ...room.pages.map((p, i) => ({ key: `page/${i}`, kind: 'page' as const, desk: p.desk, cell: p.workcentre }))
  ]
  const layout = mapLiteRoomLayout(objects, room.cols, room.view)
  it('the Desk\'s places, moved together to start at the canvas\'s top left, sizes kept', () => {
    // The fixture's top-left is (40, 40): everything moves by (+20, +20).
    expect(layout.canvas['plan.md']).toEqual({ x: 60, y: 60, width: 440, height: 440 })
    expect(layout.canvas['budget.csv']).toEqual({ x: 540, y: 60, width: 520, height: 340 })
    expect(layout.canvas['photo.png']).toEqual({ x: 60, y: 540, width: 340, height: 260 })
    expect(layout.canvas['page/0']).toEqual({ x: 440, y: 540, width: 560, height: 400 })
  })
  it('a tile never placed goes below the rest, at a dropped file\'s size', () => {
    // Below the lowest (the page: 540 + 400) with a gap.
    expect(layout.canvas['notes.txt']).toEqual({ x: 60, y: 540 + 400 + 48, width: 320, height: 240 })
  })
  it('made back to front, so the stacking order is the Desk\'s', () => {
    expect(layout.order).toEqual(['budget.csv', 'plan.md', 'photo.png', 'page/0', 'notes.txt'])
  })
  it('the Workcentre\'s tiles, cell for cell, in its columns; the view it was in', () => {
    expect(layout.workcentre).toEqual({
      cols: 12,
      items: {
        'budget.csv': { x: 4, y: 0, w: 5, h: 9 },
        'photo.png': { x: 9, y: 0, w: 3, h: 7, fixW: true },
        'plan.md': { x: 0, y: 0, w: 4, h: 12 },
        'page/0': { x: 0, y: 12, w: 6, h: 11 }
      }
    })
    expect(layout.view).toBe('canvas')
    expect(mapLiteRoomLayout(objects, room.cols, 'workcentre').view).toBe('workcentre')
    expect(mapLiteRoomLayout(objects, room.cols, 'list').view).toBe('list')
    expect(mapLiteRoomLayout(objects, room.cols, 'focus').view).toBe('canvas')
  })
  it('a room never arranged: every tile in rows, no Workcentre', () => {
    const bare = objects.map((o) => ({ ...o, desk: null, cell: null }))
    const l = mapLiteRoomLayout(bare, null, 'list')
    expect(l.workcentre).toBeNull()
    expect(l.order).toEqual(bare.map((o) => o.key))
    expect(l.canvas['budget.csv']).toEqual({ x: 60, y: 60, width: 320, height: 240 })
    expect(l.canvas['notes.txt']).toEqual({ x: 60 + 344, y: 60, width: 320, height: 240 })
    // No row is wider than 1,200 px past the origin.
    for (const p of Object.values(l.canvas)) expect(p.x + p.width).toBeLessThanOrEqual(60 + 1200)
  })
  it('a cell wider than the columns is narrowed to them', () => {
    const wide = mapLiteRoomLayout([{ key: 'a', kind: 'file', desk: null, cell: { x: 0, y: 0, w: 30, h: 4 } }], 12, 'workcentre')
    expect(wide.workcentre!.items.a!.w).toBe(12)
  })
})

describe('what this build tells PlexiiLite', () => {
  it('its Info.plist says it reads this handoff version, under the key PlexiiLite reads', async () => {
    const mod = (await import('../../electron-builder.cjs')) as { default?: unknown }
    const raw = (mod.default ?? mod) as unknown
    const cfg = (typeof raw === 'function' ? (raw as () => unknown)() : raw) as { mac: { extendInfo: Record<string, unknown> } }
    expect(LITE_ROOM_INFO_KEY).toBe('PlexiiTakesLiteRooms')
    expect(cfg.mac.extendInfo[LITE_ROOM_INFO_KEY]).toBe(LITE_ROOM_VERSION)
  })
})

describe('who registers for plexii:// links', () => {
  const base = { office: false, preview: false, packaged: true, platform: 'darwin', env: {} as Record<string, string | undefined> }
  it('the installed app does', () => {
    expect(claimsDeepLinks(base)).toBe(true)
    expect(claimsDeepLinks({ ...base, packaged: false, platform: 'win32' })).toBe(true)
  })
  it('never PlexiOffice or the preview', () => {
    expect(claimsDeepLinks({ ...base, office: true })).toBe(false)
    expect(claimsDeepLinks({ ...base, preview: true })).toBe(false)
  })
  it('never a test run: the owner\'s links stay with the owner\'s Plexii', () => {
    expect(claimsDeepLinks({ ...base, packaged: false, env: { NODE_ENV: 'test', FB_TEST_USER_DATA: '/tmp/x' } })).toBe(false)
    expect(claimsDeepLinks({ ...base, env: { FB_TEST_USER_DATA: '/tmp/x' } })).toBe(false)
    expect(claimsDeepLinks({ ...base, packaged: false, env: { NODE_ENV: 'test', FB_TEST_USER_DATA: '/tmp/x', PLEXII_DEV_CLAIM_LINKS: '1' } })).toBe(false)
  })
  it('an unpackaged run on macOS only when a developer asks', () => {
    expect(claimsDeepLinks({ ...base, packaged: false })).toBe(false)
    expect(claimsDeepLinks({ ...base, packaged: false, env: { PLEXII_DEV_CLAIM_LINKS: '1' } })).toBe(true)
  })
})
