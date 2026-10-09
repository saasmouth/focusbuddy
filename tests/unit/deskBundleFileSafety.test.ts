// What a desk bundle may call the files it carries.
//
// A bundle comes from whoever made the link, and a file's `ext` is not just
// data: it becomes part of a name -- the blob's on OPFS in a visitor's browser,
// and a real path (userData/files/<id><ext>) when a desk file is opened on the
// desktop. A link that said `ext: '.html'` planted <id>.html, which the share
// page's file Service Worker served as a page of the share origin. Import now
// holds every file to a list (deskBundle.safeBundledFileType); these tests hold
// import to that, on a real SQLite database with the browser schema.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
const blobs = new Map<string, Uint8Array>()
const writes: string[] = []

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'visitor@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))
vi.mock('../../src/main/db/fileBlobs', () => ({
  fileBlobs: {
    write: async (id: string, ext: string, bytes: Uint8Array) => {
      writes.push(id + ext)
      blobs.set(id + ext, bytes)
    },
    read: async (id: string, ext: string) => blobs.get(id + ext) ?? null,
    exists: async (id: string, ext: string) => blobs.has(id + ext),
    remove: async (id: string, ext: string) => {
      blobs.delete(id + ext)
    },
    locate: (id: string, ext: string) => `mem:/${id}${ext}`
  }
}))

let mod: typeof import('../../src/main/db/deskBundle')
const NOW = 1_700_000_000_000

beforeAll(async () => {
  await initSqlite()
  mod = await import('../../src/main/db/deskBundle')
})

beforeEach(async () => {
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(db)
  blobs.clear()
  writes.length = 0
})

