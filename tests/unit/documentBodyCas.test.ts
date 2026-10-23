// A document body save says WHICH body it is replacing.
//
// Without that, one document open in two editors loses work silently. Two
// linked-duplicate widgets share a document id, and each holds the whole body
// in its own memory seeded at mount, so each save wrote its own copy over the
// other's: reproduced before this existed as writes ["start +A", "start +B"]
// with a final body of "start +B". No merge, no conflict, no warning — " +A"
// simply never happened.
//
// The schema here is built with applySchemaAndMigrations rather than hand-rolled
// DDL, on purpose: that is the function BOTH runtimes run, so a passing test
// also proves the cloud/browser database gets body_rev. A column added only to
// SCHEMA, or only to the desktop's migrations, would be missing on the other
// side and applyRemote writes the intersection of a body and the local table.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))

vi.mock('../../src/main/db/activeOrg', () => ({
  getActiveOrgId: () => 'personal',
  setActiveOrgId: () => {},
  PERSONAL_ORG_ID: 'personal'
}))

// Spied rather than left real, so the announcement contract can be asserted.
// The real one reaches Electron's BrowserWindow, which does not exist here —
// and the reason it does not simply explode is its own guard: a save must never
// fail because a notification could not be delivered.
const announced = vi.hoisted(() => ({ calls: [] as { id: string; bodyRev: number }[] }))
vi.mock('../../src/main/documentEvents', () => ({
  notifyDocumentChanged: (id: string, bodyRev: number) => {
    announced.calls.push({ id, bodyRev })
  }
}))

const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
const { createDocument, getDocument, updateDocument, updateDocumentBody, upsertDocument } =
  await import('../../src/main/db/documents')
const { applyRemote } = await import('../../src/main/db/workspaceSync')

const text = (t: string): { type: 'doc'; content: unknown[]; text: string } => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  text: t
})
const bodyText = (id: string): string =>
  ((getDocument(id)?.body ?? {}) as { text?: string }).text ?? ''

beforeAll(async () => {
  await initSqlite()
})

beforeEach(() => {
  db = openMemoryDatabase()
  applySchemaAndMigrations(db as never)
  announced.calls = []
})

