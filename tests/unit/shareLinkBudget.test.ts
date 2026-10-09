// A desk, packed to fit a link.
//
// Signal accepts at most 8 MiB of request body on POST and PUT
// /shares/ephemeral. The bundle travels inside that body as a JSON string, so
// each file is base64 (4 bytes for every 3) and every quote in the desk's rows
// is escaped twice over. The desktop used to pack up to 80 MB of raw file bytes
// and let the server say "Payload Too Large". Now it packs to the link budget,
// drops the LARGEST files first, names each one, and refuses -- in a sentence
// -- a desk whose rows alone cannot fit.
//
// Real database (sqlite-wasm, in memory), real buildDeskBundle, real bytes.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'
import {
  LINK_SHARE_MAX_BODY_BYTES, LINK_SHARE_BUNDLE_BUDGET, utf8Bytes
} from '../../src/shared/shareExpiry'

let db: SqliteDb
const blobs = new Map<string, Uint8Array>()
const reads: string[] = []

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/fileBlobs', () => ({
  fileBlobs: {
    write: async (id: string, ext: string, bytes: Uint8Array) => { blobs.set(id + ext, bytes) },
    read: async (id: string, ext: string) => {
      reads.push(id)
      return blobs.get(id + ext) ?? null
    },
    exists: async (id: string, ext: string) => blobs.has(id + ext),
    remove: async () => {},
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))

let mod: typeof import('../../src/main/db/deskBundle')
const NOW = 1_700_000_000_000
const MiB = 1024 * 1024

function desk(id: string, title: string): void {
  db.prepare(`INSERT INTO nodes (id,parent_id,kind,title,description,status,priority,interest,importance,sort_order,created_at,updated_at,extensions_minutes,org_id)
              VALUES (?,NULL,'task',?,'','open',3,3,3,0,?,?,0,'personal')`).run(id, title, NOW, NOW)
}
function widget(id: string, task: string, kind: string, content: string): void {
  db.prepare(`INSERT INTO widgets (id,task_id,kind,title,content,x,y,width,height,z_index,created_at,updated_at)
              VALUES (?,?,?,'',?,0,0,200,200,1,?,?)`).run(id, task, kind, content, NOW, NOW)
}
/** A file row and its bytes. `recorded` lets the row lie about the size. */
function file(task: string, id: string, bytes: number, recorded = bytes): void {
  db.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
              VALUES (?,?,'video/mp4',?,'.mp4',?,'file',?,?,'personal')`).run(id, `${id}.mp4`, recorded, NOW, `${id}.mp4`, NOW)
  const b = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) b[i] = (i * 31 + id.length) & 0xff
  blobs.set(`${id}.mp4`, b)
  widget(`w-${id}`, task, 'file', id)
}

/** The body the renderer sends for a never-expiring mint, exactly. */
const mintBody = (bundle: unknown, title: string): string =>
  JSON.stringify({ rootId: 'x', title, bundle: JSON.stringify(bundle), expires: 'never' })

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(db)

  // A sales demo: a short video, a long one, a deck, a picture.
  desk('demo', 'Q3 pipeline — “demo” desk')
  widget('w-note', 'demo', 'sticky', 'Hello from the “demo”, with "quotes" and \\ backslashes and 日本語')
  file('demo', 'clip-small', 100 * 1024)
  file('demo', 'clip-2m', 2 * MiB)
  file('demo', 'deck-3m', 3 * MiB)
  file('demo', 'video-4m', 4 * MiB)

  // Text-heavy: rows that grow a lot when escaped twice.
  desk('wordy', 'Wordy')
  for (let i = 0; i < 40; i++) widget(`w-wordy-${i}`, 'wordy', 'sticky', `{"rich":"${'\\"'.repeat(2000)}"}`)

  // Many files, none of which can fit, to prove each is still named.
  desk('many', 'Many')
  for (let i = 0; i < 30; i++) file('many', `big-${String(i).padStart(2, '0')}-${'n'.repeat(60)}`, 300 * 1024)

  // A row that says a file is small when it is not.
  desk('liar', 'Liar')
  file('liar', 'claims-small', 9 * MiB, 10)

  mod = await import('../../src/main/db/deskBundle')
}, 60_000)

describe('measuring a bundle the way it travels', () => {
  it('is the UTF-8 size of the bundle as a JSON string inside the body', async () => {
    const b = await mod.buildDeskBundle('wordy')
    const inner = JSON.stringify(b)
    expect(mod.bundleBodyBytes(b)).toBe(utf8Bytes(JSON.stringify(inner)))
    // Not the naive size: the escaped quotes nearly double it.
    expect(mod.bundleBodyBytes(b)).toBeGreaterThan(utf8Bytes(inner) * 1.4)
  })
})

