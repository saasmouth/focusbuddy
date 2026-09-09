import type { Widget } from '@shared/types'
import { contentToPlainText } from '@shared/widgetText'
import { listNodes } from './db/nodes'
import { listDocuments, getDocument } from './db/documents'
import { listWidgetsByTask } from './db/widgets'
import { listEntries, hasFileBytes } from './db/files'
import { upsertKnowledgeBySource, hasKnowledgeSource, pruneKnowledgeSources } from './db/knowledge'
import { extractDocText } from './workspaceRank'
import { extractFileText } from './fileText'

// Sync the whole workspace into the PlexiBrain knowledge base, so the Brain reads
// everything — every desk, document, note/page, and Drive file — not just the few
// entries someone typed by hand. A true SYNC: adds new objects, refreshes changed
// ones, and prunes entries whose object was deleted; manual (source-less) entries
// are never touched. Deterministic + honest (no invented content — a file whose
// text can't be read gets its name and an empty body, never a fabricated summary).
//
// Cheap to re-run: files are immutable once ingested, so a file already in the
// brain is skipped rather than re-parsed — which is what makes running this on
// boot and whenever the Brain is opened affordable.
//
// Entries are tagged so the Brain Map's shared-tag edges form real clusters: by
// object type (desk / document / note / file), by subtype (docType / extension),
// and by the desk they live on (so a desk's notes group together).

const BODY_CAP = 8000
const TEXT_WIDGET = new Set<Widget['kind']>(['note', 'page', 'markdown', 'card', 'living-doc', 'sticky'])

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export interface BrainIngestStats {
  desks: number
  documents: number
  widgets: number
  files: number
  created: number
  updated: number
  removed: number
}

export async function ingestWorkspaceIntoBrain(): Promise<BrainIngestStats> {
  const stats: BrainIngestStats = { desks: 0, documents: 0, widgets: 0, files: 0, created: 0, updated: 0, removed: 0 }
  const live = new Set<string>()
  const record = (kind: string, id: string, draft: Parameters<typeof upsertKnowledgeBySource>[2]): void => {
    const r = upsertKnowledgeBySource(kind, id, draft)
    if (r.created) stats.created++
    else stats.updated++
    live.add(`${kind}:${id}`)
  }

  const nodes = listNodes()

  // Desks / folders / tasks — each is a topic node in the brain.
  for (const n of nodes) {
    const tags = ['workspace', n.kind]
    if (n.status) tags.push(n.status)
    record('node', n.id, {
      title: n.title?.trim() || `(untitled ${n.kind})`,
      body: (n.description ?? '').slice(0, BODY_CAP),
      tags
    })
    stats.desks++
  }

  // Documents (Word / Sheet / Slides / Map) — real body text via the shared extractor.
  for (const meta of listDocuments()) {
    const doc = getDocument(meta.id)
    if (!doc) continue
    let body = ''
    try {
      body = extractDocText(doc.docType, doc.body).slice(0, BODY_CAP)
    } catch {
      body = ''
    }
    record('document', meta.id, {
      title: meta.title?.trim() || 'Untitled document',
      body,
      tags: ['document', meta.docType]
    })
    stats.documents++
  }

  // Text widgets with real content, tagged by the desk they live on so a desk's
  // notes cluster together in the Brain Map.
  for (const n of nodes) {
    let widgets: Widget[] = []
    try {
      widgets = listWidgetsByTask(n.id)
    } catch {
      widgets = []
    }
    const deskTag = slug(n.title ?? '')
    for (const w of widgets) {
      if (!TEXT_WIDGET.has(w.kind) || w.archived) continue
      const text = contentToPlainText(w.content).trim()
      if (!text) continue
      record('widget', w.id, {
        title: w.title?.trim() || `${w.kind} on ${n.title ?? 'a desk'}`,
        body: text.slice(0, BODY_CAP),
        tags: [w.kind, ...(deskTag ? [deskTag] : [])]
      })
      stats.widgets++
    }
  }

  // Drive files — recurse the folder tree. A file is immutable once ingested, so
  // one already in the brain is kept as-is (skip the expensive re-parse); a new
  // one is extracted (PDF/Word/spreadsheet/text) or stored name-only if binary.
  // 'doc' entries are covered by the documents pass above.
  const seen = new Set<string>()
  const walk = async (parentId: string | null, depth: number): Promise<void> => {
    if (depth > 12) return
    let entries: Awaited<ReturnType<typeof listEntries>> = []
    try {
      entries = listEntries(parentId)
    } catch {
      return
    }
    for (const e of entries) {
      if (e.kind === 'folder') {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        await walk(e.id, depth + 1)
      } else if (e.kind === 'file') {
        stats.files++
        if (hasKnowledgeSource('file', e.id)) {
          live.add(`file:${e.id}`) // already indexed; immutable, so keep as-is
          continue
        }
        // A file synced from another member arrives as metadata first; its bytes
        // land a moment later over the blob channel. Don't index it until the bytes
        // are here, otherwise the file-skip optimisation above would lock in an
        // empty (name-only) entry that a later sync never refreshes. Skipping
        // (without marking it live) leaves it to be indexed on the next sync once
        // the bytes arrive.
        if (!(await hasFileBytes(e.id))) continue
        let body = ''
        try {
          body = (await extractFileText(e.id)) ?? ''
        } catch {
          body = ''
        }
        const ext = (e.ext ?? '').replace(/^\./, '')
        record('file', e.id, {
          title: e.name?.trim() || 'File',
          body: body.slice(0, BODY_CAP),
          tags: ['file', ...(ext ? [ext] : [])]
        })
      }
    }
  }
  await walk(null, 0)

  // Remove brain entries whose workspace object was deleted (true sync).
  stats.removed = pruneKnowledgeSources(live)

  return stats
}
