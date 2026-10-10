// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { deskObjectIds, OBJECT_WIDGET_KINDS } from '../../src/main/deskAffinity'
import { interleaveByAffinity, mergeScopedPools } from '../../src/main/workspaceRank'
import type { WorkspaceSource } from '../../src/main/workspaceRank'

// "Why is the agent looking up irrelevant desks and documents when I ask a
// question from a desk? It seems limited in what it's considering."
//
// Both halves of that were one mechanism.
//
// Desk scope only ever reached the pools whose records carry a desk id —
// tasks, tables, notes, canvas widgets. The `documents` table is (id, doc_type,
// title, body, archived, created_at, updated_at): no desk column, and no
// migration ever added one, so documents, files and chats were ranked on
// keyword match across the whole workspace with the desk counting for nothing.
//
// And the 28 source slots were filled round-robin across seven pools — four
// rounds each, whatever the question was about. So a desk with fifteen relevant
// widgets surrendered eleven slots to material from elsewhere. Demotion could
// not fix that: it reorders within a pool, never between pools.

const src = (docId: string, score = 1, inScope?: boolean): WorkspaceSource => ({
  docId,
  title: docId,
  docType: 'doc',
  snippet: '',
  text: 'x',
  score,
  ...(inScope === undefined ? {} : { inScope })
})

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  // Mirrors schema.ts for the columns the join reads.
  d.exec(`
    CREATE TABLE widgets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT ''
    );
  `)
  return d
}

const addWidget = (d: DatabaseSync, id: string, deskId: string, kind: string, content: string): void => {
  d.prepare('INSERT INTO widgets (id, task_id, kind, content) VALUES (?, ?, ?, ?)').run(
    id,
    deskId,
    kind,
    content
  )
}

describe('deskObjectIds — the join that gives a document a desk', () => {
  it('finds the documents and files sitting on the scoped desk', () => {
    const d = db()
    addWidget(d, 'w1', 'desk-a', 'doc', 'document-1')
    addWidget(d, 'w2', 'desk-a', 'file', 'file-1')
    addWidget(d, 'w3', 'desk-b', 'doc', 'document-elsewhere')

    const ids = deskObjectIds(d as never, ['desk-a'])
    expect(ids.has('document-1')).toBe(true)
    expect(ids.has('file-1')).toBe(true)
    expect(ids.has('document-elsewhere')).toBe(false)
    // The desk itself is in the set, so one membership test covers a source
    // that IS a desk (the extras pool ranks nodes too).
    expect(ids.has('desk-a')).toBe(true)
  })

  it('handles a document that lives on SEVERAL desks', () => {
    // The reason this resolves at query time instead of being stamped into
    // fb_chunks.room_id: one column cannot hold two desks, and the pairing
    // changes the moment someone drops the document somewhere else.
    const d = db()
    addWidget(d, 'w1', 'desk-a', 'doc', 'shared-doc')
    addWidget(d, 'w2', 'desk-b', 'doc', 'shared-doc')
    expect(deskObjectIds(d as never, ['desk-a']).has('shared-doc')).toBe(true)
    expect(deskObjectIds(d as never, ['desk-b']).has('shared-doc')).toBe(true)
  })

  it('spans the whole desk neighbourhood, not just the open desk', () => {
    // relatedScopeIds() passes the current desk PLUS its related desks, and
    // @-mentioned desks are added to it — "compare this against what we have
    // here" has to keep "here" searchable.
    const d = db()
    addWidget(d, 'w1', 'desk-a', 'doc', 'doc-a')
    addWidget(d, 'w2', 'desk-b', 'doc', 'doc-b')
    const ids = deskObjectIds(d as never, ['desk-a', 'desk-b'])
    expect(ids.has('doc-a')).toBe(true)
    expect(ids.has('doc-b')).toBe(true)
  })

  it('reads every object-bearing widget kind', () => {
    const d = db()
    OBJECT_WIDGET_KINDS.forEach((kind, i) => addWidget(d, `w${i}`, 'desk-a', kind, `obj-${kind}`))
    const ids = deskObjectIds(d as never, ['desk-a'])
    for (const kind of OBJECT_WIDGET_KINDS) expect(ids.has(`obj-${kind}`)).toBe(true)
  })

  it('ignores a widget that references nothing', () => {
    const d = db()
    addWidget(d, 'w1', 'desk-a', 'doc', '')
    addWidget(d, 'w2', 'desk-a', 'sticky', 'not-an-id')
    const ids = deskObjectIds(d as never, ['desk-a'])
    // Only the desk id itself.
    expect([...ids]).toEqual(['desk-a'])
  })

  it('returns an empty set with no scope, which callers read as "unscoped"', () => {
    const d = db()
    addWidget(d, 'w1', 'desk-a', 'doc', 'document-1')
    expect(deskObjectIds(d as never, undefined).size).toBe(0)
    expect(deskObjectIds(d as never, []).size).toBe(0)
  })

  it('survives a database that cannot answer, rather than breaking retrieval', () => {
    const broken = {
      prepare() {
        throw new Error('no such table: widgets')
      }
    }
    // The scope ids still come back — a desk we cannot resolve is a desk with
    // no extra objects, and ranking carries on.
    expect([...deskObjectIds(broken as never, ['desk-a'])]).toEqual(['desk-a'])
  })
})

