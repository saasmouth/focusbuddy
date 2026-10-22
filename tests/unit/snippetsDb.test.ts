// Saved snippets, persisted.
//
// The things worth guarding here are all about not lying to the user about
// their own library: a snippet that claims a scope it cannot have, a body that
// was saved as one kind and read back as another, an "update" that silently
// empties something, and a row whose JSON has rotted taking the whole library
// down with it. Each of those shows up as a plausible-looking library rather
// than an error, which is why they are tested rather than assumed.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
let activeOrg = 'personal'

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))

vi.mock('../../src/main/db/activeOrg', () => ({
  getActiveOrgId: () => activeOrg,
  setActiveOrgId: (id: string) => (activeOrg = id),
  PERSONAL_ORG_ID: 'personal'
}))

const {
  createSnippet,
  deleteSnippet,
  ensureSnippetSchema,
  forkSnippet,
  getSnippet,
  listSnippets,
  recordSnippetUse,
  updateSnippet
} = await import('../../src/main/db/snippets')

const docBody = (text = 'Net 30 from invoice date.') => ({
  kind: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  text
})

beforeAll(async () => {
  await initSqlite()
})

beforeEach(() => {
  db = openMemoryDatabase() as unknown as SqliteDb
  activeOrg = 'personal'
  ensureSnippetSchema(db as never)
})

describe('saving', () => {
  it('saves and reads back a doc snippet', () => {
    const res = createSnippet({ kind: 'doc', name: 'Payment terms', body: docBody(), tags: ['legal'] })
    expect(res.ok).toBe(true)
    const all = listSnippets()
    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('Payment terms')
    expect(all[0]!.tags).toEqual(['legal'])
    expect(all[0]!.revision).toBe(1)
    expect(all[0]!.usageCount).toBe(0)
  })

  it('refuses a nameless snippet', () => {
    const res = createSnippet({ kind: 'doc', name: '   ', body: docBody() })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/name/i)
    expect(listSnippets()).toHaveLength(0)
  })

  it('refuses an empty body rather than filling the library with blanks', () => {
    const res = createSnippet({ kind: 'doc', name: 'Nothing', body: { kind: 'doc', content: [], text: '' } })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/nothing in this selection/i)
  })

  it('refuses a body whose kind disagrees with the snippet kind', () => {
    const res = createSnippet({ kind: 'slide', name: 'Mismatch', body: docBody() as never })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/slide body/i)
  })

  it('trims whitespace-only tags out instead of storing them', () => {
    createSnippet({ kind: 'doc', name: 'T', body: docBody(), tags: ['  legal ', '', '   '] })
    expect(listSnippets()[0]!.tags).toEqual(['legal'])
  })
})

describe('scope', () => {
  it('stores an org-scoped save as personal in the personal workspace', () => {
    // There is nobody to share with in the personal org, so labelling it "org"
    // would be a claim the workspace cannot honour.
    const res = createSnippet({ kind: 'doc', name: 'Terms', body: docBody(), scope: 'org' })
    expect(res.ok).toBe(true)
    expect(res.snippet!.scope).toBe('personal')
  })

  it('keeps org scope in a real org', () => {
    activeOrg = 'org_acme'
    const res = createSnippet({ kind: 'doc', name: 'Terms', body: docBody(), scope: 'org' })
    expect(res.snippet!.scope).toBe('org')
    expect(res.snippet!.orgId).toBe('org_acme')
  })

  it('lists only the active org, so switching workspace switches library', () => {
    createSnippet({ kind: 'doc', name: 'Mine', body: docBody() })
    activeOrg = 'org_acme'
    createSnippet({ kind: 'doc', name: 'Acme', body: docBody(), scope: 'org' })
    expect(listSnippets().map((s) => s.name)).toEqual(['Acme'])
    activeOrg = 'personal'
    expect(listSnippets().map((s) => s.name)).toEqual(['Mine'])
  })

  it('records the author so "mine" can be told from a colleague\'s', () => {
    activeOrg = 'org_acme'
    const res = createSnippet({ kind: 'doc', name: 'T', body: docBody() }, 'me@example.com')
    expect(res.snippet!.authorId).toBe('me@example.com')
  })

  it('accepts an anonymous author, which is the normal local-first case', () => {
    const res = createSnippet({ kind: 'doc', name: 'T', body: docBody() })
    expect(res.ok).toBe(true)
    expect(res.snippet!.authorId).toBeNull()
  })
})

