// Memory extraction: distil durable facts, preferences and commitments from the
// user's own content using the LOCAL model (free, private), and store them so the
// assistant stops starting cold. Mirrors the document-enrichment pattern. Honest:
// no local model → nothing written; the model invents nothing (grounded prompt).

import { listDocuments, getDocument } from '../db/documents'
import { extractDocText } from '../workspaceRank'
import { localChat, localModelStatus } from './localModel'
import { addMemory } from '../db/memory'
import { MEMORY_SYSTEM, buildMemoryPrompt, parseMemoryResponse } from './memoryExtract'

// Extract memory from one piece of text (a document, chat, or meeting) and store
// what it finds. Returns how many memories were added/refreshed, or why it couldn't.
export async function extractMemoryFromText(input: {
  sourceRef: string
  title: string
  text: string
}): Promise<{ ok: boolean; added: number; reason?: 'empty' | 'no_local_model' }> {
  if (!input.text.trim()) return { ok: false, added: 0, reason: 'empty' }
  const raw = await localChat({
    system: MEMORY_SYSTEM,
    prompt: buildMemoryPrompt(input.title, input.text),
    json: true,
    purpose: 'memory_extract'
  })
  if (!raw) return { ok: false, added: 0, reason: 'no_local_model' }
  const drafts = parseMemoryResponse(raw)
  let added = 0
  for (const d of drafts) {
    const stored = addMemory({
      kind: d.kind,
      text: d.text,
      subject: d.subject,
      due: d.due,
      source: 'extracted',
      sourceRef: input.sourceRef,
      confidence: 0.8
    })
    if (stored) added++
  }
  return { ok: true, added }
}

// Backfill memory across the document pool. Bails honestly when no local model is
// available. Deduping in the store means re-running is safe (it just refreshes).
export async function extractMemoryFromDocuments(
  limit = 50
): Promise<{ scanned: number; added: number; reason?: 'no_local_model' }> {
  const status = await localModelStatus()
  if (!status.available || !status.chatModel) return { scanned: 0, added: 0, reason: 'no_local_model' }
  let scanned = 0
  let added = 0
  for (const m of listDocuments().slice(0, limit)) {
    const full = getDocument(m.id)
    if (!full) continue
    const text = extractDocText(full.docType, full.body)
    if (text.trim().length === 0) continue
    const r = await extractMemoryFromText({ sourceRef: m.id, title: m.title, text })
    scanned++
    added += r.added
  }
  return { scanned, added }
}