describe('interleaveByAffinity — the desk fills the slots first', () => {
  it('no longer starves the desk at four per pool', () => {
    // One pool holds eight desk widgets; six other pools hold material from
    // elsewhere. Old round-robin gave the desk four slots out of 14.
    const deskPool = Array.from({ length: 8 }, (_, i) => src(`desk-${i}`, 1, true))
    const elsewhere = Array.from({ length: 6 }, (_, p) =>
      Array.from({ length: 8 }, (_, i) => src(`away-${p}-${i}`, 1, false))
    )
    const out = interleaveByAffinity([deskPool, ...elsewhere], 14)
    const fromDesk = out.filter((s) => s.docId.startsWith('desk-'))
    expect(fromDesk).toHaveLength(8)
    // The desk's eight come first, then the rest of the workspace fills up.
    expect(out.slice(0, 8).every((s) => s.docId.startsWith('desk-'))).toBe(true)
    expect(out).toHaveLength(14)
  })

  it('never excludes the rest of the workspace, only demotes it', () => {
    // "Compare this against our standard contract" has to still work.
    const out = interleaveByAffinity([[src('here', 1, true)], [src('away', 1, false)]], 10)
    expect(out.map((s) => s.docId)).toEqual(['here', 'away'])
  })

  it('keeps scope-neutral sources in the first pass', () => {
    // Curated knowledge has no desk and grounds every answer; it must not be
    // pushed behind desk furniture. Pool order gives it the lead, as before.
    const knowledge = [src('knowledge-1')] // inScope undefined
    const desk = [src('desk-1', 1, true)]
    const away = [src('away-1', 1, false)]
    const out = interleaveByAffinity([knowledge, desk, away], 3)
    expect(out.map((s) => s.docId)).toEqual(['knowledge-1', 'desk-1', 'away-1'])
  })

  it('is plain round-robin when no desk scope is active', () => {
    // Nothing is marked off-scope, so one pass covers everything and the
    // result is what it always was: pool order within each round.
    const pools = [
      [src('a1'), src('a2')],
      [src('b1'), src('b2')],
      [src('c1')]
    ]
    expect(interleaveByAffinity(pools, 10).map((s) => s.docId)).toEqual([
      'a1',
      'b1',
      'c1',
      'a2',
      'b2'
    ])
  })

  it('never repeats a source that two pools both found', () => {
    const out = interleaveByAffinity([[src('same', 1, true)], [src('same', 1, false)]], 10)
    expect(out).toHaveLength(1)
  })

  it('honours the limit', () => {
    const pools = [Array.from({ length: 50 }, (_, i) => src(`x${i}`, 1, true))]
    expect(interleaveByAffinity(pools, 28)).toHaveLength(28)
  })
})

describe('mergeScopedPools tags affinity as well as demoting', () => {
  it('marks what came from the desk, so the interleave can act on it', () => {
    const merged = mergeScopedPools([src('here')], [src('away')], 10)
    expect(merged.find((s) => s.docId === 'here')?.inScope).toBe(true)
    expect(merged.find((s) => s.docId === 'away')?.inScope).toBe(false)
  })

  it('still demotes the off-scope score', () => {
    const merged = mergeScopedPools([src('here', 0.5)], [src('away', 1)], 10)
    // The off-scope source scored higher but is demoted below the desk's.
    expect(merged.map((s) => s.docId)).toEqual(['here', 'away'])
  })
})
