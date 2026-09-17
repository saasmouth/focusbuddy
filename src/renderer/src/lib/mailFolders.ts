// Sorting a busy inbox into folders that fill themselves.
//
// The whole design rests on one observation: hand-filing is the work that stops
// happening exactly when somebody needs it most. So a folder here is a saved
// rule, and the only manual acts are the two corrections that make a rule
// trustworthy -- pin a message the rule missed, exclude one it should not have
// caught.
//
// Everything in this module is pure. Given the messages in hand and the user's
// folders it answers three questions: what is in each folder, what is in NO
// folder, and (from the mailbox itself, not from a model) which folders would
// be worth making. No network, no store, no clock beyond the one passed in.

import type { MailFolder, MailListItem } from '@shared/types'
import { matches, rulesAreEmpty } from './inboxFilter'

/**
 * Does this message belong in this folder?
 *
 * Order matters and is not arbitrary: an explicit exclusion beats everything,
 * because it is the user overruling the rule and there must be no way for a
 * rule to win that argument. A pin beats the rule for the same reason. Only
 * then do the rules speak.
 */
export function inFolder(msg: MailListItem, folder: MailFolder, now = Date.now()): boolean {
  if (folder.excluded.includes(msg.uid)) return false
  if (folder.pinned.includes(msg.uid)) return true
  // A folder with no rules is a manual folder: it holds exactly what was pinned
  // into it and nothing else. The alternative -- empty rules matching
  // everything -- would make a half-made folder swallow the entire inbox.
  if (rulesAreEmpty(folder.rules)) return false
  return matches(msg, folder.rules, now)
}

/** Messages in each folder, keyed by folder id, in the order they were given. */
export function assignToFolders(
  messages: readonly MailListItem[],
  folders: readonly MailFolder[],
  now = Date.now()
): Map<string, MailListItem[]> {
  const out = new Map<string, MailListItem[]>()
  for (const f of folders) out.set(f.id, [])
  for (const msg of messages) {
    for (const f of folders) {
      // Deliberately not `break`: a message can be in two folders at once. An
      // invoice about the Ridge St deal belongs in both, and forcing a single
      // home is the thing that makes people distrust filing.
      if (inFolder(msg, f, now)) out.get(f.id)!.push(msg)
    }
  }
  return out
}

/**
 * Messages that landed in no folder at all.
 *
 * This is the number the whole feature is for. A busy inbox is overwhelming
 * because its size is unaccounted for; once folders cover the known traffic,
 * what remains is the genuinely unsorted pile, and it is both smaller and
 * honest. It goes DOWN as folders are made, which is the only feedback that
 * makes setting them up feel worth it.
 */
export function uncategorised(
  messages: readonly MailListItem[],
  folders: readonly MailFolder[],
  now = Date.now()
): MailListItem[] {
  return messages.filter((m) => !folders.some((f) => inFolder(m, f, now)))
}

export interface FolderCount {
  total: number
  unread: number
}

/** How many messages, and how many unread, sit in each folder. */
export function folderCounts(
  messages: readonly MailListItem[],
  folders: readonly MailFolder[],
  now = Date.now()
): Map<string, FolderCount> {
  const assigned = assignToFolders(messages, folders, now)
  const out = new Map<string, FolderCount>()
  for (const f of folders) {
    const list = assigned.get(f.id) ?? []
    out.set(f.id, { total: list.length, unread: list.filter((m) => !m.seen).length })
  }
  return out
}

// ── Suggestions ──────────────────────────────────────────────────────────────

export interface FolderSuggestion {
  /** The rule this would become, ready to save. */
  name: string
  from?: string[]
  subject?: string[]
  /** How many of the messages in hand it would file. */
  count: number
  /** Why it is being offered, in the user's terms. */
  reason: string
}

// Senders nobody wants a folder for. A no-reply address is a sender you never
// correspond with, so a folder named after one is a folder about nothing.
const NOT_WORTH_A_FOLDER = /^(no-?reply|do-?not-?reply|bounce|mailer-daemon|postmaster|notifications?)@/i

