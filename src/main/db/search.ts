import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import { contentToText, makeSnippet, escapeLike, scoreMatch, semanticHitScore } from './searchText'
import { semanticSearchKnowledge, knowledgeSemanticActive } from '../semanticRetrieval'
import { semanticSearchDocuments, documentSemanticActive } from '../documentRetrieval'
import type { SearchHit, DocType } from '@shared/types'

// Global "find anything" search across the local workspace: node titles +
// descriptions, widget text, document bodies, table-row cells, file names, and
// PlexiBrain knowledge. Most categories use plain SQL LIKE, which stays
// dependency-free and instant for a personal-sized DB; knowledge is ranked by
// meaning (semantic embeddings blended with keyword) when an embedding key is
// configured and by keyword otherwise, so the palette finds a "time off" note
// titled "annual leave" without ever inventing a match. The searchText helpers
// turn JSON bodies into readable snippets. Trashed and archived content is
// excluded so search only surfaces live things.

const PER_CATEGORY = 20
const TOTAL = 40

// Mail is a live IMAP view with no local message store, so global search
// covers what the app has actually fetched: the main process keeps the most
// recent inbox page here (fed by the mail:list IPC handler). Honest partial
// coverage — recent inbox only — until a real local mail index exists.
interface CachedMailItem {
  uid: number
  fromName: string
  fromAddress: string
  subject: string
  snippet?: string
  // Kept alongside the search fields so an inbox widget can be described to the
  // assistant: "3 unread, oldest from Tuesday" needs read state and dates, and
  // the mail:list handler already has them — the previous mapping simply threw
  // them away. See getCachedMailItems.
  date?: number
  seen?: boolean
  flagged?: boolean
  hasAttachments?: boolean
}
let mailCache: CachedMailItem[] = []
export function setMailSearchCache(items: Array<CachedMailItem & { snippet?: string }>): void {
  mailCache = items.map((m) => ({
    uid: m.uid,
    fromName: m.fromName,
    fromAddress: m.fromAddress,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
    seen: m.seen,
    flagged: m.flagged,
    hasAttachments: m.hasAttachments
  }))
}

/**
 * The inbox page the app has actually fetched this session, or null when none
 * has been.
 *
 * null and [] mean different things to a caller and must stay distinguishable:
 * nobody has opened mail yet, versus the inbox is genuinely empty. Reporting the
 * first as the second would have the assistant state there is no mail when it
 * simply has not looked.
 *
 * Deliberately returns no snippets. Callers that put this in front of a model
 * get headers only — the reasoning is in src/main/ai/mailTriage.ts.
 */
export function getCachedMailItems(): Array<Omit<CachedMailItem, 'snippet'>> | null {
  if (mailCache.length === 0) return null
  return mailCache.map(({ snippet: _snippet, ...rest }) => rest)
}
const ESC = " ESCAPE '\\'"

