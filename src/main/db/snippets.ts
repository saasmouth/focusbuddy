// The saved-snippets store (local-first, org-scoped).
//
// One table. Rows are scoped by org_id like every other tenancy-bound table, so
// switching workspace shows that workspace's library and nothing else, and
// `scope` separates a user's own snippets from the ones shared with the whole
// org. See src/shared/snippets.ts for why that is the whole permission model.
//
// A corrupt body resolves to an empty body of the right kind rather than
// throwing: one bad row must not take out the library. Such a row is still
// listed, with an empty summary, because a snippet the user saved and can see
// is better than a snippet that silently disappeared.

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from './database'
import { getActiveOrgId, PERSONAL_ORG_ID } from './activeOrg'
import {
  isSnippetKind,
  isSnippetScope,
  snippetBodyIsEmpty,
  snippetBodyMatchesKind,
  type Snippet,
  type SnippetBody,
  type SnippetDraft,
  type SnippetKind,
  type SnippetPatch,
  type SnippetQuery,
  type SnippetScope
} from '@shared/snippets'

export const SNIPPET_SCHEMA = `
CREATE TABLE IF NOT EXISTS fb_snippets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT 'personal',
  org_id TEXT NOT NULL DEFAULT 'personal',
  author_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snippets_org_kind ON fb_snippets (org_id, kind);
CREATE INDEX IF NOT EXISTS idx_snippets_org_scope ON fb_snippets (org_id, scope);
`

/** Create the table and indexes if they are not there. Safe to call repeatedly. */
export function ensureSnippetSchema(db: Database.Database = getDb()): void {
  db.exec(SNIPPET_SCHEMA)
}

interface SnippetRow {
  id: string
  kind: string
  name: string
  description: string
  body_json: string
  tags_json: string
  scope: string
  org_id: string
  author_id: string | null
  revision: number
  usage_count: number
  created_at: number
  updated_at: number
}

/** An empty body of the given kind, for a row whose JSON will not parse. */
function emptyBody(kind: SnippetKind): SnippetBody {
  switch (kind) {
    case 'doc':
      return { kind: 'doc', content: [], text: '' }
    case 'widget':
      return { kind: 'widget', widgetKind: '', title: '', content: '', width: 2, height: 2, color: null }
    case 'sheet':
      return { kind: 'sheet', rows: [] }
    case 'slide':
      return { kind: 'slide', elements: [] }
    case 'design':
      return { kind: 'design', elements: [] }
    case 'diagram':
      return { kind: 'diagram', nodes: [], edges: [] }
    case 'draw':
      return { kind: 'draw', objects: [] }
  }
}

function parseBody(kind: SnippetKind, json: string): SnippetBody {
  try {
    const b = JSON.parse(json) as SnippetBody
    // A body whose discriminator disagrees with the row's kind cannot be read
    // safely by the surface that will render it, so treat it as unreadable
    // rather than handing a slide an object a document wrote.
    if (!b || typeof b !== 'object' || !snippetBodyMatchesKind(kind, b)) return emptyBody(kind)
    return b
  } catch {
    return emptyBody(kind)
  }
}

