import type { Contact } from './types'

// The people you are already working with, that the workspace can see.
//
// Typing somebody's details in is the part nobody does, so a contacts list
// built only that way stays empty and the desk lens never reaches people. But
// the workspace already knows who is involved: who emails you about this desk,
// who tasks are assigned to, who organised the meeting on the calendar, who is
// in the org.
//
// Every suggestion carries WHY it is being suggested, and that is not
// decoration. A proposed contact with no provenance is indistinguishable from
// one the app invented, and this list must never be mistaken for a list of
// people who exist -- it is a list of people who appeared in your own data.

export type SuggestionSource = 'mail' | 'task' | 'calendar' | 'org'

export interface ContactSuggestion {
  /** Stable within a run, for keys and de-duplication. */
  key: string
  name: string
  email: string | null
  source: SuggestionSource
  /** Said out loud in the UI: "emailed you 4 times", "assigned 2 tasks". */
  reason: string
  /** How strongly this is worth offering; drives ordering only. */
  weight: number
  /** Set when the suggestion came from an org member. */
  accountId?: string | null
}

export interface SuggestionInput {
  /** Senders seen in the mailbox. */
  mail?: ReadonlyArray<{ fromName: string; fromAddress: string }>
  /** Assignee strings from tasks on this desk (or the workspace). */
  assignees?: readonly string[]
  /** Organisers of subscribed calendar events. */
  organisers?: readonly string[]
  /** Org members, which the directory already knows. */
  orgMembers?: ReadonlyArray<{ accountId: string; name: string; email: string | null }>
  /** Contacts that already exist, so they are never suggested again. */
  existing?: readonly Contact[]
  /** Addresses that are the user's own, so they are not suggested to themselves. */
  self?: readonly string[]
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()

/**
 * Addresses no human reads.
 *
 * Suggesting "noreply@" as a contact is the fastest way to make the whole
 * feature feel careless, and these patterns are how such senders actually
 * announce themselves.
 */
const NOT_A_PERSON =
  /(^|[.@_-])(no-?reply|do-?not-?reply|notifications?|alerts?|mailer|bounce|postmaster|support|billing|receipts?|invoice|news(letter)?|updates?|info|admin|automated|system|digest)([.@_-]|$)/i

// The same words, bounded for prose rather than for an address. An address
// separates parts with . @ _ -; a display name separates them with spaces, so
// one pattern cannot serve both -- "Acme Notifications" slips straight through
// the address rule.
const NOT_A_PERSON_NAME =
  /\b(no-?reply|do-?not-?reply|notifications?|alerts?|mailer|bounce|postmaster|billing|receipts?|invoices?|news(letter)?|updates?|automated|system|digest|team|bot)\b/i

export function looksLikeAPerson(address: string, displayName?: string): boolean {
  const a = norm(address)
  if (!a || !a.includes('@')) return false
  if (NOT_A_PERSON.test(a)) return false
  if (displayName && NOT_A_PERSON_NAME.test(displayName)) return false
  return true
}

/** A readable name from an address when the sender gave none. */
export function nameFromAddress(address: string): string {
  const local = address.split('@')[0] ?? address
  return (
    local
      .replace(/[._-]+/g, ' ')
      .replace(/\d+/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase() + w.slice(1))
      .join(' ') || address
  )
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`)

/**
 * Rank the people worth offering.
 *
 * Nothing already in contacts is offered, and nothing that is the user
 * themselves. Ordering is by how much evidence there is, not alphabetical:
 * the person who emailed you six times about this desk should be the first
 * one you are asked about.
 */
export function suggestContacts(input: SuggestionInput, limit = 8): ContactSuggestion[] {
  const known = new Set<string>()
  for (const c of input.existing ?? []) {
    if (c.email) known.add(norm(c.email))
    if (c.accountId) known.add(`acct:${c.accountId}`)
    known.add(`name:${norm(c.name)}`)
  }
  for (const s of input.self ?? []) known.add(norm(s))

  const byKey = new Map<string, ContactSuggestion>()
  const bump = (s: ContactSuggestion): void => {
    const found = byKey.get(s.key)
    if (!found) {
      byKey.set(s.key, s)
      return
    }
    // Seen from two sources: keep the stronger reason and add the weights, so
    // somebody who both emails you AND owns a task outranks either alone.
    found.weight += s.weight
    if (s.weight > 0 && !found.email && s.email) found.email = s.email
  }

  // Mail: counted, because frequency IS the signal.
  const counts = new Map<string, { name: string; address: string; n: number }>()
  for (const m of input.mail ?? []) {
    const addr = norm(m.fromAddress)
    if (!addr || known.has(addr)) continue
    if (!looksLikeAPerson(m.fromAddress, m.fromName)) continue
    const e = counts.get(addr)
    if (e) e.n++
    else counts.set(addr, { name: m.fromName || nameFromAddress(m.fromAddress), address: m.fromAddress, n: 1 })
  }
  for (const c of counts.values()) {
    bump({
      key: norm(c.address),
      name: c.name,
      email: c.address,
      source: 'mail',
      reason: `emailed you ${plural(c.n, 'once', 'times')}`,
      weight: 10 + Math.min(20, c.n * 2)
    })
  }

  // Tasks: an assignee is a name somebody typed, so it is a person by
  // construction -- but it has no address, and inventing one would be a lie.
  const taskCounts = new Map<string, number>()
  for (const a of input.assignees ?? []) {
    const n = (a ?? '').trim()
    if (!n || known.has(`name:${norm(n)}`)) continue
    taskCounts.set(n, (taskCounts.get(n) ?? 0) + 1)
  }
  for (const [name, n] of taskCounts) {
    bump({
      key: `name:${norm(name)}`,
      name,
      email: null,
      source: 'task',
      reason: `assigned ${plural(n, '1 task', 'tasks')} here`,
      weight: 14 + Math.min(10, n * 2)
    })
  }

  for (const o of input.organisers ?? []) {
    const addr = norm(o)
    if (!addr || known.has(addr) || !looksLikeAPerson(o)) continue
    bump({
      key: addr,
      name: nameFromAddress(o),
      email: o,
      source: 'calendar',
      reason: 'organised a meeting',
      weight: 12
    })
  }

  for (const m of input.orgMembers ?? []) {
    if (known.has(`acct:${m.accountId}`)) continue
    if (m.email && known.has(norm(m.email))) continue
    bump({
      key: `acct:${m.accountId}`,
      name: m.name,
      email: m.email,
      source: 'org',
      reason: 'in your organisation',
      weight: 8,
      accountId: m.accountId
    })
  }

  return [...byKey.values()]
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, limit)
}
