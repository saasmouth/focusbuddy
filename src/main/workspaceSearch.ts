// Grounded retrieval over the workspace — the substrate for "ask your workspace".
// PlexiBrain knowledge is ranked by meaning (semantic embeddings blended with
// keyword) when an embedding key is configured, and documents are keyword-ranked.
// With no key everything degrades to keyword, so grounding never fabricates a
// match. The pure ranking lives in workspaceRank.ts; the semantic side in
// semanticRetrieval.ts. Both are unit-testable without the database.

import { listDocuments, getDocument } from './db/documents'
import {
  extractDocText,
  rankSources,
  relevanceGate,
  selectPassages,
  snippetFor,
  type WorkspaceSource
} from './workspaceRank'
import { semanticSearchKnowledge } from './semanticRetrieval'
import { semanticSearchDocuments } from './documentRetrieval'
import {
  chunkIndexActive,
  chunkSearchDocuments,
  chunkSearchWidgets,
  chunkSearchFiles,
  chunkSearchChats
} from './chunkIndex'
import { collectExtraSources } from './workspaceExtras'
import { meetingRecallSources } from './segmentRecall'

export type { WorkspaceSource } from './workspaceRank'
export { extractDocText } from './workspaceRank'

// How many sources ground an answer (M1 defect #4).
//
// The arithmetic is what matters, and it kept being underestimated. Slots are
// filled round-robin across SEVEN pools — knowledge, documents, tasks/tables/
// notes, widgets, files, chats, meetings — so the number of ROUNDS is what
// decides how many documents can be read, not the total. At 6 slots each pool got
// one round: at most 2 documents, whatever matched. At 10 it was still only one
// full round plus three stragglers, so "why did it only look at two of my files?"
// remained the honest answer.
//
// 28 is four clean rounds of seven. Four documents, four notes, four widgets, four
// meetings, and so on — enough that a question spanning a handful of files is
// actually grounded in all of them.
//
// Thoroughness is bounded by a CHARACTER BUDGET rather than by starving the slot
// count: see RETRIEVAL_TOTAL_CHAR_BUDGET in grounding.ts. A count is the wrong
// lever — twenty short notes cost less than two long contracts, and capping the
// count punishes the cheap case to protect against the expensive one.
export const RETRIEVAL_SOURCE_LIMIT = 28

export async function retrieveSources(
  query: string,
  limit = RETRIEVAL_SOURCE_LIMIT,
  scopeNodeIds?: string[],
  opts?: { excludeChatId?: string }
): Promise<WorkspaceSource[]> {
  // Knowledge: curated company truth, ranked semantically (or keyword fallback)
  // and surfaced first so it grounds the answer ahead of looser document matches.
  const kEntries = await semanticSearchKnowledge(query, limit)
  const kSources: WorkspaceSource[] = kEntries
    .map((e, i) => {
      const text = `${e.title}\n${e.tags.join(' ')}\n${e.body}`
      return {
        docId: e.id,
        title: e.title,
        docType: 'knowledge',
        // Defect #29: knowledge used to ship its head slice with a blind
        // 200-char snippet. It now gets the same passage treatment as every
        // other pool — the snippet anchors on the earliest content-term hit,
        // and the grounding text is the passage(s) that actually match, so a
        // long entry answers from the paragraph that answers, not its opening.
        snippet: snippetFor(text, query),
        text: selectPassages(query, text),
        // An explicit rank ordinal, not a relevance claim: it only preserves
        // the blend's ordering so curated knowledge leads the source list.
        score: 1 - i * 0.01
      }
    })
    .filter((k) => k.text.trim().length > 0)

  // Documents ride the chunk index (A2, R10): passage-level BM25 over
  // fb_chunks_fts, so a question matches the paragraph that answers it
  // rather than a substring of a document's opening (defect #2). A fresh
  // profile before its first sweep falls back to the legacy whole-document
  // path — the same results as before, never fewer.
  const docSources = chunkIndexActive()
    ? chunkSearchDocuments(query, limit)
    : await semanticSearchDocuments(query, limit)

  // Extras: tasks, tables and canvas notes — the rest of the environment, so the
  // brain is grounded in more than documents. Keyword-ranked.
  const extraSources = collectExtraSources(query, limit, scopeNodeIds)

  // Widgets (#16): the content-bearing canvas kinds the extras pool never
  // read — living docs, cards, custom blocks, fields, agents, mindmaps,
  // diagrams, charts — passage-searched through the chunk index. Desk scope
  // demotes off-scope widgets rather than excluding them (#12).
  const widgetSources = chunkSearchWidgets(query, limit, scopeNodeIds)

  // Files (#17): Drive files with extractable text, passage-searched. Before
  // this pool a file was @-mentionable but never FOUND.
  const fileSources = chunkSearchFiles(query, limit)

  // Chat history (#17): past Plexii conversations, minus the one being
  // answered right now — the recall mechanism #18 asked for.
  const chatSources = chunkSearchChats(query, limit, opts?.excludeChatId)

  // Meetings (M4, SPEC-003 P4): the transcript corpus, segment-searched so
  // every grounded line arrives WITH its speaker and timestamp — the model
  // cites who said it and when, not a paraphrase of a bare string.
  const meetingSources = meetingRecallSources(query, limit)

  // Interleave the pools round-robin so documents, tasks/tables/notes, widgets
  // and knowledge all get a fair shot at the limited source slots. Curated
  // knowledge still leads each round. Each pool passes the relevance gate
  // first: a weak single-term coincidence must not ride into the trace looking
  // analysed (Caleb's drive: an SDR question dragged in every doc containing
  // "research"). An emptied pool is an honest result — the trace says
  // "nothing relevant" and web results lead.
  const pools = [kSources, docSources, extraSources, widgetSources, fileSources, chatSources, meetingSources].map(
    (p) => relevanceGate(query, p)
  )
  const merged: WorkspaceSource[] = []
  const seen = new Set<string>()
  for (let i = 0; merged.length < limit && pools.some((p) => p[i]); i++) {
    for (const pool of pools) {
      const s = pool[i]
      if (s && !seen.has(s.docId) && merged.length < limit) {
        seen.add(s.docId)
        merged.push(s)
      }
    }
  }
  return merged
}

// The workspace connecting itself: the documents most related to this one, by
// content overlap. The document's own title + lead text is the query, ranked
// against every other document. No graph to build, no AI call — it just surfaces.
export function relatedDocuments(docId: string, limit = 5): WorkspaceSource[] {
  const self = getDocument(docId)
  if (!self) return []
  const selfMeta = listDocuments().find((m) => m.id === docId)
  const selfText = extractDocText(self.docType, self.body)
  // Title plus the opening of the body carries the document's topic without
  // letting a very long doc dilute the term set.
  const query = `${selfMeta?.title ?? ''} ${selfText}`.slice(0, 2000)
  const docs = listDocuments()
    .filter((m) => m.id !== docId)
    .map((m) => {
      const full = getDocument(m.id)
      if (!full) return null
      return { docId: m.id, title: m.title, docType: m.docType as string, text: extractDocText(m.docType, full.body) }
    })
    .filter((d): d is { docId: string; title: string; docType: string; text: string } => d !== null && d.text.length > 0)
  return rankSources(query, docs, limit)
}