function parseTags(json: string): string[] {
  try {
    const t = JSON.parse(json) as unknown
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToSnippet(row: SnippetRow): Snippet {
  const kind: SnippetKind = isSnippetKind(row.kind) ? row.kind : 'doc'
  const scope: SnippetScope = isSnippetScope(row.scope) ? row.scope : 'personal'
  return {
    id: row.id,
    kind,
    name: row.name,
    description: row.description,
    body: parseBody(kind, row.body_json),
    tags: parseTags(row.tags_json),
    scope,
    orgId: row.org_id,
    authorId: row.author_id,
    revision: row.revision,
    usageCount: row.usage_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Every snippet visible in the active org, newest first.
 *
 * Filtering happens in SQL for the cheap predicates and in the shared matcher
 * for search, so the renderer's filter and this one cannot drift apart.
 */
export function listSnippets(query: SnippetQuery = {}): Snippet[] {
  ensureSnippetSchema()
  const db = getDb()
  const where: string[] = ['org_id = ?']
  const args: unknown[] = [getActiveOrgId()]
  if (query.kinds?.length) {
    where.push(`kind IN (${query.kinds.map(() => '?').join(',')})`)
    args.push(...query.kinds)
  }
  if (query.scope) {
    where.push('scope = ?')
    args.push(query.scope)
  }
  const rows = db
    .prepare(`SELECT * FROM fb_snippets WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`)
    .all(...args) as SnippetRow[]
  const all = rows.map(rowToSnippet)
  if (!query.search?.trim()) return all
  // Search runs through the shared matcher so the library's own filtering and
  // this query agree on what "matches" means, body text included.
  const needle = query.search.trim().toLowerCase()
  return all.filter((s) => {
    const body = s.body.kind === 'doc' ? s.body.text : ''
    return [s.name, s.description, s.tags.join(' '), body].join(' ').toLowerCase().includes(needle)
  })
}

/** One snippet by id, or null. Not org-filtered: a live instance resolves by id. */
export function getSnippet(id: string): Snippet | null {
  ensureSnippetSchema()
  const row = getDb().prepare('SELECT * FROM fb_snippets WHERE id = ?').get(id) as SnippetRow | undefined
  return row ? rowToSnippet(row) : null
}

export interface CreateSnippetResult {
  ok: boolean
  snippet?: Snippet
  error?: string
  /**
   * Set when the write was refused because the master had moved on. Carries what
   * is stored NOW, so the caller can offer Reload (take this) or Overwrite
   * (re-save against this revision) without a second round trip — and can show
   * the user what they would be replacing rather than asking them to choose
   * blind.
   */
  conflictWith?: Snippet
}

/**
 * Save something as a snippet.
 *
 * Refuses an empty body and a name that is only whitespace, because both
 * produce a library entry the user cannot tell from any other. An org-scoped
 * save in the personal workspace is stored as personal instead: there is no one
 * to share with there, and silently labelling it "org" would be a lie.
 */
export function createSnippet(draft: SnippetDraft, authorId: string | null = null): CreateSnippetResult {
  ensureSnippetSchema()
  const name = (draft.name || '').trim()
  if (!name) return { ok: false, error: 'A snippet needs a name.' }
  if (!isSnippetKind(draft.kind)) return { ok: false, error: `Unknown snippet kind: ${String(draft.kind)}` }
  if (!draft.body || !snippetBodyMatchesKind(draft.kind, draft.body)) {
    return { ok: false, error: `A ${draft.kind} snippet needs a ${draft.kind} body.` }
  }
  if (snippetBodyIsEmpty(draft.body)) return { ok: false, error: 'There is nothing in this selection to save.' }

  const orgId = getActiveOrgId()
  const requested: SnippetScope = isSnippetScope(draft.scope) ? draft.scope : 'personal'
  const scope: SnippetScope = orgId === PERSONAL_ORG_ID ? 'personal' : requested

  const now = Date.now()
  const snippet: Snippet = {
    id: randomUUID(),
    kind: draft.kind,
    name,
    description: (draft.description || '').trim(),
    body: draft.body,
    tags: (draft.tags ?? []).map((t) => t.trim()).filter(Boolean),
    scope,
    orgId,
    authorId,
    revision: 1,
    usageCount: 0,
    createdAt: now,
    updatedAt: now
  }
  getDb()
    .prepare(
      `INSERT INTO fb_snippets
         (id, kind, name, description, body_json, tags_json, scope, org_id, author_id, revision, usage_count, created_at, updated_at)
       VALUES (@id, @kind, @name, @description, @body, @tags, @scope, @orgId, @authorId, 1, 0, @now, @now)`
    )
    .run({
      id: snippet.id,
      kind: snippet.kind,
      name: snippet.name,
      description: snippet.description,
      body: JSON.stringify(snippet.body),
      tags: JSON.stringify(snippet.tags),
      scope: snippet.scope,
      orgId: snippet.orgId,
      authorId: snippet.authorId,
      now
    })
  return { ok: true, snippet }
}

/**
 * Change a snippet. A body change bumps `revision`, which is what every live
 * instance of it is keyed on — so editing the master here is what makes the
 * change appear wherever it was inserted live.
 */
export function updateSnippet(id: string, patch: SnippetPatch): CreateSnippetResult {
  ensureSnippetSchema()
  const current = getSnippet(id)
  if (!current) return { ok: false, error: 'That snippet no longer exists.' }

  const name = patch.name === undefined ? current.name : patch.name.trim()
  if (!name) return { ok: false, error: 'A snippet needs a name.' }

  let body = current.body
  let revision = current.revision
  if (patch.body !== undefined) {
    if (!snippetBodyMatchesKind(current.kind, patch.body)) {
      return { ok: false, error: `A ${current.kind} snippet needs a ${current.kind} body.` }
    }
    if (snippetBodyIsEmpty(patch.body)) return { ok: false, error: 'A snippet cannot be emptied.' }
    body = patch.body
    revision = current.revision + 1
  }

  // Promoting to org scope is only meaningful outside the personal workspace.
  const scope: SnippetScope =
    patch.scope === undefined || current.orgId === PERSONAL_ORG_ID ? current.scope : patch.scope

  // Compare-and-set. The early return gives a useful message and the snapshot to
  // reload from; the WHERE clause below is what makes it SAFE, because a
  // read-then-write would leave a window in which two writers both pass this
  // check and the second silently wins.
  const expected = patch.expectedRevision
  if (expected !== undefined && current.revision !== expected) {
    return {
      ok: false,
      error: 'This snippet was changed somewhere else while you were editing it.',
      conflictWith: current
    }
  }

  const now = Date.now()
  const info = getDb()
    .prepare(
      `UPDATE fb_snippets
          SET name = @name, description = @description, body_json = @body, tags_json = @tags,
              scope = @scope, revision = @revision, updated_at = @now
        WHERE id = @id
          AND (@expected IS NULL OR revision = @expected)`
    )
    .run({
      expected: expected ?? null,
      id,
      name,
      description: patch.description === undefined ? current.description : patch.description.trim(),
      body: JSON.stringify(body),
      tags: JSON.stringify(
        patch.tags === undefined ? current.tags : patch.tags.map((t) => t.trim()).filter(Boolean)
      ),
      scope,
      revision,
      now
    })
  if (info.changes === 0) {
    // The row moved between the check above and this write. Rare, and exactly
    // what the WHERE clause is for.
    const latest = getSnippet(id)
    return {
      ok: false,
      error: 'This snippet was changed somewhere else while you were editing it.',
      conflictWith: latest ?? undefined
    }
  }
  const next = getSnippet(id)
  return next ? { ok: true, snippet: next } : { ok: false, error: 'The snippet could not be read back.' }
}

/**
 * Delete a snippet.
 *
 * Live instances of it become unresolvable, which the host renders as a clearly
 * missing snippet rather than as nothing — see SnippetEmbed. That is the point:
 * a live instance is a reference, and a dangling reference should look dangling.
 * `liveInstances` is reported so a caller can warn before deleting.
 */
export function deleteSnippet(id: string): { ok: boolean; error?: string } {
  ensureSnippetSchema()
  const info = getDb().prepare('DELETE FROM fb_snippets WHERE id = ?').run(id)
  if (!info.changes) return { ok: false, error: 'That snippet no longer exists.' }
  return { ok: true }
}

/** Count an insertion. Called once per insert, from the surface that did it. */
export function recordSnippetUse(id: string): void {
  ensureSnippetSchema()
  getDb().prepare('UPDATE fb_snippets SET usage_count = usage_count + 1 WHERE id = ?').run(id)
}

/** Copy an org snippet into the caller's personal library, so they can diverge. */
export function forkSnippet(id: string, authorId: string | null = null): CreateSnippetResult {
  const src = getSnippet(id)
  if (!src) return { ok: false, error: 'That snippet no longer exists.' }
  return createSnippet(
    {
      kind: src.kind,
      name: `${src.name} (copy)`,
      description: src.description,
      body: src.body,
      tags: src.tags,
      scope: 'personal'
    },
    authorId
  )
}
