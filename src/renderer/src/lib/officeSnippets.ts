// The office apps' half of "any snippet into any destination": one insert path
// every office target (Write, Cells, Deck, Design, Diagrams, Draw) runs.
//
//   same kind   → the target's own duplicate insert, exactly as before;
//   other kind  → convertSnippetBody(body, primaryKindFor(host), deps), then the
//                 SAME duplicate insert with the converted body (it re-mints
//                 every id there), then one plain line saying it was converted
//                 (conversionNotice), which the snippets store shows;
//   refused     → { ok: false, reason } with the builder's reason, verbatim.
//
// What a target OFFERS comes from acceptsFor(host), which is computed by
// running the builders, so the library's kind filter shows exactly the kinds a
// conversion into the host supports and can never drift from it.
//
// A conversion is one way: nothing is ever written back through it. A
// converted duplicate is plain content in the destination; the master is
// untouched.

import { acceptsFor } from '@shared/snippetConvert/accepts'
import { conversionNotice, convertSnippetBody } from '@shared/snippetConvert'
import { primaryKindFor, type Snippet, type SnippetBody, type SnippetHostKind, type SnippetInsertResult, type SnippetKind, type SnippetLink } from '@shared/snippets'
import { snippetConvertDeps } from './snippetConvertDeps'

const acceptsCache = new Map<SnippetHostKind, SnippetKind[]>()

/**
 * The kinds an office host takes, from the builders with the renderer's real
 * deps. The same array every call (computed once per host), so it can be
 * passed straight to <SnippetLibrary kinds> without refreshing it each render.
 */
export function officeAccepts(host: SnippetHostKind): SnippetKind[] {
  let k = acceptsCache.get(host)
  if (!k) {
    k = acceptsFor(host, snippetConvertDeps())
    acceptsCache.set(host, k)
  }
  return k
}

/** A body ready for the host's own insert: the snippet's own, or its conversion, with the line to show. */
export type PreparedBody = { ok: true; body: SnippetBody; notice: string | null } | { ok: false; reason: string }

/** The body to insert into `host`: the snippet's own when it is native there, else its conversion. */
export function prepareSnippetBody(body: SnippetBody, host: SnippetHostKind): PreparedBody {
  const to = primaryKindFor(host)
  if (body.kind === to) return { ok: true, body, notice: null }
  const out = convertSnippetBody(body, to, snippetConvertDeps())
  if (!out.ok) return { ok: false, reason: out.reason }
  return { ok: true, body: out.body, notice: conversionNotice(body.kind, to, out.lossy) }
}

/**
 * Insert a snippet into an office host through its own duplicate insert.
 *
 * `insertNative` is the target's existing insert for a body of the host's own
 * kind (a snippet with that body, so names in status lines still read right).
 * It is called unchanged for a native snippet, so a same-kind insert behaves
 * exactly as it did before conversion existed.
 */
export function insertIntoOffice(
  snippet: Snippet,
  link: SnippetLink,
  host: SnippetHostKind,
  insertNative: (s: Snippet, link: SnippetLink) => SnippetInsertResult | Promise<SnippetInsertResult>
): SnippetInsertResult | Promise<SnippetInsertResult> {
  // Native: the target's own insert, called and returned untouched (sync stays sync).
  if (snippet.body.kind === primaryKindFor(host)) return insertNative(snippet, link)
  // A converted kind is a duplicate here: a host that renders live converted
  // instances handles 'live' before calling this.
  if (link !== 'duplicate') return { ok: false, reason: 'This kind of snippet can only be inserted here as a copy.' }
  const prepared = prepareSnippetBody(snippet.body, host)
  if (!prepared.ok) return { ok: false, reason: prepared.reason }
  const converted: Snippet = { ...snippet, kind: prepared.body.kind, body: prepared.body }
  const finish = (out: SnippetInsertResult): SnippetInsertResult => (out === true ? { ok: true, notice: prepared.notice } : out)
  const out = insertNative(converted, 'duplicate')
  return out instanceof Promise ? out.then(finish) : finish(out)
}
