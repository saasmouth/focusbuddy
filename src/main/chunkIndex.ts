// The chunk index — passage-level retrieval over the workspace (A2, R10).
//
// fb_chunks holds every source split into ~paragraph-sized passages with an
// FTS5 mirror (fb_chunks_fts) kept in sync by triggers. Retrieval queries the
// passages with BM25, so a question matches the paragraph that answers it
// rather than a substring of a document's opening — the proper fix for
// defect #2 (long docs shipped their cover page). The substrate already
// existed in the field (1086 chunks written by an earlier build, surveyed
// 2026-08-22, adopted by measurement + Caleb's R10); this module makes the
// app its owner: same DDL, content_hash-cheap reindex on write, a
// reconciling sweep, and the search the document pool now rides on.
//
// Written against a minimal structural DB interface rather than the
// better-sqlite3 types so the unit suite can run REAL FTS5 queries through
// node:sqlite — the ranking behaviour is the point, and a mocked database
// cannot vouch for an FTS MATCH expression.

import { createHash } from 'node:crypto'
import { getDb } from './db/database'
import { getActiveOrgId } from './db/activeOrg'
import { listDocuments, getDocument } from './db/documents'
import { getDocMetadata } from './db/docMetadata'
import { getWidget, listWidgetsByKind } from './db/widgets'
import { listNodes } from './db/nodes'
import { listTables, listRows } from './db/tables'
import { listIndexableFiles, getIndexableFile, type IndexableFile } from './db/files'
import { listConversations, getConversation } from './db/aiChat'
import { extractFileText } from './fileText'
import { widgetToText, type ResolvedTable, type WidgetTextResolvers } from '@shared/widgetText'
import type { Widget, WidgetKind } from '@shared/types'
import {
  extractDocText,
  selectPassages,
  mergeScopedPools,
  termVariants,
  type WorkspaceSource
} from './workspaceRank'

// The subset of the database API this module touches. Both better-sqlite3
// (the app) and node:sqlite's DatabaseSync (the tests) satisfy it.
export interface ChunkDb {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}

// Bump when the chunking parameters change: every content_hash embeds it, so
// old chunks re-cut themselves on the next sweep instead of lingering at the
// old granularity forever.
const CHUNK_PARAMS_VERSION = 'v2'
// Passage size. The field data (the adopted index) runs ~1100-1500 chars per
// chunk; matching it keeps the old and new populations comparable.
const CHUNK_TARGET_CHARS = 1200
const CHUNK_MIN_CHARS = 200

// ── Schema ─────────────────────────────────────────────────────────────────

