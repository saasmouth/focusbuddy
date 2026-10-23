// Pure @mention parsing shared by the chat renderer (highlighting) and the
// messaging store (mention-aware notifications). Lives in a .ts module so
// non-JSX callers (stores, unit tests) never import a .tsx file.

export const MENTION_RE = /@([a-z0-9._-]{2,32})/gi

export function bodyMentionsHandle(body: string, handle: string | null | undefined): boolean {
  if (!handle) return false
  const lower = handle.toLowerCase()
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m[1].toLowerCase() === lower) return true
  }
  return false
}

// ── @mention autocomplete helpers ────────────────────────────────────────────
// Shared by any inline composer that offers member handles as the user types
// "@prefix". Pure so composers (chat, comments) and unit tests all agree.

export interface MentionQuery {
  // The text typed after the "@" so far (may be empty right after "@").
  query: string
}

// If the text ends in an in-progress mention ("@" at a word boundary followed by
// zero or more handle characters), return the partial query; else null.
export function matchMentionQuery(text: string): MentionQuery | null {
  const m = /(^|\s)@([a-z0-9._-]*)$/i.exec(text)
  if (!m) return null
  return { query: m[2] }
}

// Replace the in-progress "@prefix" at the end of the text with the chosen handle
// plus a trailing space. Returns the text unchanged when there is no mention in
// progress, so callers can apply it unconditionally.
export function applyMention(text: string, handle: string): string {
  const q = matchMentionQuery(text)
  if (!q) return text
  const upto = text.slice(0, text.length - q.query.length)
  return `${upto}${handle} `
}

// True when a comment authored by someone else names my handle — the trigger for
// a cross-user mention notification. My own comments never notify me, and a body
// that mentions nobody (or an unknown handle) does not either.
export function isCrossUserMention(
  body: string,
  authorAccountId: string | null | undefined,
  myAccountId: string | null | undefined,
  myHandle: string | null | undefined
): boolean {
  if (!myAccountId || authorAccountId === myAccountId) return false
  return bodyMentionsHandle(body, myHandle)
}

// A token that can BE a mention: what MENTION_RE will match, so an inserted
// "@x" resolves instead of sitting there as prose.
export function isHandleShaped(h: string | null | undefined): h is string {
  return !!h && /^[a-z0-9._-]{2,32}$/i.test(h.trim())
}

// Who a comment composer on a LOCAL document may offer after "@".
//
// A mention resolves against a HANDLE — MENTION_RE matches handle-shaped
// tokens, and bodyMentionsHandle compares one to the recipient's handle — so
// the pool is handles, never display names.
//
// THAT DISTINCTION USED TO COST NOTHING, which is how it came to be got wrong.
// An account with no name displays AS its handle (personName.ts falls through
// to it), so the display name and the handle were the same string and a pool
// built from either worked. From 4.3.41 an account must carry a first and last
// name, so the display name is "Dana Reed": not handle-shaped, dropped by the
// filter, and the pool came out EMPTY — no autocomplete at all, for anybody
// with a name, which from 4.3.41 is everybody.
//
// Existing comments' author strings are still read, because on a document
// commented on BEFORE names those strings are handles. Nothing is invented: a
// pool with no real handle in it stays empty, and the composer then sends an
// unknown @word as plain text, which is what it does for a stranger anyway.
export function commentMentionHandles(
  myHandle: string | null | undefined,
  authors: ReadonlyArray<string | null | undefined> = []
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // Mine first: on a local document it is the only handle that is certainly a
  // real one, so it should head the list the composer shows.
  for (const h of [myHandle, ...authors]) {
    if (!isHandleShaped(h)) continue
    const t = h.trim()
    const l = t.toLowerCase()
    if (seen.has(l)) continue
    seen.add(l)
    out.push(t)
  }
  return out
}

// The candidate handles for a partial query: those that start with it, deduped
// case-insensitively, capped. Nothing is invented; an empty pool yields nothing.
export function filterMentionCandidates(handles: string[], query: string, limit = 6): string[] {
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of handles) {
    const l = h.toLowerCase()
    if (seen.has(l) || !l.startsWith(q)) continue
    seen.add(l)
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}
