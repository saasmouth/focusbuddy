// Find and replace over a list of text records: the cells of a sheet, the
// paragraphs, table cells and notes of a deck. Write searches one ProseMirror
// document (FindReplace + searchHighlight); the apps whose text lives in many
// small pieces share this instead, so "Find and replace…" (SPEC §9.2) matches,
// steps and replaces the same way in each. Matching is docFind's, the core Write
// uses, so case, whole-word and regex mean the same thing everywhere.

import { findMatches, type FindOptions } from './docFind'

export interface FindRecord {
  /** Stable address of the piece of text (the app decodes it to go there). */
  key: string
  text: string
}

export interface RecordHit {
  key: string
  start: number
  end: number
}

/** Every match, in record order then text order. */
export function findInRecords(records: FindRecord[], query: string, opts: FindOptions = {}): RecordHit[] {
  if (!query) return []
  const out: RecordHit[] = []
  for (const r of records) for (const m of findMatches(r.text, query, opts)) out.push({ key: r.key, start: m.start, end: m.end })
  return out
}

/** One record's text with the given ranges (non-overlapping, any order) replaced. */
export function spliceRanges(text: string, ranges: Array<{ start: number; end: number }>, replacement: string): string {
  let out = text
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + replacement + out.slice(r.end)
  return out
}

/**
 * The records that change when `hits` are replaced, as their new text. Pass all
 * hits for Replace all, or one for Replace. The replacement is literal, as in
 * Write (a regex's `$1` is not expanded).
 */
export function replaceHits(records: FindRecord[], hits: RecordHit[], replacement: string): FindRecord[] {
  const byKey = new Map<string, RecordHit[]>()
  for (const h of hits) byKey.set(h.key, [...(byKey.get(h.key) ?? []), h])
  const out: FindRecord[] = []
  for (const r of records) {
    const mine = byKey.get(r.key)
    if (mine) out.push({ key: r.key, text: spliceRanges(r.text, mine, replacement) })
  }
  return out
}

/**
 * Replace character ranges inside a paragraph split into formatted runs. The
 * replacement takes the formatting of the run the match starts in; characters a
 * match covers in later runs are removed from them, and runs left empty are
 * dropped (one is kept, so a paragraph is never left without a run).
 */
export function replaceInRuns<R extends { text: string }>(runs: R[], ranges: Array<{ start: number; end: number }>, replacement: string): R[] {
  let next = runs.map((r) => ({ ...r }))
  for (const { start, end } of [...ranges].sort((a, b) => b.start - a.start)) {
    let pos = 0
    let placed = false
    next = next.map((run) => {
      const a = pos
      const b = pos + run.text.length
      pos = b
      const from = Math.max(start, a)
      const to = Math.min(end, b)
      // An empty match at a run boundary belongs to the run it starts in.
      const touches = from < to || (start === end && start >= a && start <= b && !placed)
      if (!touches) return run
      const head = run.text.slice(0, from - a)
      const tail = run.text.slice(to - a)
      if (!placed && start >= a && start <= b) {
        placed = true
        return { ...run, text: head + replacement + tail }
      }
      return { ...run, text: head + tail }
    })
  }
  const kept = next.filter((r) => r.text.length > 0)
  return kept.length ? kept : next.slice(0, 1).map((r) => ({ ...r, text: '' }))
}
