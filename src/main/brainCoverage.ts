import { getDb } from './db/database'
import { getActiveOrgId } from './db/activeOrg'
import { listDocuments, getDocument } from './db/documents'
import { extractDocText } from './workspaceRank'
import { localAiPassCount } from './db/localAiLedger'
import { workspaceCoverage, type WorkspaceCoverage } from './embeddingCoverage'

// What the assistant can actually see.
//
// Retrieval degrades silently: an answer grounded in half the workspace looks
// exactly like an answer grounded in all of it. Everything else in this codebase
// refuses to fake a result, and this is the number that was missing - so it is
// measured and shown rather than assumed.
//
// "withText" is the honest denominator. A blank document is not a coverage gap,
// and counting it as one would invent a problem; only documents that actually
// contain extractable text can be indexed, embedded or enriched.

export interface BrainCoverage {
  documents: {
    total: number
    withText: number
    indexed: number
    /** Documents holding a whole-document vector under ANY model. */
    embedded: number
    /** Documents the live (gated) embedder can actually compare. What
     *  "Ranked by meaning" means; `embedded` overstates it whenever vectors are model-stale. Absent
     *  when the measurement failed: unknown, not zero. */
    meaningUsable?: number
    /** Documents whose only vectors were written by a different embedder. */
    meaningStale?: number
    enriched: number
    memoryScanned: number
  }
  files: { total: number; indexed: number }
  conversations: { total: number; indexed: number }
  knowledge: { total: number; meaningUsable?: number }
  /** The embedder search questions go to; null when none is allowed. */
  meaningModel?: string | null
}

function countDistinctChunkSources(sourceType: string): number {
  try {
    const row = getDb()
      .prepare(
        'SELECT count(DISTINCT source_id) AS c FROM fb_chunks WHERE source_type = ? AND org_id = ?'
      )
      .get(sourceType, getActiveOrgId()) as { c: number }
    return row.c
  } catch {
    return 0
  }
}

function scalar(sql: string, ...params: unknown[]): number {
  try {
    const row = getDb().prepare(sql).get(...(params as never[])) as { c: number } | undefined
    return row?.c ?? 0
  } catch {
    return 0
  }
}

export async function brainCoverage(): Promise<BrainCoverage> {
  const org = getActiveOrgId()
  // Model-aware coverage. Best-effort: on failure the fields stay absent and
  // the panel falls back to the raw count rather than showing an invented 0.
  let meaning: WorkspaceCoverage | null = null
  try {
    meaning = await workspaceCoverage()
  } catch {
    meaning = null
  }
  const metas = listDocuments()
  let withText = 0
  for (const m of metas) {
    const full = getDocument(m.id)
    if (!full) continue
    if (extractDocText(full.docType, full.body).trim()) withText++
  }
  return {
    documents: {
      total: metas.length,
      withText,
      indexed: countDistinctChunkSources('document'),
      embedded: scalar(
        "SELECT count(*) AS c FROM fb_embeddings WHERE item_type = 'document' AND org_id = ?",
        org
      ),
      ...(meaning
        ? { meaningUsable: meaning.documents.usable, meaningStale: meaning.documents.stale }
        : {}),
      enriched: scalar('SELECT count(*) AS c FROM fb_document_metadata'),
      memoryScanned: localAiPassCount('memory')
    },
    files: {
      total: scalar('SELECT count(*) AS c FROM fb_files'),
      indexed: countDistinctChunkSources('file')
    },
    conversations: {
      total: scalar('SELECT count(*) AS c FROM ai_chat_conversations'),
      indexed: countDistinctChunkSources('chat')
    },
    knowledge: {
      total: scalar('SELECT count(*) AS c FROM fb_knowledge'),
      ...(meaning ? { meaningUsable: meaning.knowledge.usable } : {})
    },
    ...(meaning
      ? {
          meaningModel: meaning.model
        }
      : {})
  }
}