describe('updating', () => {
  it('bumps the revision on a body change, because live instances key on it', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody('v1') }).snippet!.id
    const res = updateSnippet(id, { body: docBody('v2') })
    expect(res.ok).toBe(true)
    expect(res.snippet!.revision).toBe(2)
    expect((res.snippet!.body as { text: string }).text).toBe('v2')
  })

  it('does NOT bump the revision for a rename', () => {
    // A rename changes nothing a live instance renders, so it must not look
    // like new content to every host that embeds it.
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    const res = updateSnippet(id, { name: 'Renamed' })
    expect(res.snippet!.revision).toBe(1)
    expect(res.snippet!.name).toBe('Renamed')
  })

  it('leaves fields alone when the patch omits them', () => {
    const id = createSnippet({
      kind: 'doc',
      name: 'T',
      description: 'keep me',
      body: docBody(),
      tags: ['a']
    }).snippet!.id
    updateSnippet(id, { name: 'T2' })
    const s = getSnippet(id)!
    expect(s.description).toBe('keep me')
    expect(s.tags).toEqual(['a'])
  })

  it('refuses to empty a snippet', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    const res = updateSnippet(id, { body: { kind: 'doc', content: [], text: '' } })
    expect(res.ok).toBe(false)
    expect(getSnippet(id)!.revision).toBe(1)
  })

  it('reports a missing snippet rather than creating one', () => {
    const res = updateSnippet('nope', { name: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no longer exists/i)
  })
})

describe('a rotted row does not take the library down', () => {
  it('reads an unparseable body back as an empty body of the right kind', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    db.prepare('UPDATE fb_snippets SET body_json = ? WHERE id = ?').run('{not json', id)
    const s = getSnippet(id)!
    // Still listed, still named, with an honestly empty body — a snippet the
    // user can see and delete beats one that silently vanished.
    expect(s.name).toBe('T')
    expect(s.body).toEqual({ kind: 'doc', content: [], text: '' })
    expect(listSnippets()).toHaveLength(1)
  })

  it('treats a body of the wrong kind as unreadable rather than handing it over', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    db.prepare('UPDATE fb_snippets SET body_json = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'slide', elements: [{}] }),
      id
    )
    expect(getSnippet(id)!.body).toEqual({ kind: 'doc', content: [], text: '' })
  })

  it('survives unparseable tags', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    db.prepare('UPDATE fb_snippets SET tags_json = ? WHERE id = ?').run('nope', id)
    expect(getSnippet(id)!.tags).toEqual([])
  })
})

describe('deleting and use', () => {
  it('deletes, and says so when there was nothing to delete', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    expect(deleteSnippet(id).ok).toBe(true)
    expect(listSnippets()).toHaveLength(0)
    expect(deleteSnippet(id).ok).toBe(false)
  })

  it('a deleted snippet resolves to null, which is what a live instance shows as missing', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    deleteSnippet(id)
    expect(getSnippet(id)).toBeNull()
  })

  it('counts a use', () => {
    const id = createSnippet({ kind: 'doc', name: 'T', body: docBody() }).snippet!.id
    recordSnippetUse(id)
    recordSnippetUse(id)
    expect(getSnippet(id)!.usageCount).toBe(2)
  })
})

describe('forking an org snippet into a personal one', () => {
  it('copies the body and lands it in the personal library', () => {
    activeOrg = 'org_acme'
    const src = createSnippet({ kind: 'doc', name: 'Pricing', body: docBody('tier 1'), scope: 'org' }).snippet!
    const res = forkSnippet(src.id, 'me@example.com')
    expect(res.ok).toBe(true)
    expect(res.snippet!.scope).toBe('personal')
    expect(res.snippet!.name).toBe('Pricing (copy)')
    expect((res.snippet!.body as { text: string }).text).toBe('tier 1')
    // Independent from here: the fork has its own id and its own revision line.
    expect(res.snippet!.id).not.toBe(src.id)
    expect(res.snippet!.revision).toBe(1)
  })

  it('reports a missing source rather than inventing a copy', () => {
    expect(forkSnippet('nope').ok).toBe(false)
  })
})

describe('searching in SQL-backed listing', () => {
  it('finds a snippet by its body text', () => {
    createSnippet({ kind: 'doc', name: 'Terms', body: docBody('arbitration in Adelaide') })
    createSnippet({ kind: 'doc', name: 'Other', body: docBody('nothing relevant') })
    expect(listSnippets({ search: 'arbitration' }).map((s) => s.name)).toEqual(['Terms'])
  })

  it('filters by kind', () => {
    createSnippet({ kind: 'doc', name: 'D', body: docBody() })
    createSnippet({
      kind: 'widget',
      name: 'W',
      body: { kind: 'widget', widgetKind: 'note', title: 'N', content: 'x', width: 2, height: 2, color: null }
    })
    expect(listSnippets({ kinds: ['widget'] }).map((s) => s.name)).toEqual(['W'])
  })
})