describe('the column exists wherever the schema is built', () => {
  it('is present after applySchemaAndMigrations, which the cloud runtime also runs', () => {
    const cols = (db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toContain('body_rev')
  })
})

describe('a body write moves the version on', () => {
  it('starts at 0 and counts up', () => {
    const doc = createDocument({ docType: 'doc', title: 'A' })
    expect(doc.bodyRev).toBe(0)
    updateDocument(doc.id, { body: text('one') as never })
    expect(getDocument(doc.id)!.bodyRev).toBe(1)
    updateDocument(doc.id, { body: text('two') as never })
    expect(getDocument(doc.id)!.bodyRev).toBe(2)
  })

  it('does not move for a write that is not a body write', () => {
    // A rename must not invalidate an editor's pending save: it has not touched
    // the body, so the body the editor is holding is still current.
    const doc = createDocument({ docType: 'doc', title: 'A' })
    updateDocument(doc.id, { body: text('one') as never })
    const rev = getDocument(doc.id)!.bodyRev
    updateDocument(doc.id, { title: 'Renamed' })
    expect(getDocument(doc.id)!.bodyRev).toBe(rev)
  })
})

describe('a conditional write is refused when the body has moved', () => {
  it('writes when the version matches, and reports the new document', () => {
    const doc = createDocument({ docType: 'doc', title: 'A' })
    const res = updateDocumentBody(doc.id, text('mine') as never, doc.bodyRev)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.doc.bodyRev).toBe(1)
    expect(bodyText(doc.id)).toBe('mine')
  })

  it('writes NOTHING when the version is stale, and hands back what is stored', () => {
    const doc = createDocument({ docType: 'doc', title: 'A' })
    updateDocument(doc.id, { body: text('theirs') as never })
    const res = updateDocumentBody(doc.id, text('mine') as never, doc.bodyRev)
    expect(res.ok).toBe(false)
    if (!res.ok && res.reason === 'stale') {
      expect((res.current.body as { text: string }).text).toBe('theirs')
    } else {
      throw new Error('expected a stale refusal')
    }
    // The decisive assertion: the refusal did not half-apply.
    expect(bodyText(doc.id)).toBe('theirs')
  })

  it('says so for a document that is not there, rather than reporting a conflict', () => {
    const res = updateDocumentBody('no-such-id', text('mine') as never, 0)
    expect(res).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('THE BUG: two editors on one document', () => {
  it('the second save is refused instead of destroying the first', () => {
    // Exactly the reproduction that opened this: both editors read the document
    // at the same version, because both mounted before either typed.
    const doc = createDocument({ docType: 'doc', title: 'Shared' })
    updateDocument(doc.id, { body: text('start') as never })
    const seenByA = getDocument(doc.id)!.bodyRev
    const seenByB = getDocument(doc.id)!.bodyRev
    expect(seenByA).toBe(seenByB)

    const a = updateDocumentBody(doc.id, text('start +A') as never, seenByA)
    expect(a.ok).toBe(true)

    const b = updateDocumentBody(doc.id, text('start +B') as never, seenByB)
    expect(b.ok).toBe(false)
    // A's work is still there. Before the guard this read "start +B".
    expect(bodyText(doc.id)).toBe('start +A')
  })

  it('and B can then go again from what it was shown', () => {
    // The refusal has to be recoverable, or it just moves the loss around.
    const doc = createDocument({ docType: 'doc', title: 'Shared' })
    const rev0 = getDocument(doc.id)!.bodyRev
    updateDocumentBody(doc.id, text('start +A') as never, rev0)
    const refused = updateDocumentBody(doc.id, text('start +B') as never, rev0)
    if (refused.ok) throw new Error('expected a refusal')
    if (refused.reason !== 'stale') throw new Error('expected staleness')
    const retry = updateDocumentBody(doc.id, text('start +A +B') as never, refused.current.bodyRev)
    expect(retry.ok).toBe(true)
    expect(bodyText(doc.id)).toBe('start +A +B')
  })
})

describe('the unconditional path still exists, because some writers need it', () => {
  it('writes without a version, for an import or a snapshot restore', () => {
    // These callers are not holding an older copy of the body: they read and
    // write in one step, or they ARE the source of truth. A conflict path there
    // would be one nobody could resolve.
    const doc = createDocument({ docType: 'doc', title: 'A' })
    updateDocument(doc.id, { body: text('one') as never })
    const forced = updateDocument(doc.id, { body: text('forced') as never })
    expect(forced).not.toBeNull()
    expect(bodyText(doc.id)).toBe('forced')
  })

  it('upsert moves the version on too, so an editor holding the old body is refused', () => {
    // A document arriving from the cloud lands through upsertDocument. Leaving
    // body_rev alone there would let an open editor save over what just arrived.
    const doc = createDocument({ docType: 'doc', title: 'A' })
    const held = getDocument(doc.id)!.bodyRev
    upsertDocument({
      id: doc.id,
      docType: 'doc',
      title: 'A',
      body: text('from the cloud') as never
    })
    expect(getDocument(doc.id)!.bodyRev).toBeGreaterThan(held)
    const res = updateDocumentBody(doc.id, text('mine') as never, held)
    expect(res.ok).toBe(false)
    expect(bodyText(doc.id)).toBe('from the cloud')
  })
})

// ── The sync side ─────────────────────────────────────────────────────────────
//
// body_rev is DEVICE-LOCAL and must stay that way. Documents ride in workspace
// sync bodies (`documents` is a SyncTable and bodies are collected with
// SELECT *), and applyRemote upserts every column present in both the body and
// the local table — so without an exclusion a remote row would stamp another
// device's save counter onto this one. Two devices counting their own saves
// would hand each other matching numbers for DIFFERENT bodies, and a
// compare-and-set that passes against the wrong body is worse than no guard:
// it looks safe while it overwrites.
//
// The mirror risk is the opposite one. Because the column does not travel,
// nothing would move it when a remote body lands — so an editor holding the
// previous version would pass its conditional save and write straight over what
// just arrived. Same loss, across devices.

describe('a remote body neither sets nor ignores the local version', () => {
  const remoteDoc = (id: string, t: string, rev: number, extra: Record<string, unknown> = {}) => ({
    id,
    itemType: 'document' as const,
    rev,
    deleted: false,
    body: {
      id,
      doc_type: 'doc',
      title: 'Shared',
      body: JSON.stringify(text(t)),
      archived: 0,
      created_at: 1,
      updated_at: 2,
      org_id: 'personal',
      ...extra
    }
  })

  it('applies the body and moves the local version on', () => {
    const doc = createDocument({ docType: 'doc', title: 'Shared' })
    const held = getDocument(doc.id)!.bodyRev
    applyRemote([remoteDoc(doc.id, 'from another device', 5)])
    expect(bodyText(doc.id)).toBe('from another device')
    expect(getDocument(doc.id)!.bodyRev).toBeGreaterThan(held)
  })

  it('refuses an editor that was holding the body the remote one replaced', () => {
    // The reason the bump above is not cosmetic.
    const doc = createDocument({ docType: 'doc', title: 'Shared' })
    const held = getDocument(doc.id)!.bodyRev
    applyRemote([remoteDoc(doc.id, 'from another device', 5)])
    const res = updateDocumentBody(doc.id, text('mine') as never, held)
    expect(res.ok).toBe(false)
    expect(bodyText(doc.id)).toBe('from another device')
  })

  it('never takes the other device\'s counter on an existing row', () => {
    const doc = createDocument({ docType: 'doc', title: 'Shared' })
    applyRemote([remoteDoc(doc.id, 'theirs', 5, { body_rev: 99 })])
    const after = getDocument(doc.id)!.bodyRev
    expect(after).not.toBe(99)
    expect(after).toBeLessThan(10)
  })

  it('never takes it on a row this device has never seen either', () => {
    // The case the test above does NOT cover, and the one that proves the
    // SYNC_COLS exclusion is load-bearing: for an existing row the local bump
    // happens to override a travelling value, so removing the exclusion still
    // looked safe. A document arriving for the FIRST time is an INSERT, where
    // nothing overrides it — another device's count of 99 would be written
    // straight in, and a local editor that later held 99 for a completely
    // different body would pass its compare-and-set and overwrite silently.
    applyRemote([remoteDoc('brand-new-doc', 'theirs', 5, { body_rev: 99 })])
    const landed = getDocument('brand-new-doc')
    expect(landed).not.toBeNull()
    expect(landed!.bodyRev).not.toBe(99)
    expect(landed!.bodyRev).toBeLessThan(10)
  })
})

describe('who gets told, and who does not', () => {
  it('announces a body write, carrying the version it landed at', () => {
    // The version is in the message so a listener can recognise the echo of its
    // OWN save and not refetch a body it already has.
    const doc = createDocument({ docType: 'doc', title: 'A' })
    announced.calls = []
    updateDocument(doc.id, { body: text('one') as never })
    expect(announced.calls).toEqual([{ id: doc.id, bodyRev: 1 }])
  })

  it('says NOTHING when a conditional write was refused', () => {
    // Nothing changed, so there is nothing to tell. An announcement here would
    // send every other editor to refetch the body they already have — and, far
    // worse, a listener that treated any announcement as "the body moved" would
    // discard its own unsaved work over a write that never happened.
    const doc = createDocument({ docType: 'doc', title: 'A' })
    updateDocument(doc.id, { body: text('theirs') as never })
    announced.calls = []
    const res = updateDocumentBody(doc.id, text('mine') as never, 0)
    expect(res.ok).toBe(false)
    expect(announced.calls).toEqual([])
  })

  it('says nothing for a write that does not touch the body', () => {
    const doc = createDocument({ docType: 'doc', title: 'A' })
    announced.calls = []
    updateDocument(doc.id, { title: 'Renamed' })
    expect(announced.calls).toEqual([])
  })

  it('announces a document arriving through upsert', () => {
    // The cloud-pull path. An editor sitting open on this document has to hear
    // about it, or it keeps showing a body the server has already replaced.
    const doc = createDocument({ docType: 'doc', title: 'A' })
    announced.calls = []
    upsertDocument({ id: doc.id, docType: 'doc', title: 'A', body: text('from the cloud') as never })
    expect(announced.calls).toHaveLength(1)
    expect(announced.calls[0]!.id).toBe(doc.id)
  })
})
