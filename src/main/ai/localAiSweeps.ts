import { listDocuments, getDocument } from '../db/documents'
import { extractDocText } from '../workspaceRank'
import { localModelStatus } from './localModel'
import { enrichDocument } from './enrichDocuments'
import { extractMemoryFromText } from './extractMemory'
import { reindexDocuments } from '../documentRetrieval'
import { reindexKnowledge } from '../semanticRetrieval'
import { reindexChunkEmbeddings } from '../chunkEmbeddings'
import {
  localAiContentHash,
  needsLocalAiPass,
  markLocalAiPass,
  type LocalAiPass
} from '../db/localAiLedger'

// Background local-AI passes: document enrichment and memory extraction.
//
// Both capabilities were already built, already consumed by retrieval, and free
// (they run on the local model). Both were reachable only from a button in
// Settings, so on a real workspace they had produced nothing at all: zero rows
// of document metadata, meaning the enriched grounding header - Category, Dates,
// Mentions, Summary - had never once rendered.
//
// These wrappers put them on the same footing as the chunk sweeps: deferred off
// the boot path, bounded per tick so the local model is never hammered, ledgered
// by content hash so unchanged documents are skipped, and honest when the local
// model is absent (nothing is written and the reason is returned).

export interface SweepResult {
  processed: number
  failed: number
  remaining: number
  reason?: 'no_local_model'
}

// A tick processes a handful of documents. A local chat call takes seconds, so
// this keeps each tick short and lets a backlog drain across several of them
// rather than blocking the main process in one long burst.
export const LOCAL_AI_BATCH = 6

interface Candidate {
  id: string
  title: string
  hash: string
}

/** Documents whose current content this pass has not processed yet. */
function pending(pass: LocalAiPass): Candidate[] {
  const out: Candidate[] = []
  for (const m of listDocuments()) {
    const full = getDocument(m.id)
    if (!full) continue
    const text = extractDocText(full.docType, full.body)
    if (!text.trim()) continue
    const hash = localAiContentHash(m.title, text)
    if (needsLocalAiPass(pass, m.id, hash)) out.push({ id: m.id, title: m.title, hash })
  }
  return out
}

async function localModelReady(): Promise<boolean> {
  const status = await localModelStatus()
  return !!status.available && !!status.chatModel
}

/** Enrich up to `limit` documents that have not been enriched at this content. */
export async function sweepDocumentEnrichment(limit = LOCAL_AI_BATCH): Promise<SweepResult> {
  if (!(await localModelReady())) return { processed: 0, failed: 0, remaining: 0, reason: 'no_local_model' }
  const queue = pending('enrich')
  let processed = 0
  let failed = 0
  for (const c of queue.slice(0, limit)) {
    const r = await enrichDocument(c.id)
    if (r.ok) {
      // Only a success is recorded. A failure stays pending so the next tick
      // retries it rather than marking a document enriched that is not.
      markLocalAiPass('enrich', c.id, c.hash)
      processed++
    } else if (r.reason === 'no_local_model') {
      return { processed, failed, remaining: queue.length - processed, reason: 'no_local_model' }
    } else if (r.reason === 'empty' || r.reason === 'not_found') {
      // Nothing to enrich and nothing that will change on a retry: record it so
      // the sweep stops re-reading it every tick.
      markLocalAiPass('enrich', c.id, c.hash)
    } else {
      failed++
    }
  }
  return { processed, failed, remaining: Math.max(0, queue.length - processed - failed) }
}

/** Extract durable memory from up to `limit` not-yet-scanned documents. */
export async function sweepDocumentMemory(limit = LOCAL_AI_BATCH): Promise<SweepResult & { added: number }> {
  if (!(await localModelReady())) {
    return { processed: 0, failed: 0, added: 0, remaining: 0, reason: 'no_local_model' }
  }
  const queue = pending('memory')
  let processed = 0
  let failed = 0
  let added = 0
  for (const c of queue.slice(0, limit)) {
    const full = getDocument(c.id)
    if (!full) continue
    const text = extractDocText(full.docType, full.body)
    const r = await extractMemoryFromText({ sourceRef: c.id, title: c.title, text })
    if (r.reason === 'no_local_model') {
      return { processed, failed, added, remaining: queue.length - processed, reason: 'no_local_model' }
    }
    // A document that yields no durable memory is still SCANNED - recording it
    // is what stops the sweep asking the model the same question forever.
    markLocalAiPass('memory', c.id, c.hash)
    processed++
    added += r.added
  }
  return { processed, failed, added, remaining: Math.max(0, queue.length - processed) }
}

/**
 * Backfill embeddings for anything that lacks one.
 *
 * Without a vector a source can only ever be matched by keyword, so a question
 * about churn cannot find a document about attrition — the whole reason semantic
 * ranking exists. Both reindexers skip what is already embedded, so this is
 * cheap to repeat and does nothing once the workspace is covered. With no
 * embedding model configured they report a reason and write nothing, which is
 * the honest outcome rather than a silent keyword-only downgrade.
 */
//
// Three pools: whole-document vectors (the fallback), knowledge entries, and
// document PASSAGES — the signal document ranking prefers (chunkEmbeddings.ts).
// Passages go last: they are the largest pool, and the chunk sweep that creates
// them runs at 12 s, well before the first embedding sweep. Every pool embeds
// through the Background AI tasks gate, so with the switch off only a local
// model is asked and, with none, nothing is sent and the reason comes back.
//
// Single-flight: the 5-minute tick and an on-demand kick (a key saved, the
// switch turned on) must not embed the same backlog twice in parallel. A call
// made while a sweep is running joins that sweep.
export interface EmbeddingSweepResult {
  documents: number
  knowledge: number
  passages: number
  pruned: number
  reason?: string
}

let embeddingSweep: Promise<EmbeddingSweepResult> | null = null

export function sweepEmbeddings(): Promise<EmbeddingSweepResult> {
  if (embeddingSweep) return embeddingSweep
  embeddingSweep = runEmbeddingSweep().finally(() => {
    embeddingSweep = null
  })
  return embeddingSweep
}

async function runEmbeddingSweep(): Promise<EmbeddingSweepResult> {
  const docs = await reindexDocuments(false)
  const knowledge = await reindexKnowledge(false)
  const passages = await reindexChunkEmbeddings('document', false)
  return {
    documents: docs.embedded,
    knowledge: knowledge.embedded,
    passages: passages.embedded,
    pruned: passages.pruned,
    reason: docs.reason ?? knowledge.reason ?? passages.reason
  }
}

/**
 * Start a sweep now without waiting for it — for the moments the corpus becomes
 * embeddable, or embeddable under a different model: an OpenAI key saved, or
 * Background AI tasks turned on. Rather than leave the person on keyword search
 * until the next 5-minute tick. Never throws; a failure leaves keyword search in
 * place exactly as before.
 */
export function kickEmbeddingSweep(): void {
  void sweepEmbeddings().catch((err) => console.error('[local-ai] embedding sweep failed:', err))
}