export async function searchAll(rawQuery: string): Promise<SearchHit[]> {
  const query = rawQuery.trim()
  if (query.length < 2) return []
  const db = getDb()
  const like = `%${escapeLike(query)}%`
  const hits: SearchHit[] = []

  // Folders + tasks.
  const nodeRows = db
    .prepare(
      `SELECT id, kind, title, description FROM nodes
       WHERE trashed_at IS NULL AND archived = 0
       AND kind IN ('folder', 'task')
       AND (title LIKE ?${ESC} OR description LIKE ?${ESC}) LIMIT ?`
    )
    .all(like, like, PER_CATEGORY) as Array<{
    id: string
    kind: 'folder' | 'task'
    title: string
    description: string
  }>
  for (const r of nodeRows) {
    const body = r.description ?? ''
    hits.push({
      type: r.kind === 'folder' ? 'folder' : 'task',
      id: r.id,
      title: r.title || (r.kind === 'folder' ? 'Untitled folder' : 'Untitled task'),
      snippet: makeSnippet(body || r.title, query),
      score: scoreMatch(r.title, body, query)
    })
  }

  // Widgets — sticky / note / page / markdown etc. Their text routes to the
  // task canvas they live on.
  const widgetRows = db
    .prepare(
      `SELECT id, task_id, kind, title, content FROM widgets
       WHERE trashed_at IS NULL AND archived = 0
       AND (title LIKE ?${ESC} OR content LIKE ?${ESC}) LIMIT ?`
    )
    .all(like, like, PER_CATEGORY) as Array<{
    id: string
    task_id: string
    kind: string
    title: string
    content: string
  }>
  for (const r of widgetRows) {
    const text = contentToText(r.content)
    hits.push({
      type: 'widget',
      id: r.id,
      title: r.title || `${r.kind} widget`,
      snippet: makeSnippet(text || r.title, query),
      score: scoreMatch(r.title, text, query),
      taskId: r.task_id,
      widgetKind: r.kind
    })
  }

  // Documents (doc / sheet / slides) ranked by meaning when an embedding key is
  // set and by keyword otherwise, the same blend knowledge uses, so the results
  // list honours "ranks by meaning, not just exact words" rather than only the
  // AI answer. semanticSearchDocuments returns only documents the blend judged
  // relevant; each is placed on the shared score scale via semanticHitScore.
  const docSemanticActive = documentSemanticActive()
  const docHits = await semanticSearchDocuments(query, PER_CATEGORY)
  docHits.forEach((d, rank) => {
    const keyword = scoreMatch(d.title, d.text, query)
    hits.push({
      type: 'document',
      id: d.docId,
      title: d.title || 'Untitled document',
      snippet: d.snippet,
      score: semanticHitScore(keyword, rank, docSemanticActive),
      docType: d.docType as DocType
    })
  })

  // A document whose body extracts to nothing (e.g. titled but not yet written)
  // is skipped by the semantic pool, so a light title-only pass keeps it findable
  // by name. Dedupe below merges these with the ranked hits, keeping the best score.
  const docTitleRows = db
    .prepare(
      `SELECT id, doc_type, title FROM documents
       WHERE archived = 0 AND trashed_at IS NULL AND title LIKE ?${ESC} LIMIT ?`
    )
    .all(like, PER_CATEGORY) as Array<{ id: string; doc_type: 'doc' | 'sheet' | 'slides'; title: string }>
  for (const r of docTitleRows) {
    hits.push({
      type: 'document',
      id: r.id,
      title: r.title || 'Untitled document',
      snippet: makeSnippet(r.title, query),
      score: scoreMatch(r.title, '', query),
      docType: r.doc_type
    })
  }

  // Table rows — resolve to the table's task so a hit opens that canvas. Tables
  // not scoped to a task can't be routed, so they're skipped.
  const rowRows = db
    .prepare(
      `SELECT r.cells_json AS cells, t.id AS tid, t.task_id AS task_id, t.title AS ttitle
       FROM fb_rows r JOIN fb_tables t ON r.table_id = t.id
       WHERE r.cells_json LIKE ?${ESC} AND r.trashed_at IS NULL AND t.trashed_at IS NULL LIMIT ?`
    )
    .all(like, PER_CATEGORY) as Array<{
    cells: string
    tid: string
    task_id: string | null
    ttitle: string
  }>
  for (const r of rowRows) {
    if (!r.task_id) continue
    const text = contentToText(r.cells)
    hits.push({
      type: 'table-row',
      id: r.tid,
      title: r.ttitle || 'Table',
      snippet: makeSnippet(text, query),
      score: scoreMatch(r.ttitle, text, query) || 90,
      taskId: r.task_id
    })
  }

  // Tables by name. The row scan above only finds a table when a cell matches;
  // this also surfaces a table whose title matches even if no row text does.
  // Tables not scoped to a task can't be routed, so they're skipped, same as
  // the row path. Shares the 'table-row' type so a name and a row hit dedupe.
  const tableRows = db
    .prepare(
      `SELECT id, task_id, title FROM fb_tables
       WHERE task_id IS NOT NULL AND trashed_at IS NULL AND title LIKE ?${ESC} LIMIT ?`
    )
    .all(like, PER_CATEGORY) as Array<{ id: string; task_id: string; title: string }>
  for (const r of tableRows) {
    hits.push({
      type: 'table-row',
      id: r.id,
      title: r.title || 'Table',
      snippet: makeSnippet(r.title, query),
      score: scoreMatch(r.title, '', query),
      taskId: r.task_id
    })
  }

  // File-manager entries (by name).
  const fileRows = db
    .prepare(
      `SELECT id, original_name, display_name FROM fb_files
       WHERE trashed_at IS NULL
       AND (original_name LIKE ?${ESC} OR display_name LIKE ?${ESC}) LIMIT ?`
    )
    .all(like, like, PER_CATEGORY) as Array<{
    id: string
    original_name: string
    display_name: string | null
  }>
  for (const r of fileRows) {
    const name = r.display_name || r.original_name
    hits.push({
      type: 'file',
      id: r.id,
      title: name,
      snippet: '',
      score: scoreMatch(name, '', query)
    })
  }

  // PlexiBrain knowledge — ranked by meaning when an embedding key is set, by
  // keyword otherwise. semanticSearchKnowledge already returns only entries the
  // blend judged relevant (and ordered best-first), so here we just place each
  // on the shared global-search score scale: a keyword match keeps its plain
  // score, a semantic-only discovery gets a mid-band score by rank. With no key
  // and no keyword overlap an entry never reaches this loop, so nothing is faked.
  const semanticActive = knowledgeSemanticActive()
  const kEntries = await semanticSearchKnowledge(query, PER_CATEGORY)
  kEntries.forEach((e, rank) => {
    const haystack = `${e.body} ${e.tags.join(' ')}`
    const keyword = scoreMatch(e.title, haystack, query)
    hits.push({
      type: 'knowledge',
      id: e.id,
      title: e.title || 'Untitled entry',
      snippet: makeSnippet(e.body || e.tags.join(' ') || e.title, query),
      score: semanticHitScore(keyword, rank, semanticActive)
    })
  })

  // Calendar time blocks by title, scoped to the active org. A hit routes to
  // the Calendar view (startMs lets it land on the right month).
  const eventRows = db
    .prepare(
      `SELECT id, title, start_ms FROM time_blocks
       WHERE org_id = ? AND trashed_at IS NULL AND title LIKE ?${ESC} LIMIT ?`
    )
    .all(getActiveOrgId(), like, PER_CATEGORY) as Array<{ id: string; title: string; start_ms: number }>
  for (const r of eventRows) {
    hits.push({
      type: 'event',
      id: r.id,
      title: r.title || 'Untitled block',
      snippet: new Date(r.start_ms).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }),
      score: scoreMatch(r.title, '', query),
      startMs: r.start_ms
    })
  }

  // Meetings — title, summary and transcript, so "what did we decide about X"
  // finds the meeting even when only the transcript mentions it.
  const meetingRows = db
    .prepare(
      `SELECT id, title, summary, transcript FROM fb_meetings
       WHERE org_id = ? AND (title LIKE ?${ESC} OR summary LIKE ?${ESC} OR transcript LIKE ?${ESC}) LIMIT ?`
    )
    .all(getActiveOrgId(), like, like, like, PER_CATEGORY) as Array<{
    id: string
    title: string
    summary: string
    transcript: string
  }>
  for (const r of meetingRows) {
    const body = r.summary || r.transcript
    hits.push({
      type: 'meeting',
      id: r.id,
      title: r.title || 'Untitled meeting',
      snippet: makeSnippet(body || r.title, query),
      score: scoreMatch(r.title, body, query)
    })
  }

  // Signature requests by title and body.
  const signRows = db
    .prepare(
      `SELECT id, title, body FROM fb_sign_requests
       WHERE org_id = ? AND (title LIKE ?${ESC} OR body LIKE ?${ESC}) LIMIT ?`
    )
    .all(getActiveOrgId(), like, like, PER_CATEGORY) as Array<{ id: string; title: string; body: string }>
  for (const r of signRows) {
    hits.push({
      type: 'sign',
      id: r.id,
      title: r.title || 'Untitled agreement',
      snippet: makeSnippet(r.body || r.title, query),
      score: scoreMatch(r.title, r.body, query)
    })
  }

  // Recently fetched mail (see setMailSearchCache above for the coverage note).
  const q = query.toLowerCase()
  for (const m of mailCache) {
    const hay = `${m.fromName} ${m.fromAddress} ${m.subject} ${m.snippet ?? ''}`.toLowerCase()
    if (!hay.includes(q)) continue
    hits.push({
      type: 'mail',
      id: String(m.uid),
      title: m.subject || '(no subject)',
      snippet: `${m.fromName || m.fromAddress}${m.snippet ? ` — ${m.snippet.slice(0, 80)}` : ''}`,
      score: scoreMatch(m.subject, `${m.fromName} ${m.snippet ?? ''}`, query)
    })
  }

  // NOT covered here (yet): Chat. Mail is a live IMAP view with no
  // local message store, and chat history lives on the signal server — both
  // need their own search infrastructure (IMAP SEARCH / a server endpoint)
  // rather than a LIKE over local SQLite. Tracked in docs/PLEXI-REVIEW-2026-07.

  // Dedupe (a table can match on several rows) by type+id, keeping the best
  // score, then rank and cap.
  const best = new Map<string, SearchHit>()
  for (const h of hits) {
    if (h.score <= 0) continue
    const key = `${h.type}:${h.id}`
    const prev = best.get(key)
    if (!prev || h.score > prev.score) best.set(key, h)
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, TOTAL)
}
