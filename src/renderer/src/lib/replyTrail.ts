import type { MailListItem } from '@shared/types'

// Which earlier messages belong to the same conversation as this one.
//
// Threading by RFC 5322 headers where they exist, and by normalised subject
// where they do not -- plenty of servers and senders drop References entirely,
// and a reply drafted without the trail is the thing people notice first: it
// re-asks a question that was settled three messages ago.

/** Strip the reply/forward prefixes so a subject can be compared. */
export function normaliseSubject(subject: string): string {
  let s = (subject ?? '').trim()
  let changed = true
  while (changed) {
    const next = s.replace(/^(re|fw|fwd|aw|sv|vs)\s*(\[\d+\])?\s*:\s*/i, '')
    changed = next !== s
    s = next
  }
  return s.trim().toLowerCase()
}

/**
 * The messages preceding `target` in its conversation, oldest first.
 *
 * Returns only messages STRICTLY older than the target: a draft is a reply to
 * what came before it, and feeding the model later messages would have it
 * answer things that have already been answered.
 */
export function trailFor(
  target: Pick<MailListItem, 'uid' | 'subject' | 'date' | 'messageId' | 'inReplyTo' | 'references'>,
  all: readonly MailListItem[],
  limit = 8
): MailListItem[] {
  const ids = new Set<string>()
  if (target.messageId) ids.add(target.messageId)
  if (target.inReplyTo) ids.add(target.inReplyTo)
  for (const r of splitRefs(target.references)) ids.add(r)

  // Walk the chain: anything referencing a known id joins the set, which pulls
  // in siblings of a branched thread as well as direct ancestors.
  const inThread = new Map<number, MailListItem>()
  let grew = true
  while (grew) {
    grew = false
    for (const m of all) {
      if (inThread.has(m.uid)) continue
      const mine = [m.messageId, m.inReplyTo, ...splitRefs(m.references)].filter(
        (x): x is string => Boolean(x)
      )
      if (mine.some((x) => ids.has(x))) {
        inThread.set(m.uid, m)
        for (const x of mine) ids.add(x)
        grew = true
      }
    }
  }

  // Subject fallback for messages that carry no usable headers at all.
  const subject = normaliseSubject(target.subject)
  if (subject) {
    for (const m of all) {
      if (inThread.has(m.uid)) continue
      if (m.messageId || m.inReplyTo || m.references) continue
      if (normaliseSubject(m.subject) === subject) inThread.set(m.uid, m)
    }
  }

  return [...inThread.values()]
    .filter((m) => m.uid !== target.uid && (m.date ?? 0) < (target.date ?? 0))
    .sort((a, b) => (a.date ?? 0) - (b.date ?? 0))
    .slice(-limit)
}

function splitRefs(refs: string | string[] | null | undefined): string[] {
  if (!refs) return []
  if (Array.isArray(refs)) return refs.filter(Boolean)
  return refs.split(/\s+/).filter(Boolean)
}
