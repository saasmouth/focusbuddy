// Mail folders, persisted.
//
// The two things worth guarding here are both about NOT losing the user's work:
// a patch that mentions one field must not blank the others, and deleting a
// desk must unlink a folder rather than destroy it. The second is why node_id
// is ON DELETE SET NULL and not CASCADE, and it is the kind of thing that is
// invisible until somebody tidies up a workspace and loses their filing.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))

const M = await import('../../src/main/db/mailFolders')

beforeAll(async () => {
  await initSqlite()
})

beforeEach(() => {
  db = openMemoryDatabase()
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY)')
  db.exec("INSERT INTO nodes (id) VALUES ('desk-1'), ('desk-2')")
  M.ensureMailFolderSchema(db as never)
})

describe('createMailFolder', () => {
  it('stores a folder with its rule', () => {
    const f = M.createMailFolder({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(f.name).toBe('Acme')
    expect(f.rules).toEqual({ from: ['acme.com'] })
    expect(f.pinned).toEqual([])
    expect(f.nodeId).toBeNull()
  })

  it('never stores an unnamed folder', () => {
    expect(M.createMailFolder({ name: '   ' }).name).toBe('New folder')
  })

  it('adds to the end rather than rearranging what the user already ordered', () => {
    M.createMailFolder({ name: 'First' })
    M.createMailFolder({ name: 'Second' })
    const third = M.createMailFolder({ name: 'Third' })
    expect(third.sortOrder).toBe(2)
    expect(M.listMailFolders().map((f) => f.name)).toEqual(['First', 'Second', 'Third'])
  })

  it('can be about a desk', () => {
    const f = M.createMailFolder({ name: 'Ridge St', nodeId: 'desk-1' })
    expect(f.nodeId).toBe('desk-1')
    expect(M.listMailFoldersForNode('desk-1').map((x) => x.id)).toEqual([f.id])
    expect(M.listMailFoldersForNode('desk-2')).toEqual([])
  })
})

describe('updateMailFolder', () => {
  it('changes only what the patch mentions', () => {
    const f = M.createMailFolder({
      name: 'Acme',
      colour: 'rose',
      rules: { from: ['acme.com'] },
      nodeId: 'desk-1'
    })
    const out = M.updateMailFolder(f.id, { name: 'Acme Corp' })!
    expect(out.name).toBe('Acme Corp')
    expect(out.colour).toBe('rose')
    expect(out.rules).toEqual({ from: ['acme.com'] })
    expect(out.nodeId).toBe('desk-1')
  })

  it('treats a null nodeId as a real instruction to stop being about that desk', () => {
    const f = M.createMailFolder({ name: 'Acme', nodeId: 'desk-1' })
    expect(M.updateMailFolder(f.id, { nodeId: null })!.nodeId).toBeNull()
  })

  it('leaves the folder untouched for an empty patch', () => {
    const f = M.createMailFolder({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(M.updateMailFolder(f.id, {})).toEqual(f)
  })

  it('refuses to blank the name', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    expect(M.updateMailFolder(f.id, { name: '  ' })!.name).toBe('Acme')
  })

  it('answers null for a folder that is not there', () => {
    expect(M.updateMailFolder('nope', { name: 'x' })).toBeNull()
  })
})

describe('pinning and excluding', () => {
  it('pins a message the rule missed', () => {
    const f = M.createMailFolder({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(M.pinToFolder(f.id, 42)!.pinned).toEqual([42])
  })

  it('excludes a message the rule wrongly caught', () => {
    const f = M.createMailFolder({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(M.excludeFromFolder(f.id, 42)!.excluded).toEqual([42])
  })

  it('pinning clears a previous exclusion, so the pin is not silently ignored', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    M.excludeFromFolder(f.id, 42)
    const out = M.pinToFolder(f.id, 42)!
    expect(out.pinned).toEqual([42])
    expect(out.excluded).toEqual([])
  })

  it('excluding clears a previous pin', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    M.pinToFolder(f.id, 42)
    const out = M.excludeFromFolder(f.id, 42)!
    expect(out.excluded).toEqual([42])
    expect(out.pinned).toEqual([])
  })

  it('does not record the same uid twice', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    M.pinToFolder(f.id, 42)
    expect(M.pinToFolder(f.id, 42)!.pinned).toEqual([42])
  })

  it('round-trips a long uid list', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    const uids = Array.from({ length: 50 }, (_, i) => 1000 + i)
    expect(M.updateMailFolder(f.id, { pinned: uids })!.pinned).toEqual(uids)
  })
})

describe('deleting a desk', () => {
  it('unlinks the folder instead of destroying it', () => {
    // The whole reason node_id is ON DELETE SET NULL. Tidying up a workspace
    // must not take somebody's mail filing with it.
    const f = M.createMailFolder({ name: 'Ridge St', rules: { from: ['ridge.com'] }, nodeId: 'desk-1' })
    db.exec("DELETE FROM nodes WHERE id = 'desk-1'")
    const after = M.getMailFolder(f.id)
    expect(after).not.toBeNull()
    expect(after!.nodeId).toBeNull()
    expect(after!.rules).toEqual({ from: ['ridge.com'] })
  })
})

describe('deleteMailFolder', () => {
  it('removes the folder and says so', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    expect(M.deleteMailFolder(f.id)).toBe(true)
    expect(M.getMailFolder(f.id)).toBeNull()
  })

  it('reports false for one that was not there', () => {
    expect(M.deleteMailFolder('nope')).toBe(false)
  })
})

describe('reorderMailFolders', () => {
  it('persists the order it was given', () => {
    const a = M.createMailFolder({ name: 'Alpha' })
    const b = M.createMailFolder({ name: 'Beta' })
    const c = M.createMailFolder({ name: 'Gamma' })
    const out = M.reorderMailFolders([c.id, a.id, b.id])
    expect(out.map((f) => f.name)).toEqual(['Gamma', 'Alpha', 'Beta'])
  })
})

describe('a corrupt rule blob', () => {
  it('becomes a rule that files NOTHING, never one that files everything', () => {
    // The wrong direction here would quietly sweep the entire inbox into one
    // folder, which looks like data loss to the person it happens to.
    const f = M.createMailFolder({ name: 'Acme', rules: { from: ['acme.com'] } })
    db.prepare('UPDATE mail_folders SET rules = ? WHERE id = ?').run('{not json', f.id)
    expect(M.getMailFolder(f.id)!.rules).toEqual({})
  })

  it('survives a rules value that is valid JSON but not an object', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    for (const bad of ['[1,2]', '"text"', 'null', '7']) {
      db.prepare('UPDATE mail_folders SET rules = ? WHERE id = ?').run(bad, f.id)
      expect(M.getMailFolder(f.id)!.rules).toEqual({})
    }
  })

  it('drops unparseable uids rather than yielding NaN', () => {
    const f = M.createMailFolder({ name: 'Acme' })
    db.prepare('UPDATE mail_folders SET pinned = ? WHERE id = ?').run('1,,abc,3', f.id)
    expect(M.getMailFolder(f.id)!.pinned).toEqual([1, 3])
  })
})