describe('safeBundledFileType', () => {
  it.each([
    // A name and a type the list knows, agreeing: kept.
    ['.png', 'image/png', '.png', 'image/png'],
    ['.jpg', 'image/jpeg', '.jpg', 'image/jpeg'],
    ['.svg', 'image/svg+xml', '.svg', 'image/svg+xml'],
    ['.pdf', 'application/pdf', '.pdf', 'application/pdf'],
    ['.mp4', 'video/mp4', '.mp4', 'video/mp4'],
    ['.wav', 'audio/x-wav', '.wav', 'audio/x-wav'],
    ['.csv', 'application/vnd.ms-excel', '.csv', 'application/vnd.ms-excel'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    // Case and parameters are not part of either.
    ['.PNG', 'Image/PNG; charset=binary', '.png', 'image/png'],
    // A known name with a type that disagrees: the name's own type.
    ['.png', 'text/html', '.png', 'image/png'],
    ['.pdf', 'text/html', '.pdf', 'application/pdf'],
    ['.svg', 'text/html', '.svg', 'image/svg+xml'],
    // An unknown name: renamed by the type when the list knows the type...
    ['.html', 'image/png', '.png', 'image/png'],
    ['.exe', 'application/pdf', '.pdf', 'application/pdf'],
    ['.xyz', 'application/vnd.ms-excel', '.xls', 'application/vnd.ms-excel'],
    ['.xyz', 'audio/x-wav', '.wav', 'audio/x-wav'],
    // ...and to .bin when it does not.
    ['.html', 'text/html', '.bin', 'application/octet-stream'],
    ['.htm', 'text/html', '.bin', 'application/octet-stream'],
    ['.xhtml', 'application/xhtml+xml', '.bin', 'application/octet-stream'],
    ['.js', 'text/javascript', '.bin', 'application/octet-stream'],
    ['.command', 'application/x-sh', '.bin', 'application/octet-stream'],
    ['.app', '', '.bin', 'application/octet-stream'],
    ['/../../../Library/LaunchAgents/x.plist', 'application/xml', '.bin', 'application/octet-stream'],
    ['.png/../x', 'image/png', '.png', 'image/png'],
    ['.constructor', 'x/y', '.bin', 'application/octet-stream'],
    ['png', 'text/plain', '.txt', 'text/plain'],
    // No name: a folder or document keeps none; a file of a known type gets
    // that type's; a file of an unknown type stays extensionless bytes.
    ['', '', '', ''],
    ['', 'image/png', '.png', 'image/png'],
    ['', 'text/html', '', 'application/octet-stream'],
    // Not strings at all: no name and no type, which can only ever be a download.
    [null, null, '', ''],
    [42, { type: 'image/png' }, '', ''],
    [42, 'text/html', '', 'application/octet-stream']
  ])('(%j, %j) -> (%j, %j)', (ext, mime, wantExt, wantMime) => {
    expect(mod.safeBundledFileType(ext, mime)).toEqual({ ext: wantExt, mimeType: wantMime })
  })

  it('is idempotent: what it returns, it returns unchanged', () => {
    const samples: Array<[unknown, unknown]> = [
      ['.html', 'text/html'], ['', 'image/png'], ['.xyz', 'application/vnd.ms-excel'], ['', 'text/html'], ['', ''],
      ...[...mod.BUNDLE_FILE_TYPES].flatMap(([ext, types]) => types.map((t) => [ext, t] as [string, string]))
    ]
    for (const [ext, mime] of samples) {
      const once = mod.safeBundledFileType(ext, mime)
      expect(mod.safeBundledFileType(once.ext, once.mimeType), JSON.stringify([ext, mime])).toEqual(once)
    }
  })

  it('never returns a name that can execute or leave the files directory', () => {
    const hostile = ['.html', '.htm', '.xhtml', '.xht', '.xml', '.xsl', '.svgz', '.js', '.mjs', '.css', '.wasm',
      '.swf', '.exe', '.app', '.command', '.sh', '.bat', '.ps1', '.jar', '.dmg', '.pkg', '.msi', '.scpt',
      '.terminal', '.webloc', '.url', '.lnk', '.desktop', '.php', '/../x', '\\..\\x', '.png/..', '.html\u0000.png']
    const mimes = ['', 'text/html', 'application/xhtml+xml', 'text/javascript', 'image/svg+xml', 'application/octet-stream']
    for (const ext of hostile) {
      for (const mime of mimes) {
        const out = mod.safeBundledFileType(ext, mime)
        expect(out.ext === '' || mod.BUNDLE_FILE_TYPES.has(out.ext) || out.ext === mod.FALLBACK_FILE_EXT, `${ext} ${mime} -> ${out.ext}`).toBe(true)
        expect(out.ext).not.toMatch(/[/\\]|\.\./)
        expect(out.ext).not.toMatch(/^\.(html?|xhtml|xml|js|mjs|css|exe|app|command|sh)$/)
      }
    }
  })
})

const enc = (s: string): string => btoa(s)
const ID = {
  png: '0b5f8a52-3c1e-4d7a-9f20-6e1c4b8a2d11',
  page: '1c6e9b63-4d2f-4e8b-8a31-7f2d5c9b3e22',
  svg: '2d7fac74-5e3a-4f9c-9b42-8a3e6dac4f33',
  sneaky: '3e80bd85-6f4b-4a0d-8c53-9b4f7ebd5a44',
  noRow: '4f91ce96-7a5c-4b1e-9d64-ac5a8fce6b55'
}

/** A desk from a link that tries every trick with its files. */
function hostileBundle(): import('../../src/main/db/deskBundle').DeskBundle {
  const file = (id: string, ext: string, mime: string, name: string): Record<string, unknown> => ({
    id, original_name: name, mime_type: mime, size_bytes: 4, ext, created_at: NOW, kind: 'file',
    display_name: name, updated_at: NOW, org_id: 'personal'
  })
  return {
    format: 'plexii.desk',
    formatVersion: 1,
    exportedAt: new Date(NOW).toISOString(),
    desk: { id: 'desk-x', title: 'A desk' },
    counts: {},
    tables: {
      nodes: [{ id: 'desk-x', parent_id: null, kind: 'task', title: 'A desk', created_at: NOW, updated_at: NOW }],
      widgets: [
        { id: 'w-img', task_id: 'desk-x', kind: 'image', title: '', content: `fb-file://${ID.png}`, x: 0, y: 0, width: 100, height: 100, created_at: NOW, updated_at: NOW },
        { id: 'w-page', task_id: 'desk-x', kind: 'file', title: '', content: ID.page, x: 0, y: 0, width: 100, height: 100, created_at: NOW, updated_at: NOW }
      ],
      fb_files: [
        file(ID.png, '.png', 'image/png', 'photo.png'),
        file(ID.page, '.html', 'text/html', 'invoice.html'),
        file(ID.svg, '.svg', 'image/svg+xml', 'logo.svg'),
        // Claims a PNG in its type; its name says it is a page.
        file(ID.sneaky, '.html', 'image/png', 'totally-a-picture.html'),
        // Ids that are paths.
        file('../../../Library/LaunchAgents/evil', '.plist', 'application/xml', 'evil.plist'),
        file('x.y', '.png', 'image/png', 'dotted.png'),
        file('a/b', '.png', 'image/png', 'slashed.png')
      ]
    },
    files: [
      { id: ID.png, ext: '.png', mimeType: 'image/png', sizeBytes: 4, data: enc('\x89PNG') },
      { id: ID.page, ext: '.html', mimeType: 'text/html', sizeBytes: 4, data: enc('<script>x</script>') },
      { id: ID.svg, ext: '.svg', mimeType: 'image/svg+xml', sizeBytes: 4, data: enc('<svg/>') },
      // The bytes' own ext disagrees with the row's: the row decides.
      { id: ID.sneaky, ext: '.html', mimeType: 'text/html', sizeBytes: 4, data: enc('<script>y</script>') },
      { id: '../../../Library/LaunchAgents/evil', ext: '.plist', mimeType: 'application/xml', sizeBytes: 4, data: enc('<plist/>') },
      { id: 'x.y', ext: '.png', mimeType: 'image/png', sizeBytes: 4, data: enc('png') },
      // Bytes for a file the bundle does not describe.
      { id: ID.noRow, ext: '.html', mimeType: 'text/html', sizeBytes: 4, data: enc('<script>z</script>') }
    ],
    filesOmitted: []
  }
}

const fileRow = (id: string): { ext: string; mime_type: string; original_name: string } | undefined =>
  db.prepare('SELECT ext, mime_type, original_name FROM fb_files WHERE id = ?').get(id) as never

describe('importing a bundle that tries to plant a page', () => {
  it('stores every file under a name from the list, and its row agrees', async () => {
    const res = await mod.importDeskBundle(hostileBundle())
    expect(res.ok, res.reason).toBe(true)

    expect(fileRow(ID.png)).toMatchObject({ ext: '.png', mime_type: 'image/png' })
    expect(fileRow(ID.page)).toMatchObject({ ext: '.bin', mime_type: 'application/octet-stream', original_name: 'invoice.html' })
    expect(fileRow(ID.svg)).toMatchObject({ ext: '.svg', mime_type: 'image/svg+xml' })
    expect(fileRow(ID.sneaky)).toMatchObject({ ext: '.png', mime_type: 'image/png' })

    expect(blobs.get(`${ID.png}.png`)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    expect(new TextDecoder().decode(blobs.get(`${ID.page}.bin`))).toBe('<script>x</script>')
    expect(blobs.has(`${ID.svg}.svg`)).toBe(true)
    expect(blobs.has(`${ID.sneaky}.png`)).toBe(true)
    // Nothing was ever written under a name the list refuses.
    expect(writes.filter((w) => /\.html$|\.plist$|\//.test(w))).toEqual([])
    expect(res.filesWritten).toBe(4)
  })

  it('does not import a file whose id could be a path, nor write its bytes', async () => {
    const res = await mod.importDeskBundle(hostileBundle())
    expect(res.ok).toBe(true)
    for (const id of ['../../../Library/LaunchAgents/evil', 'x.y', 'a/b']) expect(fileRow(id)).toBeUndefined()
    expect(res.byTable.fb_files).toEqual({ imported: 4, skipped: 3 })
    expect([...blobs.keys()].some((k) => k.includes('..') || k.includes('/') || k.startsWith('x.y'))).toBe(false)
  })

  it('writes no bytes for a file the bundle does not describe', async () => {
    await mod.importDeskBundle(hostileBundle())
    expect([...blobs.keys()].filter((k) => k.startsWith(ID.noRow))).toEqual([])
  })
})

describe('bytes already here are not replaced', () => {
  it("a desk file carrying the id of the recipient's own file cannot change what is in it", async () => {
    // The recipient's own file, already here (on the desktop: their own Drive).
    db.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
                VALUES (?,'mine.png','image/png',3,'.png',?,'file','mine.png',?,'personal')`).run(ID.png, NOW, NOW)
    blobs.set(`${ID.png}.png`, new Uint8Array([1, 2, 3]))

    const res = await mod.importDeskBundle(hostileBundle())
    expect(res.ok).toBe(true)
    expect(blobs.get(`${ID.png}.png`)).toEqual(new Uint8Array([1, 2, 3]))
    expect(writes).not.toContain(`${ID.png}.png`)
  })

  it('but a row that is here without its bytes gets them', async () => {
    db.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
                VALUES (?,'photo.png','image/png',4,'.png',?,'file','photo.png',?,'personal')`).run(ID.png, NOW, NOW)
    await mod.importDeskBundle(hostileBundle())
    expect(blobs.get(`${ID.png}.png`)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('and a row an older build stored under a refused name gets no bytes under that name', async () => {
    db.prepare(`INSERT INTO fb_files (id,original_name,mime_type,size_bytes,ext,created_at,kind,display_name,updated_at,org_id)
                VALUES (?,'invoice.html','text/html',4,'.html',?,'file','invoice.html',?,'personal')`).run(ID.page, NOW, NOW)
    await mod.importDeskBundle(hostileBundle())
    expect(writes.filter((w) => w.startsWith(ID.page))).toEqual([])
  })
})

describe('an ordinary desk is unchanged by any of this', () => {
  it('folders and documents keep their empty name and type', async () => {
    const b = hostileBundle()
    b.tables.fb_files = [
      { id: 'f0f0f0f0-0000-4000-8000-000000000001', original_name: 'Folder', mime_type: '', size_bytes: 0, ext: '', created_at: NOW, kind: 'folder', display_name: 'Folder', updated_at: NOW, org_id: 'personal' },
      { id: 'd0d0d0d0-0000-4000-8000-000000000002', original_name: 'Doc', mime_type: '', size_bytes: 0, ext: '', created_at: NOW, kind: 'doc', display_name: 'Doc', updated_at: NOW, org_id: 'personal' }
    ]
    b.files = []
    const res = await mod.importDeskBundle(b)
    expect(res.ok, res.reason).toBe(true)
    expect(fileRow('f0f0f0f0-0000-4000-8000-000000000001')).toMatchObject({ ext: '', mime_type: '' })
    expect(fileRow('d0d0d0d0-0000-4000-8000-000000000002')).toMatchObject({ ext: '', mime_type: '' })
  })
})