export function ensureChunkTables(db: ChunkDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fb_chunks (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  room_id TEXT,
  chunk_date INTEGER,
  source_kind TEXT,
  sensitivity TEXT,
  org_id TEXT NOT NULL DEFAULT 'personal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_chunks_source ON fb_chunks(source_type, source_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_chunks_org ON fb_chunks(org_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_chunks_room ON fb_chunks(room_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_chunks_date ON fb_chunks(chunk_date DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_chunks_kind ON fb_chunks(source_kind)`)
  // The extraction ledger (#17): which sources have been read, at which
  // content version, and how many chunks came of it. Exists so an EXPENSIVE
  // extraction (a PDF parse, an OCR pass) runs once per file version even
  // when it yields nothing — zero chunks is a result, not an invitation to
  // re-extract every boot.
  db.exec(`CREATE TABLE IF NOT EXISTS fb_chunk_ledger (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'personal',
  content_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_id)
)`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fb_chunks_fts USING fts5(
      chunk_id UNINDEXED, org_id UNINDEXED, title, text
    )`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS fb_chunks_fts_ai AFTER INSERT ON fb_chunks BEGIN
      INSERT INTO fb_chunks_fts(chunk_id, org_id, title, text)
        VALUES (new.id, new.org_id, new.title, new.text);
    END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS fb_chunks_fts_ad AFTER DELETE ON fb_chunks BEGIN
      DELETE FROM fb_chunks_fts WHERE chunk_id = old.id;
    END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS fb_chunks_fts_au AFTER UPDATE ON fb_chunks BEGIN
      DELETE FROM fb_chunks_fts WHERE chunk_id = old.id;
      INSERT INTO fb_chunks_fts(chunk_id, org_id, title, text)
        VALUES (new.id, new.org_id, new.title, new.text);
    END`)
}

// ── Chunking ───────────────────────────────────────────────────────────────

// Split extracted plain text into passages: paragraphs packed up to the
// target size, a paragraph longer than the target split at sentence bounds.
// Pure, so the granularity is unit-pinned.
export function chunkText(text: string): string[] {
  const clean = text.trim()
  if (!clean) return []
  const paras = clean.split(/\n{2,}/)
  const units: string[] = []
  for (const p of paras) {
    const t = p.trim()
    if (!t) continue
    if (t.length <= CHUNK_TARGET_CHARS) {
      units.push(t)
      continue
    }
    // An oversized paragraph splits at sentence ends, packing greedily.
    let buf = ''
    for (const sentence of t.split(/(?<=[.!?])\s+/)) {
      if (buf && buf.length + sentence.length + 1 > CHUNK_TARGET_CHARS) {
        units.push(buf)
        buf = sentence
      } else {
        buf = buf ? `${buf} ${sentence}` : sentence
      }
    }
    if (buf) units.push(buf)
  }
  // Pack small paragraphs together so a doc of one-liners doesn't become a
  // hundred slivers; a chunk below the minimum rides with its neighbour.
  const chunks: string[] = []
  let buf = ''
  for (const u of units) {
    if (buf && buf.length + u.length + 2 > CHUNK_TARGET_CHARS && buf.length >= CHUNK_MIN_CHARS) {
      chunks.push(buf)
      buf = u
    } else {
      buf = buf ? `${buf}\n\n${u}` : u
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

function contentHash(title: string, text: string): string {
  return createHash('sha1')
    .update(CHUNK_PARAMS_VERSION)
    .update('\0')
    .update(title)
    .update('\0')
    .update(text)
    .digest('hex')
}

// ── Indexing ───────────────────────────────────────────────────────────────

export interface ChunkSourceInput {
  sourceType: string
  sourceId: string
  title: string
  text: string
  sourceKind?: string | null
  roomId?: string | null
  orgId: string
  updatedAt?: number
}

// (Re)index one source. Content-hash cheap: unchanged text is a single
// SELECT. Returns how many chunks now stand for the source.
export function reindexSourceChunks(db: ChunkDb, input: ChunkSourceInput): number {
  ensureChunkTables(db)
  const hash = contentHash(input.title, input.text)
  const existing = db
    .prepare(
      `SELECT count(*) AS n, min(content_hash) AS h FROM fb_chunks WHERE source_type = ? AND source_id = ?`
    )
    .get(input.sourceType, input.sourceId) as { n: number; h: string | null }
  if (existing.n > 0 && existing.h === hash) return Number(existing.n)
  const chunks = chunkText(input.text)
  const now = Date.now()
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM fb_chunks WHERE source_type = ? AND source_id = ?`).run(
      input.sourceType,
      input.sourceId
    )
    const ins = db.prepare(
      `INSERT INTO fb_chunks (id, source_type, source_id, chunk_index, title, text, content_hash,
         room_id, chunk_date, source_kind, sensitivity, org_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
    )
    chunks.forEach((text, i) => {
      ins.run(
        `${input.sourceType}:${input.sourceId}:${i}`,
        input.sourceType,
        input.sourceId,
        i,
        input.title,
        text,
        hash,
        input.roomId ?? null,
        input.updatedAt ?? now,
        input.sourceKind ?? null,
        input.orgId,
        now,
        now
      )
    })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return chunks.length
}

export function removeSourceChunks(db: ChunkDb, sourceType: string, sourceId: string): void {
  ensureChunkTables(db)
  db.prepare(`DELETE FROM fb_chunks WHERE source_type = ? AND source_id = ?`).run(sourceType, sourceId)
}

// ── The extraction ledger ──────────────────────────────────────────────────

export function ledgerGet(db: ChunkDb, sourceType: string, sourceId: string): string | null {
  const r = db
    .prepare(`SELECT content_hash AS h FROM fb_chunk_ledger WHERE source_type = ? AND source_id = ?`)
    .get(sourceType, sourceId) as { h: string } | undefined
  return r?.h ?? null
}

export function ledgerPut(
  db: ChunkDb,
  sourceType: string,
  sourceId: string,
  orgId: string,
  hash: string,
  chunkCount: number
): void {
  db.prepare(
    `INSERT INTO fb_chunk_ledger (source_type, source_id, org_id, content_hash, chunk_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_type, source_id) DO UPDATE SET
       org_id = excluded.org_id, content_hash = excluded.content_hash,
       chunk_count = excluded.chunk_count, updated_at = excluded.updated_at`
  ).run(sourceType, sourceId, orgId, hash, chunkCount, Date.now())
}

export function ledgerDelete(db: ChunkDb, sourceType: string, sourceId: string): void {
  db.prepare(`DELETE FROM fb_chunk_ledger WHERE source_type = ? AND source_id = ?`).run(
    sourceType,
    sourceId
  )
}

// ── Search ─────────────────────────────────────────────────────────────────

export interface ChunkHit {
  sourceId: string
  title: string
  sourceKind: string | null
  // The desk the source lives on, when the source type has one (widgets).
  roomId: string | null
  // Best (lowest) BM25 rank among the source's matched chunks.
  rank: number
  // The matched passages, best first, capped.
  passages: string[]
}

// Build a safe FTS5 MATCH expression from free text: bare terms, quoted, OR'd.
// OR rather than AND because BM25 already rewards multi-term hits and the
// relevance gate downstream culls single-term coincidences (AI-26); an AND
// query would return nothing for a question with one off-vocabulary word.
export function ftsQuery(query: string): string | null {
  const terms = (query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).slice(0, 12)
  if (terms.length === 0) return null
  // Prefix queries give forward inflection matching without a stemmer
  // ("decide"* finds decided/decides); the stripped variants cover the
  // reverse direction ("renewals" also tries "renewal"*). Short tokens stay
  // exact — a 2-3 char prefix would match half the language (#28).
  const tokens = new Set<string>()
  for (const t of terms) {
    for (const v of termVariants(t)) tokens.add(v.length >= 4 ? `"${v}"*` : `"${v}"`)
    if (tokens.size >= 24) break
  }
  return [...tokens].join(' OR ')
}

// Passage-level search, grouped back to sources. Org-scoped; `sourceType`
// bounds which population is searched ('document', 'widget', 'file', 'chat').
export function searchChunks(
  db: ChunkDb,
  query: string,
  opts: { orgId: string; sourceType?: string; limit?: number; passagesPerSource?: number }
): ChunkHit[] {
  ensureChunkTables(db)
  const match = ftsQuery(query)
  if (!match) return []
  const limit = opts.limit ?? 6
  const perSource = opts.passagesPerSource ?? 3
  const rows = db
    .prepare(
      `SELECT c.source_id AS sourceId, c.title AS title, c.source_kind AS sourceKind,
              c.room_id AS roomId, c.text AS text, bm25(fb_chunks_fts, 0, 0, 5.0, 1.0) AS rank
       FROM fb_chunks_fts f JOIN fb_chunks c ON c.id = f.chunk_id
       WHERE fb_chunks_fts MATCH ? AND f.org_id = ?${opts.sourceType ? ' AND c.source_type = ?' : ''}
       ORDER BY rank LIMIT 80`
    )
    .all(
      ...(opts.sourceType ? [match, opts.orgId, opts.sourceType] : [match, opts.orgId])
    ) as Array<{
    sourceId: string
    title: string
    sourceKind: string | null
    roomId: string | null
    text: string
    rank: number
  }>
  const bySource = new Map<string, ChunkHit>()
  for (const r of rows) {
    let hit = bySource.get(r.sourceId)
    if (!hit) {
      hit = {
        sourceId: r.sourceId,
        title: r.title,
        sourceKind: r.sourceKind,
        roomId: r.roomId,
        rank: r.rank,
        passages: []
      }
      bySource.set(r.sourceId, hit)
    }
    if (hit.passages.length < perSource) hit.passages.push(r.text)
  }
  return [...bySource.values()].sort((a, b) => a.rank - b.rank).slice(0, limit)
}

// ── The app-facing wrappers (real getDb) ───────────────────────────────────

function appDb(): ChunkDb {
  return getDb() as unknown as ChunkDb
}

// True when the index holds anything for this org — the signal that the
// chunk-backed document pool is live. A fresh profile before its first sweep
// answers false and retrieval uses the legacy whole-document path.
export function chunkIndexActive(): boolean {
  try {
    const db = appDb()
    ensureChunkTables(db)
    const r = db
      .prepare(`SELECT count(*) AS n FROM fb_chunks WHERE source_type = 'document' AND org_id = ?`)
      .get(getActiveOrgId()) as { n: number }
    return Number(r.n) > 0
  } catch {
    return false
  }
}

// Reindex one document (the save chokepoint calls this, best-effort).
export function reindexDocumentChunks(docId: string): void {
  try {
    const meta = listDocuments().find((m) => m.id === docId)
    const full = getDocument(docId)
    if (!meta || !full) {
      removeSourceChunks(appDb(), 'document', docId)
      return
    }
    const text = extractDocText(meta.docType, full.body)
    if (!text.trim()) {
      removeSourceChunks(appDb(), 'document', docId)
      return
    }
    reindexSourceChunks(appDb(), {
      sourceType: 'document',
      sourceId: docId,
      title: meta.title,
      text,
      sourceKind: meta.docType,
      orgId: getActiveOrgId(),
      updatedAt: meta.updatedAt
    })
  } catch {
    // Indexing must never break a save; the sweep reconciles later.
  }
}

// Reconcile the whole document population: index what's missing or changed
// (content-hash cheap), delete chunks whose document is gone. Called once at
// startup, deferred off the critical path.
export function sweepDocumentChunks(): { indexed: number; removed: number } {
  const db = appDb()
  ensureChunkTables(db)
  const docs = listDocuments()
  const live = new Set(docs.map((d) => d.id))
  let indexed = 0
  for (const m of docs) {
    const full = getDocument(m.id)
    if (!full) continue
    const text = extractDocText(m.docType, full.body)
    if (!text.trim()) continue
    const before = db
      .prepare(`SELECT min(content_hash) AS h FROM fb_chunks WHERE source_type = 'document' AND source_id = ?`)
      .get(m.id) as { h: string | null }
    if (before.h !== contentHash(m.title, text)) {
      reindexSourceChunks(db, {
        sourceType: 'document',
        sourceId: m.id,
        title: m.title,
        text,
        sourceKind: m.docType,
        orgId: getActiveOrgId(),
        updatedAt: m.updatedAt
      })
      indexed++
    }
  }
  const stale = db
    .prepare(`SELECT DISTINCT source_id AS id FROM fb_chunks WHERE source_type = 'document'`)
    .all() as Array<{ id: string }>
  let removed = 0
  for (const s of stale) {
    if (!live.has(s.id)) {
      removeSourceChunks(db, 'document', s.id)
      removed++
    }
  }
  return { indexed, removed }
}

// The chunk-backed document pool, shaped as WorkspaceSource for retrieval.
// Text is the matched passages themselves — the paragraph that answers, not
// the document's head — passed through selectPassages only to enforce the
// prompt budget shape it expects.
export function chunkSearchDocuments(query: string, limit = 6): WorkspaceSource[] {
  const hits = searchChunks(appDb(), query, {
    orgId: getActiveOrgId(),
    sourceType: 'document',
    limit
  })
  return hits.map((h, i) => {
    const joined = h.passages.join('\n…\n')
    const meta = getDocMetadata(h.sourceId)
    return {
      docId: h.sourceId,
      title: h.title || 'Untitled',
      docType: h.sourceKind ?? 'doc',
      snippet: joined.replace(/\s+/g, ' ').trim().slice(0, 200),
      text: selectPassages(query, joined),
      score: 1 - i * 0.01,
      summary: meta?.summary || undefined,
      category: meta?.category || undefined,
      dates: meta?.dates,
      entities: meta?.entities
    }
  })
}

// ── Widgets (#16) ──────────────────────────────────────────────────────────
//
// The widget kinds the chunk index carries — the ones that hold real user
// content and were previously unreachable by retrieval. NOT indexed here, on
// purpose: note/sticky/markdown/page (the extras pool already ranks them),
// table (the extras pool reads fb_tables directly), doc/sheet/slides/map/
// design (their content IS an fb_documents row, already the document pool),
// and the webview family (live pages are the canvas-attachment lane, #19/#20).
export const INDEXED_WIDGET_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'living-doc',
  'card',
  'custom-block',
  'field',
  'agent',
  'mindmap',
  'diagram',
  'chart'
])

// A chart widget's content references a table; resolve it so the chart's text
// names its series over the real table, same shape the attachment path uses.
function chartTableResolver(tableId: string): ResolvedTable | null {
  const t = listTables().find((x) => x.id === tableId)
  if (!t) return null
  return {
    title: t.title,
    columns: t.schema.columns.map((c) => ({ id: c.id, label: c.label })),
    rows: listRows(t.id).map((r) => r.cells as Record<string, unknown>)
  }
}

// Pure-ish shape step, exported for tests: a widget reduced to the chunk
// source it should index as, or null when it has nothing sayable. widgetToText
// yields honest placeholders like "(diagram)" for unreadable content — those
// never enter the index, because retrieval quoting a placeholder as evidence
// would be decoration, not grounding.
export function widgetChunkSource(
  w: Widget,
  orgId: string,
  resolvers: WidgetTextResolvers = {}
): ChunkSourceInput | null {
  if (!INDEXED_WIDGET_KINDS.has(w.kind)) return null
  const wt = widgetToText(w, resolvers)
  const text = (wt.text || '').trim()
  if (!text || /^\(.*\)$/.test(text)) return null
  return {
    sourceType: 'widget',
    sourceId: w.id,
    title: w.title || text.replace(/\s+/g, ' ').slice(0, 60),
    text,
    sourceKind: w.kind,
    roomId: w.taskId ?? null,
    orgId,
    updatedAt: w.updatedAt
  }
}

// The active org's node ids — the org fence for widgets, which carry no org of
// their own, only a desk. A widget whose desk is not one of the active org's
// nodes is not this org's content and is never indexed under its org id.
function activeOrgNodeIds(): Set<string> {
  return new Set(listNodes().map((n) => n.id))
}

// (Re)index one widget — the save chokepoint, best-effort. Also the removal
// path: a trashed widget, an emptied one, or a kind we do not index drops its
// chunks so stale canvas content never grounds an answer.
export function reindexWidgetChunks(widgetId: string): void {
  try {
    const db = appDb()
    // The Widget shape does not carry trash state; read it off the row — a
    // trashed widget's content must stop grounding answers immediately.
    const row = db.prepare(`SELECT trashed_at AS t FROM widgets WHERE id = ?`).get(widgetId) as
      | { t: number | null }
      | undefined
    const w = row && row.t == null ? getWidget(widgetId) : null
    if (!w) {
      removeSourceChunks(db, 'widget', widgetId)
      return
    }
    if (!INDEXED_WIDGET_KINDS.has(w.kind)) return
    if (w.taskId == null || !activeOrgNodeIds().has(w.taskId)) return
    const input = widgetChunkSource(w, getActiveOrgId(), { table: chartTableResolver })
    if (!input) {
      removeSourceChunks(db, 'widget', widgetId)
      return
    }
    reindexSourceChunks(db, input)
  } catch {
    // Indexing must never break a widget save; the sweep reconciles later.
  }
}

// Reconcile the widget population for the active org: index what is missing
// or changed (content-hash cheap), drop chunks whose widget is gone, trashed,
// or emptied. Runs with the boot sweep.
export function sweepWidgetChunks(): { indexed: number; removed: number } {
  const db = appDb()
  ensureChunkTables(db)
  const org = getActiveOrgId()
  const orgNodes = activeOrgNodeIds()
  const live = new Set<string>()
  let indexed = 0
  for (const kind of INDEXED_WIDGET_KINDS) {
    for (const w of listWidgetsByKind(kind)) {
      if (w.taskId == null || !orgNodes.has(w.taskId)) continue
      const input = widgetChunkSource(w, org, { table: chartTableResolver })
      if (!input) continue
      live.add(w.id)
      const before = db
        .prepare(
          `SELECT count(*) AS n, min(content_hash) AS h FROM fb_chunks WHERE source_type = 'widget' AND source_id = ?`
        )
        .get(w.id) as { n: number; h: string | null }
      if (Number(before.n) === 0 || before.h !== contentHash(input.title, input.text)) {
        reindexSourceChunks(db, input)
        indexed++
      }
    }
  }
  const stale = db
    .prepare(`SELECT DISTINCT source_id AS id FROM fb_chunks WHERE source_type = 'widget' AND org_id = ?`)
    .all(org) as Array<{ id: string }>
  let removed = 0
  for (const s of stale) {
    if (!live.has(s.id)) {
      removeSourceChunks(db, 'widget', s.id)
      removed++
    }
  }
  return { indexed, removed }
}

// The widget pool for retrieval. docType carries the widget KIND so the trace
// can say what a source is (a living doc, an agent, a chart) and the citation
// can route to it. Desk scope demotes off-scope widgets, never excludes (#12).
export function chunkSearchWidgets(
  query: string,
  limit = 6,
  scopeNodeIds?: string[]
): WorkspaceSource[] {
  try {
    return chunkSearchWidgetsInner(query, limit, scopeNodeIds)
  } catch {
    // Retrieval must never break on an unavailable index — an empty pool is
    // the honest degraded result, same contract as chunkIndexActive().
    return []
  }
}

function chunkSearchWidgetsInner(
  query: string,
  limit: number,
  scopeNodeIds?: string[]
): WorkspaceSource[] {
  const hits = searchChunks(appDb(), query, {
    orgId: getActiveOrgId(),
    sourceType: 'widget',
    limit: limit * 2
  })
  const scope = scopeNodeIds && scopeNodeIds.length > 0 ? new Set(scopeNodeIds) : null
  const shaped = hits.map((h, i) => {
    const joined = h.passages.join('\n…\n')
    return {
      source: {
        docId: h.sourceId,
        title: h.title || 'Untitled',
        docType: h.sourceKind ?? 'widget',
        snippet: joined.replace(/\s+/g, ' ').trim().slice(0, 200),
        text: selectPassages(query, joined),
        score: 1 - i * 0.01
      },
      inScope: !scope || (h.roomId != null && scope.has(h.roomId))
    }
  })
  return mergeScopedPools(
    shaped.filter((s) => s.inScope).map((s) => s.source),
    shaped.filter((s) => !s.inScope).map((s) => s.source),
    limit
  )
}

// ── Files (#17) ────────────────────────────────────────────────────────────
//
// Files were @-mentionable but never FOUND — you had to already know the
// name. This pool reads every Drive file whose format carries text (the same
// families fileText.ts can extract) and makes its contents passage-searchable.
// Extraction is the expensive step, so the ledger gates it: one read per file
// version, even when the result is "no text here".

const FILE_INDEXABLE_EXT = /^\.?(pdf|docx|xlsx|xls|csv|txt|md|markdown|json|tsv|log|html?|xml|yaml|yml|rtf)$/i
const FILE_MAX_BYTES = 15 * 1024 * 1024
// How many NEW extractions one boot sweep will run. Deferred files are
// reported, not silently dropped, and the next boot continues where this one
// stopped (the ledger remembers).
export const FILE_SWEEP_BATCH = 40

// Cheap version stamp — no byte read. Size + updated_at changes on every
// ingest; synced byte overwrites bypass it, so that hook forces.
function fileVersionHash(f: IndexableFile): string {
  return `${CHUNK_PARAMS_VERSION}:${f.sizeBytes}:${f.updatedAt}`
}

// (Re)index one file, extraction included — async and best-effort. Missing or
// trashed files drop their chunks; unreadable or non-text files are recorded
// in the ledger as zero chunks so they are never re-extracted for nothing.
export async function indexFileChunks(fileId: string, opts: { force?: boolean } = {}): Promise<void> {
  try {
    const db = appDb()
    ensureChunkTables(db)
    const f = getIndexableFile(fileId)
    if (!f) {
      removeSourceChunks(db, 'file', fileId)
      ledgerDelete(db, 'file', fileId)
      return
    }
    const org = getActiveOrgId()
    const hash = fileVersionHash(f)
    if (!opts.force && ledgerGet(db, 'file', f.id) === hash) return
    if (!FILE_INDEXABLE_EXT.test(f.ext || '') || f.sizeBytes > FILE_MAX_BYTES) {
      removeSourceChunks(db, 'file', f.id)
      ledgerPut(db, 'file', f.id, org, hash, 0)
      return
    }
    const text = ((await extractFileText(f.id)) ?? '').trim()
    // fileText's honest failure note is a message to a human, not content.
    if (!text || text.startsWith("(couldn't read")) {
      removeSourceChunks(db, 'file', f.id)
      ledgerPut(db, 'file', f.id, org, hash, 0)
      return
    }
    const n = reindexSourceChunks(db, {
      sourceType: 'file',
      sourceId: f.id,
      title: f.name,
      text,
      sourceKind: (f.ext || '').replace(/^\./, '').toLowerCase() || 'file',
      orgId: org,
      updatedAt: f.updatedAt
    })
    ledgerPut(db, 'file', f.id, org, hash, n)
  } catch {
    // Indexing must never break an ingest; the sweep reconciles later.
  }
}

// Reconcile the file population for the active org. At most FILE_SWEEP_BATCH
// new extractions per run — the remainder is counted and reported so a big
// first boot converges over a few launches instead of wedging one.
export async function sweepFileChunks(): Promise<{ indexed: number; removed: number; deferred: number }> {
  const db = appDb()
  ensureChunkTables(db)
  const org = getActiveOrgId()
  const files = listIndexableFiles()
  const live = new Set(files.map((f) => f.id))
  let indexed = 0
  let deferred = 0
  let budget = FILE_SWEEP_BATCH
  for (const f of files) {
    if (ledgerGet(db, 'file', f.id) === fileVersionHash(f)) continue
    if (budget <= 0) {
      deferred++
      continue
    }
    budget--
    await indexFileChunks(f.id)
    indexed++
  }
  let removed = 0
  const stale = db
    .prepare(`SELECT DISTINCT source_id AS id FROM fb_chunks WHERE source_type = 'file' AND org_id = ?`)
    .all(org) as Array<{ id: string }>
  for (const s of stale) {
    if (!live.has(s.id)) {
      removeSourceChunks(db, 'file', s.id)
      ledgerDelete(db, 'file', s.id)
      removed++
    }
  }
  // Zero-chunk ledger rows (org-scoped — file ids are unique, but another
  // org's rows must survive an org switch) whose file is gone.
  const lstale = db
    .prepare(`SELECT source_id AS id FROM fb_chunk_ledger WHERE source_type = 'file' AND org_id = ?`)
    .all(org) as Array<{ id: string }>
  for (const s of lstale) {
    if (!live.has(s.id)) ledgerDelete(db, 'file', s.id)
  }
  return { indexed, removed, deferred }
}

// The file pool for retrieval: docType 'file', titled by the Drive name.
export function chunkSearchFiles(query: string, limit = 6): WorkspaceSource[] {
  try {
    return chunkSearchFilesInner(query, limit)
  } catch {
    return [] // same best-effort contract as the widget pool
  }
}

function chunkSearchFilesInner(query: string, limit: number): WorkspaceSource[] {
  const hits = searchChunks(appDb(), query, {
    orgId: getActiveOrgId(),
    sourceType: 'file',
    limit
  })
  return hits.map((h, i) => {
    const joined = h.passages.join('\n…\n')
    return {
      docId: h.sourceId,
      title: h.title || 'Untitled file',
      docType: 'file',
      snippet: joined.replace(/\s+/g, ' ').trim().slice(0, 200),
      text: selectPassages(query, joined),
      score: 1 - i * 0.01
    }
  })
}

// ── Chat history (#17, the mechanism behind #18) ───────────────────────────
//
// Past Plexii conversations become a retrieval pool, so "what did we decide
// about pricing last week" has somewhere to look. The transcript is indexed
// as plain turns; the CURRENT conversation is excluded at search time (its
// content is already the model's message history — citing it back as a
// discovered source would be theatre).

// Pure, exported for tests: a conversation's messages as indexable text.
export function chatTranscriptText(
  messages: Array<{ role: string; content: string }>
): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .map((m) => `${m.role === 'user' ? 'You' : 'Plexii'}: ${m.content.trim()}`)
    .join('\n\n')
}

// (Re)index one conversation — the append/rename chokepoints, best-effort.
// getConversation is org-guarded: a conversation the active org does not own
// resolves null and is left alone (its own org reindexes it), EXCEPT when the
// caller knows it was deleted (removed = true), which drops chunks globally.
export function reindexChatChunks(conversationId: string, removed = false): void {
  try {
    const db = appDb()
    if (removed) {
      removeSourceChunks(db, 'chat', conversationId)
      return
    }
    const convo = getConversation(conversationId)
    if (!convo) return
    const text = chatTranscriptText(convo.messages)
    if (!text.trim()) {
      removeSourceChunks(db, 'chat', conversationId)
      return
    }
    reindexSourceChunks(db, {
      sourceType: 'chat',
      sourceId: conversationId,
      title: convo.meta.title?.trim() || convo.meta.preview?.trim() || 'Untitled chat',
      text,
      sourceKind: 'chat',
      roomId: convo.meta.taskId ?? null,
      orgId: getActiveOrgId(),
      updatedAt: convo.meta.updatedAt
    })
  } catch {
    // Indexing must never break a chat write; the sweep reconciles later.
  }
}

// Reconcile the active org's conversations. The cheap pre-check rides
// chunk_date (stored as the conversation's updated_at), so an untouched
// conversation costs one SELECT, not a transcript load.
export function sweepChatChunks(): { indexed: number; removed: number } {
  const db = appDb()
  ensureChunkTables(db)
  const org = getActiveOrgId()
  const convos = listConversations()
  const live = new Set(convos.map((c) => c.id))
  let indexed = 0
  for (const c of convos) {
    const fresh = db
      .prepare(
        `SELECT 1 FROM fb_chunks WHERE source_type = 'chat' AND source_id = ? AND chunk_date = ? LIMIT 1`
      )
      .get(c.id, c.updatedAt)
    if (fresh) continue
    reindexChatChunks(c.id)
    indexed++
  }
  let removed = 0
  const stale = db
    .prepare(`SELECT DISTINCT source_id AS id FROM fb_chunks WHERE source_type = 'chat' AND org_id = ?`)
    .all(org) as Array<{ id: string }>
  for (const s of stale) {
    if (!live.has(s.id)) {
      removeSourceChunks(db, 'chat', s.id)
      removed++
    }
  }
  return { indexed, removed }
}

// The chat pool for retrieval: docType 'chat', titled by the conversation.
//
// Chats have carried a desk id since they were first indexed (room_id, from
// convo.meta.taskId) and nobody was reading it, so a conversation held ON this
// desk ranked no higher than one from six months ago about something else.
// Scoped the same way as widgets: in-scope first, off-scope demoted, never
// excluded (#12) — "what did we decide about this last time" has to be able to
// reach back past the desk you are standing on.
export function chunkSearchChats(
  query: string,
  limit = 6,
  excludeConversationId?: string,
  scopeNodeIds?: string[]
): WorkspaceSource[] {
  try {
    return chunkSearchChatsInner(query, limit, excludeConversationId, scopeNodeIds)
  } catch {
    return [] // same best-effort contract as the widget pool
  }
}

function chunkSearchChatsInner(
  query: string,
  limit: number,
  excludeConversationId?: string,
  scopeNodeIds?: string[]
): WorkspaceSource[] {
  const hits = searchChunks(appDb(), query, {
    orgId: getActiveOrgId(),
    sourceType: 'chat',
    // Over-fetch when scoping so the demoted tail has something to be made of.
    limit: (scopeNodeIds && scopeNodeIds.length > 0 ? limit * 2 : limit) + 1
  }).filter((h) => h.sourceId !== excludeConversationId)
  const scope = scopeNodeIds && scopeNodeIds.length > 0 ? new Set(scopeNodeIds) : null
  const shaped = hits.map((h, i) => {
    const joined = h.passages.join('\n…\n')
    return {
      source: {
        docId: h.sourceId,
        title: h.title || 'Untitled chat',
        docType: 'chat',
        snippet: joined.replace(/\s+/g, ' ').trim().slice(0, 200),
        text: selectPassages(query, joined),
        score: 1 - i * 0.01
      },
      inScope: !scope || (h.roomId != null && scope.has(h.roomId))
    }
  })
  if (!scope) return shaped.slice(0, limit).map((s) => s.source)
  return mergeScopedPools(
    shaped.filter((s) => s.inScope).map((s) => s.source),
    shaped.filter((s) => !s.inScope).map((s) => s.source),
    limit
  )
}
