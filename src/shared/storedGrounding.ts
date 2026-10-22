import type { AnswerGrounding } from './types'

// The grounding check's findings, as stored with a chat turn and read back.
//
// A reopened conversation shows the "check this" marks the answer had when it
// was given: these findings, saved with the message, never recomputed. A fresh
// check on reopen would run against today's sources, and marks for a different
// answer than the one on screen would be fakery. Anything that is not a valid
// finding reads as none: a turn saved before marks were stored (no column
// value), a damaged value, or one with nothing found. Never invented.

const CONFIDENCE = new Set(['high', 'medium', 'low'])

function spans(v: unknown): AnswerGrounding['flagged'] | null {
  if (!Array.isArray(v)) return null
  const out: AnswerGrounding['flagged'] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') return null
    const { span, kind, confidence, reason } = x as Record<string, unknown>
    if (typeof span !== 'string' || !span || typeof kind !== 'string' || typeof reason !== 'string') return null
    if (typeof confidence !== 'string' || !CONFIDENCE.has(confidence)) return null
    out.push({ span, kind, confidence: confidence as 'high' | 'medium' | 'low', reason })
  }
  return out
}

/** A valid AnswerGrounding with at least one finding, or null. */
export function normalizeStoredGrounding(v: unknown): AnswerGrounding | null {
  if (!v || typeof v !== 'object') return null
  const g = v as Record<string, unknown>
  if (g.path !== 'local' && g.path !== 'cloud') return null
  const repaired = spans(g.repaired ?? [])
  const flagged = spans(g.flagged ?? [])
  if (!repaired || !flagged) return null
  if (!repaired.length && !flagged.length) return null
  return { path: g.path, repaired, flagged }
}
