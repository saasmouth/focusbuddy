// Mail tags, persisted.
//
// The two things worth guarding here are both about NOT losing the user's work:
// a patch that mentions one field must not blank the others, and deleting a
// desk must unlink a tag rather than destroy it. The second is why node_id
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

const M = await import('../../src/main/db/mailTags')

beforeAll(async () => {
  await initSqlite()
})

beforeEach(() => {
  db = openMemoryDatabase()
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY)')
  db.exec("INSERT INTO nodes (id) VALUES ('desk-1'), ('desk-2')")
  M.ensureMailTagSchema(db as never)
})

describe('createMailTag', () => {
  it('stores a tag with its rule', () => {
    const f = M.createMailTag({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(f.name).toBe('Acme')
    expect(f.rules).toEqual({ from: ['acme.com'] })
    expect(f.pinned).toEqual([])
    expect(f.nodeId).toBeNull()
  })

  it('never stores an unnamed tag', () => {
    expect(M.createMailTag({ name: '   ' }).name).toBe('New tag')
  })

  it('adds to the end rather than rearranging what the user already ordered', () => {
    M.createMailTag({ name: 'First' })
    M.createMailTag({ name: 'Second' })
    const third = M.createMailTag({ name: 'Third' })
    expect(third.sortOrder).toBe(2)
    expect(M.listMailTags().map((f) => f.name)).toEqual(['First', 'Second', 'Third'])
  })

  it('can be about a desk', () => {
    const f = M.createMailTag({ name: 'Ridge St', nodeId: 'desk-1' })
    expect(f.nodeId).toBe('desk-1')
    expect(M.listMailTagsForNode('desk-1').map((x) => x.id)).toEqual([f.id])
    expect(M.listMailTagsForNode('desk-2')).toEqual([])
  })
})

describe('updateMailTag', () => {
  it('changes only what the patch mentions', () => {
    const f = M.createMailTag({
      name: 'Acme',
      colour: 'rose',
      rules: { from: ['acme.com'] },
      nodeId: 'desk-1'
    })
    const out = M.updateMailTag(f.id, { name: 'Acme Corp' })!
    expect(out.name).toBe('Acme Corp')
    expect(out.colour).toBe('rose')
    expect(out.rules).toEqual({ from: ['acme.com'] })
    expect(out.nodeId).toBe('desk-1')
  })

  it('treats a null nodeId as a real instruction to stop being about that desk', () => {
    const f = M.createMailTag({ name: 'Acme', nodeId: 'desk-1' })
    expect(M.updateMailTag(f.id, { nodeId: null })!.nodeId).toBeNull()
  })

  it('leaves the tag untouched for an empty patch', () => {
    const f = M.createMailTag({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(M.updateMailTag(f.id, {})).toEqual(f)
  })

  it('refuses to blank the name', () => {
    const f = M.createMailTag({ name: 'Acme' })
    expect(M.updateMailTag(f.id, { name: '  ' })!.name).toBe('Acme')
  })

  it('answers null for a tag that is not there', () => {
    expect(M.updateMailTag('nope', { name: 'x' })).toBeNull()
  })
})

describe('pinning and excluding', () => {
  it('pins a message the rule missed', () => {
    const f = M.createMailTag({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(M.pinToTag(f.id, 42)!.pinned).toEqual([42])
  })

  it('excludes a message the rule wrongly caught', () => {
    const f = M.createMailTag({ name: 'Acme', rules: { from: ['acme.com'] } })
    expect(M.excludeFromTag(f.id, 42)!.excluded).toEqual([42])
  })

  it('pinning clears a previous exclusion, so the pin is not silently ignored', () => {
    const f = M.createMailTag({ name: 'Acme' })
    M.excludeFromTag(f.id, 42)
    const out = M.pinToTag(f.id, 42)!
    expect(out.pinned).toEqual([42])
    expect(out.excluded).toEqual([])
  })

  it('excluding clears a previous pin', () => {
    const f = M.createMailTag({ name: 'Acme' })
    M.pinToTag(f.id, 42)
    const out = M.excludeFromTag(f.id, 42)!
    expect(out.excluded).toEqual([42])
    expect(out.pinned).toEqual([])
  })

  it('does not record the same uid twice', () => {
    const f = M.createMailTag({ name: 'Acme' })
    M.pinToTag(f.id, 42)
    expect(M.pinToTag(f.id, 42)!.pinned).toEqual([42])
  })

  it('round-trips a long uid list', () => {
    const f = M.createMailTag({ name: 'Acme' })
    const uids = Array.from({ length: 50 }, (_, i) => 1000 + i)
    expect(M.updateMailTag(f.id, { pinned: uids })!.pinned).toEqual(uids)
  })
})

describe('deleting a desk', () => {
  it('unlinks the tag instead of destroying it', () => {
    // The whole reason node_id is ON DELETE SET NULL. Tidying up a workspace
    // must not take somebody's mail filing with it.
    const f = M.createMailTag({ name: 'Ridge St', rules: { from: ['ridge.com'] }, nodeId: 'desk-1' })
    db.exec("DELETE FROM nodes WHERE id = 'desk-1'")
    const after = M.getMailTag(f.id)
    expect(after).not.toBeNull()
    expect(after!.nodeId).toBeNull()
    expect(after!.rules).toEqual({ from: ['ridge.com'] })
  })
})

describe('deleteMailTag', () => {
  it('removes the tag and says so', () => {
    const f = M.createMailTag({ name: 'Acme' })
    expect(M.deleteMailTag(f.id)).toBe(true)
    expect(M.getMailTag(f.id)).toBeNull()
  })

  it('reports false for one that was not there', () => {
    expect(M.deleteMailTag('nope')).toBe(false)
  })
})

describe('reorderMailTags', () => {
  it('persists the order it was given', () => {
    const a = M.createMailTag({ name: 'Alpha' })
    const b = M.createMailTag({ name: 'Beta' })
    const c = M.createMailTag({ name: 'Gamma' })
    const out = M.reorderMailTags([c.id, a.id, b.id])
    expect(out.map((f) => f.name)).toEqual(['Gamma', 'Alpha', 'Beta'])
  })
})

describe('a corrupt rule blob', () => {
  it('becomes a rule that files NOTHING, never one that files everything', () => {
    // The wrong direction here would quietly sweep the entire inbox into one
    // tag, which looks like data loss to the person it happens to.
    const f = M.createMailTag({ name: 'Acme', rules: { from: ['acme.com'] } })
    db.prepare('UPDATE mail_folders SET rules = ? WHERE id = ?').run('{not json', f.id)
    expect(M.getMailTag(f.id)!.rules).toEqual({})
  })

  it('survives a rules value that is valid JSON but not an object', () => {
    const f = M.createMailTag({ name: 'Acme' })
    for (const bad of ['[1,2]', '"text"', 'null', '7']) {
      db.prepare('UPDATE mail_folders SET rules = ? WHERE id = ?').run(bad, f.id)
      expect(M.getMailTag(f.id)!.rules).toEqual({})
    }
  })

  it('drops unparseable uids rather than yielding NaN', () => {
    const f = M.createMailTag({ name: 'Acme' })
    db.prepare('UPDATE mail_folders SET pinned = ? WHERE id = ?').run('1,,abc,3', f.id)
    expect(M.getMailTag(f.id)!.pinned).toEqual([1, 3])
  })
})