/** The domain of an address, or '' when it does not look like one. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at > 0 ? address.slice(at + 1).toLowerCase() : ''
}

// A shared mail host tells you nothing about who somebody is: a folder for
// "gmail.com" would sweep up half the mailbox and mean nothing.
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com'
])

/**
 * Folders worth making, read off the actual mailbox.
 *
 * Derived from real messages and nothing else: no model, no invented
 * categories, no sample data. A suggestion that files fewer than `minCount`
 * messages is not offered, because the point is to shrink the unsorted pile and
 * a folder holding two things does not.
 *
 * Only messages not already covered by an existing folder are considered --
 * suggesting a folder for mail that is already filed would be noise.
 */
export function suggestFolders(
  messages: readonly MailListItem[],
  existing: readonly MailFolder[] = [],
  opts: { minCount?: number; limit?: number; now?: number } = {}
): FolderSuggestion[] {
  const minCount = opts.minCount ?? 3
  const limit = opts.limit ?? 6
  const pool = uncategorised(messages, existing, opts.now ?? Date.now())

  // ── By organisation ────────────────────────────────────────────────────────
  // A work domain is the strongest real signal in a mailbox: everybody at the
  // client, the agency, the bank, in one place, without naming them one by one.
  const byDomain = new Map<string, { count: number; unread: number; label: string }>()
  for (const m of pool) {
    const addr = (m.fromAddress ?? '').toLowerCase()
    if (!addr || NOT_WORTH_A_FOLDER.test(addr)) continue
    const d = domainOf(addr)
    if (!d || PUBLIC_DOMAINS.has(d)) continue
    const cur = byDomain.get(d) ?? { count: 0, unread: 0, label: d.split('.')[0] }
    cur.count += 1
    if (!m.seen) cur.unread += 1
    byDomain.set(d, cur)
  }

  // ── By person ──────────────────────────────────────────────────────────────
  // For the people on shared mail hosts, where the domain says nothing.
  const byPerson = new Map<string, { count: number; name: string }>()
  for (const m of pool) {
    const addr = (m.fromAddress ?? '').toLowerCase()
    if (!addr || NOT_WORTH_A_FOLDER.test(addr)) continue
    const d = domainOf(addr)
    if (d && !PUBLIC_DOMAINS.has(d)) continue
    const cur = byPerson.get(addr) ?? { count: 0, name: m.fromName || addr }
    cur.count += 1
    byPerson.set(addr, cur)
  }

  const out: FolderSuggestion[] = []
  for (const [domain, v] of byDomain) {
    if (v.count < minCount) continue
    out.push({
      name: titleCase(v.label),
      from: [domain],
      count: v.count,
      reason:
        v.unread > 0
          ? `${v.count} messages from ${domain}, ${v.unread} still unread`
          : `${v.count} messages from ${domain}`
    })
  }
  for (const [addr, v] of byPerson) {
    if (v.count < minCount) continue
    out.push({
      name: v.name,
      from: [addr],
      count: v.count,
      reason: `${v.count} messages from ${v.name}`
    })
  }

  // Biggest first: the folder that removes the most from the unsorted pile is
  // the one worth the click.
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit)
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

/**
 * A folder seeded from one message, for "file this and everything like it".
 *
 * The one-click path that actually gets used. Seeded from the SENDER rather
 * than the subject because sender is the durable thing -- subjects drift as a
 * thread wanders, senders do not.
 */
export function folderFromMessage(msg: MailListItem): { name: string; from: string[] } {
  const addr = (msg.fromAddress ?? '').toLowerCase()
  const d = domainOf(addr)
  // For somebody at an organisation, the organisation is almost always the
  // useful unit; for somebody on a personal address, the person is.
  if (d && !PUBLIC_DOMAINS.has(d) && !NOT_WORTH_A_FOLDER.test(addr)) {
    return { name: titleCase(d.split('.')[0]), from: [d] }
  }
  return { name: msg.fromName || addr || 'New folder', from: [addr].filter(Boolean) }
}
