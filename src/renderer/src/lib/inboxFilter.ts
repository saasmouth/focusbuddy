// Which of my emails are about THIS desk?
//
// The filter is deliberately made of the fields a mailbox actually gives us --
// sender, subject, read state, flag, attachments, date -- and nothing else. It
// would be easy to offer "emails about this project" as a single magic switch,
// and it would be a lie: nothing in a message says which desk it is about, so
// anything beyond matching on what the headers say would be a guess dressed as
// a filter.
//
// A mail FOLDER may be declared to be about a desk (MailFolder.nodeId), but
// that is the user asserting the link, not this module inferring one -- and the
// folder still decides membership with exactly these rules.
//
// Terms are OR within a field and AND across fields, which is how people
// actually describe this: "from Sarah or David, about Ridge St, unread". One
// matching sender is enough; a matching sender AND a matching subject is
// required when both are set.

import type { MailListItem, InboxRules } from '@shared/types'

// The rule shape lives in shared/types.ts, because a mail folder is made of
// one and folders are persisted by the main process. Re-exported here so every
// existing import of it keeps working.
export type { InboxRules }

const norm = (s: string): string => s.toLowerCase().trim()

/** Terms with the empty ones dropped, so a half-typed rule filters nothing. */
export function activeTerms(terms: readonly string[] | undefined): string[] {
  return (terms ?? []).map(norm).filter((t) => t.length > 0)
}

/** Does this message satisfy every rule that has been set? */
export function matches(msg: MailListItem, rules: InboxRules, now = Date.now()): boolean {
  const from = activeTerms(rules.from)
  if (from.length > 0) {
    const haystack = `${norm(msg.fromName ?? '')} ${norm(msg.fromAddress ?? '')}`
    if (!from.some((t) => haystack.includes(t))) return false
  }

  const subject = activeTerms(rules.subject)
  if (subject.length > 0) {
    const s = norm(msg.subject ?? '')
    if (!subject.some((t) => s.includes(t))) return false
  }

  if (rules.unreadOnly && msg.seen) return false
  if (rules.flaggedOnly && !msg.flagged) return false
  if (rules.withAttachments && !msg.hasAttachments) return false

  if (rules.sinceDays != null && rules.sinceDays > 0) {
    // A message with no date cannot be shown to be inside the window, and
    // quietly keeping it would overstate the match.
    if (!msg.date) return false
    if (now - msg.date > rules.sinceDays * 86_400_000) return false
  }

  return true
}

/** The matching messages, newest first. */
export function applyRules(
  messages: readonly MailListItem[],
  rules: InboxRules,
  now = Date.now()
): MailListItem[] {
  return messages.filter((m) => matches(m, rules, now)).sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
}

/** True when no rule would exclude anything — i.e. this is the whole inbox. */
export function rulesAreEmpty(rules: InboxRules): boolean {
  return (
    activeTerms(rules.from).length === 0 &&
    activeTerms(rules.subject).length === 0 &&
    !rules.unreadOnly &&
    !rules.flaggedOnly &&
    !rules.withAttachments &&
    (rules.sinceDays == null || rules.sinceDays <= 0)
  )
}

/**
 * A readable sentence for what is being shown.
 *
 * The widget is a filtered view of somebody's mail, and a filtered view that
 * does not say what it filtered on is one you cannot trust: an empty result
 * looks identical to a broken rule.
 */
export function describeRules(rules: InboxRules): string {
  if (rulesAreEmpty(rules)) return 'Everything in the inbox'
  const parts: string[] = []
  const from = activeTerms(rules.from)
  const subject = activeTerms(rules.subject)
  if (from.length) parts.push(`from ${from.join(' or ')}`)
  if (subject.length) parts.push(`about ${subject.join(' or ')}`)
  if (rules.unreadOnly) parts.push('unread')
  if (rules.flaggedOnly) parts.push('flagged')
  if (rules.withAttachments) parts.push('with attachments')
  if (rules.sinceDays) parts.push(`in the last ${rules.sinceDays} days`)
  return parts.join(' · ')
}

/**
 * Sensible opening rules for a desk.
 *
 * The desk's title is the one thing we genuinely know relates to it, so it
 * seeds the subject rule. Words too short or too common to narrow anything are
 * dropped -- "the", "and", a bare number -- because a rule that matches
 * everything is worse than no rule: it looks like it is working.
 */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'desk', 'campaign',
  'project', 'plan', 'notes', 'new', 'a', 'an', 'of', 'to', 'in', 'on'
])

export function seedRulesFromDeskTitle(title: string): InboxRules {
  const words = (title ?? '')
    .split(/[^A-Za-z0-9']+/)
    .map(norm)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
  // One strong term beats three weak ones: the longest word in a desk title is
  // usually the name that would appear in a subject line.
  const best = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 2)
  return { from: [], subject: best, sinceDays: 30 }
}