describe('packing to the link budget', () => {
  it('is the default, so both the mint and the update get it', () => {
    expect(mod.DEFAULT_MAX_BODY_BYTES).toBe(LINK_SHARE_BUNDLE_BUDGET)
  })

  it('leaves out the largest files first, names them, and fits the 8 MiB body', async () => {
    const b = await mod.buildDeskBundle('demo')
    expect(b.files.map((f) => f.id)).toEqual(['clip-small', 'clip-2m', 'deck-3m'])
    expect(b.filesOmitted).toEqual([
      { id: 'video-4m', name: 'video-4m.mp4', sizeBytes: 4 * MiB, why: 'a link can carry at most 8 MB' }
    ])
    expect(b.counts.fileBytes).toBe(100 * 1024 + 5 * MiB)
    expect(mod.bundleBodyBytes(b)).toBeLessThanOrEqual(LINK_SHARE_BUNDLE_BUDGET)
    // The request as the renderer will actually send it.
    expect(utf8Bytes(mintBody(b, b.desk.title))).toBeLessThanOrEqual(LINK_SHARE_MAX_BODY_BYTES)
  })

  it('does not read a file it already knows cannot fit', async () => {
    reads.length = 0
    await mod.buildDeskBundle('demo')
    expect(reads).not.toContain('video-4m')
  })

  it('names every file it leaves out, even when none fit', async () => {
    const b = await mod.buildDeskBundle('many', { maxBodyBytes: 120 * 1024 })
    expect(b.files).toEqual([])
    expect(b.filesOmitted).toHaveLength(30)
    expect(new Set(b.filesOmitted.map((f) => f.why))).toEqual(new Set(['a link can carry at most 8 MB']))
    expect(mod.bundleBodyBytes(b)).toBeLessThanOrEqual(120 * 1024)
  })

  it('judges by the bytes, not by a row that understates them', async () => {
    const b = await mod.buildDeskBundle('liar')
    expect(b.files).toEqual([])
    expect(b.filesOmitted).toEqual([
      { id: 'claims-small', name: 'claims-small.mp4', sizeBytes: 9 * MiB, why: 'a link can carry at most 8 MB' }
    ])
    expect(mod.bundleBodyBytes(b)).toBeLessThanOrEqual(LINK_SHARE_BUNDLE_BUDGET)
  })

  it('still honours the raw-bytes cap when it is the tighter one', async () => {
    const b = await mod.buildDeskBundle('demo', { maxBytes: 3 * MiB })
    expect(b.files.map((f) => f.id)).toEqual(['clip-small', 'clip-2m'])
    expect(b.filesOmitted.map((f) => f.why)).toEqual([
      'the bundle is already at its size limit', 'the bundle is already at its size limit'
    ])
  })

  it('refuses, in a sentence, a desk whose rows alone are over the budget', async () => {
    await expect(mod.buildDeskBundle('wordy', { maxBodyBytes: 64 * 1024 })).rejects.toThrow(
      /^This desk is too large to send as a link, even without its files: the rest of it comes to [\d.]+ MB, more than the 0\.1 MB of desk a link can carry \(8 MB in all\)\. Move some of it to another desk and try again\.$/
    )
  })

  it('round-trips what it kept', async () => {
    const b = await mod.buildDeskBundle('demo')
    const deck = b.files.find((f) => f.id === 'deck-3m')!
    expect(mod.fromBase64(deck.data)).toEqual(blobs.get('deck-3m.mp4'))
  })
})

describe('the one channel that packs a link', () => {
  const read = async (rel: string): Promise<string> => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    return readFileSync(resolve(__dirname, '../../', rel), 'utf8')
  }

  it('is called by the link mint and the link update and nothing else', async () => {
    const { execSync } = await import('child_process')
    const { resolve } = await import('path')
    const root = resolve(__dirname, '../../')
    const hits = execSync(`grep -rln "shares.buildDeskBundle(" src/renderer src/web || true`, { cwd: root })
      .toString().trim().split('\n').filter(Boolean)
    expect(hits).toEqual(['src/renderer/src/lib/ephemeralShareClient.ts'])
    const client = await read('src/renderer/src/lib/ephemeralShareClient.ts')
    expect(client.match(/window\.api\.shares\.buildDeskBundle\(deskId\)/g)).toHaveLength(2)
  })

  it('packs with the default budget (no override that could loosen it)', async () => {
    const ipc = await read('src/main/ipc/index.ts')
    expect(ipc).toContain("buildDeskBundle(String(deskId || ''))")
  })
})
