// IMAP client — the thin layer that actually talks to the user's mail server.
// PlexiDesk connects directly from the desktop using imapflow, lists the most
// recent INBOX messages (envelope only, so the list loads fast), and fetches a
// full message body on demand with mailparser when one is opened.
//
// Each call opens a fresh, short-lived connection and logs out. A desktop
// client polls infrequently, so a connection pool would be premature; a clean
// connect/lock/logout per operation is simpler and avoids stale-socket bugs.

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { AddressObject } from 'mailparser'
import type { MailAccountConfig } from './mailAccount'
import { parseThreadingHeaders } from './threadingHeaders'
import { parseUnsubscribe } from './unsubscribe'
import { pageOfUids, uidRange } from './mailPaging'

// Flatten a mailparser address header (a single object or an array of them)
// into the bare list of email addresses, lower-cased and de-duplicated.
function collectAddresses(
  field: AddressObject | AddressObject[] | undefined
): string[] {
  if (!field) return []
  const objs = Array.isArray(field) ? field : [field]
  const out = new Set<string>()
  for (const obj of objs) {
    for (const a of obj.value ?? []) {
      if (a.address) out.add(a.address.toLowerCase())
    }
  }
  return [...out]
}

export interface MailListItem {
  uid: number
  // Sender display name (falls back to the address) and the raw address.
  fromName: string
  fromAddress: string
  subject: string
  // Epoch millis of the message date, for sorting + relative-time display.
  date: number
  seen: boolean
  flagged: boolean
  // True when the message carries at least one real attachment.
  hasAttachments: boolean
  // RFC 5322 threading headers, used to group the mailbox into conversations.
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  /** The sender's own List-Unsubscribe target (RFC 2369), when they published
   *  one: an https link or a mailto. Null means this sender offered no way to
   *  unsubscribe — which is a fact worth showing, not a gap to fill in. */
  unsubscribe: { kind: 'http' | 'mailto'; target: string } | null
  /** RFC 8058 one-click: the sender accepts an unsubscribe POST. */
  oneClickUnsubscribe: boolean
}

export interface MailFullMessage {
  uid: number
  fromName: string
  fromAddress: string
  to: string
  subject: string
  date: number
  // Plain-text body, derived from text/plain or stripped from HTML.
  text: string
  // Sanitized-enough HTML body when the message had one (rendered in a
  // sandboxed iframe on the renderer side), else null.
  html: string | null
  attachments: { filename: string; size: number; contentType: string }[]
  // Threading + reply-all support — see the shared MailFullMessage type.
  messageId: string | null
  references: string[]
  toAddresses: string[]
  ccAddresses: string[]
}

function buildClient(config: MailAccountConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    // No verbose protocol logging; surface only thrown errors.
    logger: false,
    // Fail fast on an unresponsive or wrong-port server rather than hanging
    // the Settings "Test" button forever.
    greetingTimeout: 12_000,
    socketTimeout: 30_000
  })
}

// ── Warm connection pool ─────────────────────────────────────────────────────
// Opening a fresh IMAP connection per click meant a full TCP + TLS handshake
// and a LOGIN round-trip every time the user opened a message — on Gmail that
// is one to three seconds of dead time before the body even starts loading.
// A desktop client opens messages in bursts, so we keep ONE authenticated
// connection warm and reuse it across list/open/markSeen, then let it go idle
// after a minute of no use. The first operation still pays the connect cost;
// every operation after it is just a FETCH on an already-open socket.

const IDLE_LOGOUT_MS = 60_000

interface WarmConnection {
  key: string
  client: ImapFlow
  // Resolves once connect() has finished, so concurrent callers share one
  // connect instead of racing to open several sockets.
  ready: Promise<void>
  idleTimer: ReturnType<typeof setTimeout> | null
}

let warm: WarmConnection | null = null

// Identity of a connection — reconnect from scratch if any of these change.
function connKey(config: MailAccountConfig): string {
  return `${config.host}:${config.port}:${config.secure ? 's' : 'p'}:${config.user}`
}

function clearIdleTimer(conn: WarmConnection): void {
  if (conn.idleTimer) {
    clearTimeout(conn.idleTimer)
    conn.idleTimer = null
  }
}

// Drop the warm connection and close its socket. Safe to call repeatedly.
function dropWarm(conn: WarmConnection | null): void {
  if (!conn) return
  clearIdleTimer(conn)
  if (warm === conn) warm = null
  conn.client.logout().catch(() => conn.client.close())
}

function scheduleIdleLogout(conn: WarmConnection): void {
  clearIdleTimer(conn)
  conn.idleTimer = setTimeout(() => dropWarm(conn), IDLE_LOGOUT_MS)
  // Don't let a pending logout timer keep the process alive on quit.
  conn.idleTimer.unref?.()
}

// Get an authenticated, ready-to-use client for this account, reusing the warm
// one when possible. Callers MUST NOT log the client out; call releaseWarm()
// in a finally to restart the idle countdown instead.
async function acquireWarm(config: MailAccountConfig): Promise<ImapFlow> {
  const key = connKey(config)

  // Reuse the existing warm connection when it matches and is still usable.
  if (warm && warm.key === key && warm.client.usable) {
    clearIdleTimer(warm)
    try {
      await warm.ready
      if (warm.client.usable) return warm.client
    } catch {
      // connect() failed earlier — fall through and rebuild below.
    }
  }

  // Different account, or a dead/closed socket: tear the old one down.
  if (warm) dropWarm(warm)

  const client = buildClient(config)
  // A dropped socket (server timeout, network blip) must invalidate the warm
  // slot so the next call reconnects instead of using a dead client.
  const invalidate = (): void => {
    if (warm && warm.client === client) {
      clearIdleTimer(warm)
      warm = null
    }
  }
  client.on('close', invalidate)
  client.on('error', invalidate)

  const conn: WarmConnection = {
    key,
    client,
    ready: client.connect(),
    idleTimer: null
  }
  warm = conn
  try {
    await conn.ready
  } catch (err) {
    invalidate()
    throw err
  }
  return client
}

// Call after each operation to (re)start the idle countdown on the warm
// connection. Never logs out inline, so the socket stays hot for the next op.
function releaseWarm(): void {
  if (warm) scheduleIdleLogout(warm)
}

/**
 * Force the warm connection closed. Call whenever the saved account changes —
 * a password rotation keeps the same host/user key, so without this the pool
 * would keep reusing the socket authenticated with the old credentials.
 */
export function resetConnection(): void {
  dropWarm(warm)
}

/** Turn imapflow / network errors into a short, human message. */
function explain(err: unknown): string {
  // imapflow throws a bare `new Error('Command failed')` when the server
  // rejects a command, and puts the real reason on side fields:
  //   err.responseText        e.g. "[AUTHENTICATIONFAILED] Invalid credentials (Failure)"
  //   err.serverResponseCode  e.g. "AUTHENTICATIONFAILED"
  //   err.authenticationFailed true on a rejected LOGIN/AUTHENTICATE
  //   err.code                e.g. "ETIMEOUT", "ENOTFOUND", "GREETING_TIMEOUT"
  // Reading only err.message ("Command failed") loses all of that, so build the
  // string we classify from the richest detail the error actually carries.
  const e = (err ?? {}) as {
    message?: string
    responseText?: string
    serverResponseCode?: string
    authenticationFailed?: boolean
    code?: string
  }
  const baseMsg = err instanceof Error ? err.message : String(err)
  const msg = [e.responseText, e.serverResponseCode, e.code, baseMsg]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ')

  if (e.authenticationFailed || /auth|credential|login|invalid|password/i.test(msg)) {
    return 'Login was rejected. Check the username and password. Gmail, iCloud and Fastmail need an app-specific password, not your normal one.'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return 'Could not find that mail server. Check the IMAP host.'
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|greeting/i.test(msg)) {
    return 'Could not reach that mail server. Check the host, the port, and the SSL/TLS setting.'
  }
  if (/self.signed|certificate|TLS|SSL/i.test(msg)) {
    return 'The server’s TLS certificate could not be verified.'
  }
  return msg
}

/** Connect and immediately log out — proves the credentials work. */
export async function testConnection(
  config: MailAccountConfig
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = buildClient(config)
  try {
    await client.connect()
    await client.logout()
    return { ok: true }
  } catch (err) {
    try {
      await client.close()
    } catch {
      /* already down */
    }
    return { ok: false, error: explain(err) }
  }
}

export interface MailPage {
  items: MailListItem[]
  /** True when older messages remain on the server below this page. */
  hasMore: boolean
  /** Pass back as `beforeUid` to fetch the next page. Null when none remain. */
  nextCursor: number | null
  /** How many messages INBOX holds in total, right now. */
  total: number
}

/**
 * One page of INBOX, newest first, with threading headers so the renderer can
 * group the mailbox into conversations.
 *
 * Paging walks backwards by UID, not by sequence number. The previous version
 * fetched the sequence window `total-limit+1:*`, which is fine for a single
 * "newest 40" call but cannot express "the 40 before those": sequence numbers
 * renumber the moment a message is delivered or expunged, so a second window
 * computed from a second `total` would skip or repeat messages. A UID is stable
 * for the life of the mailbox, so `beforeUid` means the same thing on every
 * call however much the mailbox has changed in between.
 *
 * The UID list comes from a search, which is cheap (uids only); the expensive
 * envelope fetch is then bounded to exactly this page.
 */
export async function listInbox(
  config: MailAccountConfig,
  opts: { limit?: number; beforeUid?: number } = {}
): Promise<MailPage> {
  const limit = opts.limit ?? 40
  const client = await acquireWarm(config)
  const lock = await client.getMailboxLock('INBOX')
  const items: MailListItem[] = []
  try {
    const total =
      typeof client.mailbox === 'object' && client.mailbox ? client.mailbox.exists : 0
    if (!total) return { items: [], hasMore: false, nextCursor: null, total: 0 }

    // Every uid in the mailbox, cheaply. `search` answers with uids because of
    // the { uid: true } option; without it these would be sequence numbers.
    const all = await client.search({ all: true }, { uid: true })
    // imapflow answers `false` when the server refuses the search. Treating that
    // as an empty list would draw an empty inbox over a mailbox we have just
    // been told holds `total` messages -- a convincing lie. It is a failure, and
    // it is reported as one.
    if (all === false) {
      throw new Error('The mail server refused to list the mailbox.')
    }
    const page = pageOfUids(all, limit, opts.beforeUid)
    const range = uidRange(page.uids)
    // An empty range is a protocol error, not an empty result, so the fetch is
    // skipped rather than sent.
    if (range === '') {
      return { items: [], hasMore: false, nextCursor: null, total }
    }

    for await (const msg of client.fetch(
      range,
      {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        // list-unsubscribe (RFC 2369) is fetched here so an "unsubscribe"
        // suggestion can point at what the SENDER published rather than a link
        // scraped out of the body. A guessed unsubscribe link is how people end
        // up confirming an address to a spammer.
        headers: ['in-reply-to', 'references', 'list-unsubscribe', 'list-unsubscribe-post']
      },
      { uid: true }
    )) {
      const from = msg.envelope?.from?.[0]
      const flags = msg.flags ?? new Set<string>()
      const threading = parseThreadingHeaders(msg.headers)
      items.push({
        uid: msg.uid,
        fromName: from?.name || from?.address || 'Unknown sender',
        fromAddress: from?.address || '',
        subject: msg.envelope?.subject || '(no subject)',
        date: msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0,
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        hasAttachments: hasRealAttachment(msg.bodyStructure),
        messageId: msg.envelope?.messageId || null,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
        ...parseUnsubscribe(msg.headers)
      })
    }
    // Newest first.
    items.sort((a, b) => b.date - a.date)
    return { items, hasMore: page.hasMore, nextCursor: page.nextCursor, total }
  } finally {
    lock.release()
    releaseWarm()
  }
}

// Walk the body structure looking for a part dispositioned as an attachment.
function hasRealAttachment(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false
  const n = node as { disposition?: string; childNodes?: unknown[] }
  if (typeof n.disposition === 'string' && n.disposition.toLowerCase() === 'attachment') {
    return true
  }
  if (Array.isArray(n.childNodes)) {
    return n.childNodes.some((c) => hasRealAttachment(c))
  }
  return false
}

/** Download + parse one message by UID for the reading pane. */
export async function getMessage(
  config: MailAccountConfig,
  uid: number
): Promise<MailFullMessage | null> {
  const client = await acquireWarm(config)
  const lock = await client.getMailboxLock('INBOX')
  try {
    const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true })
    if (!fetched || !fetched.source) return null
    const parsed = await simpleParser(fetched.source)
    const from = parsed.from?.value?.[0]
    const toText =
      parsed.to && !Array.isArray(parsed.to)
        ? parsed.to.text
        : Array.isArray(parsed.to)
          ? parsed.to.map((t) => t.text).join(', ')
          : ''
    // mailparser hands References back as a single string or an array; normalise
    // to a clean array so the reply path can append to it directly.
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : []
    return {
      uid,
      fromName: from?.name || from?.address || 'Unknown sender',
      fromAddress: from?.address || '',
      to: toText || '',
      subject: parsed.subject || '(no subject)',
      date: parsed.date ? parsed.date.getTime() : 0,
      text: parsed.text || '',
      html: typeof parsed.html === 'string' ? parsed.html : null,
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename || 'attachment',
        size: a.size || 0,
        contentType: a.contentType || 'application/octet-stream'
      })),
      messageId: parsed.messageId || null,
      references,
      toAddresses: collectAddresses(parsed.to),
      ccAddresses: collectAddresses(parsed.cc)
    }
  } finally {
    lock.release()
    releaseWarm()
  }
}

/**
 * Pull the plain-text bodies of the user's most recent Sent messages, used to
 * learn their writing voice for AI reply drafting. Finds the Sent mailbox by
 * its IMAP special-use flag (Gmail calls it "[Gmail]/Sent Mail", others "Sent")
 * and falls back to common names. Returns raw bodies; the caller sanitises and
 * truncates them before anything reaches the model.
 */
export async function sampleSent(config: MailAccountConfig, limit = 20): Promise<string[]> {
  const client = await acquireWarm(config)
  let path = 'Sent'
  try {
    const boxes = await client.list()
    const sent =
      boxes.find((b) => b.specialUse === '\\Sent') ||
      boxes.find((b) => /sent/i.test(b.path))
    if (sent) path = sent.path
  } catch {
    // list() failed — fall back to the literal "Sent" and let the lock below
    // surface a real error if that mailbox does not exist either.
  }

  const bodies: string[] = []
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null
  try {
    lock = await client.getMailboxLock(path)
    const total =
      typeof client.mailbox === 'object' && client.mailbox ? client.mailbox.exists : 0
    if (!total) return []
    const start = Math.max(1, total - limit + 1)
    for await (const msg of client.fetch(`${start}:*`, { uid: true, source: true })) {
      if (!msg.source) continue
      const parsed = await simpleParser(msg.source)
      const text = (parsed.text || '').trim()
      if (text) bodies.push(text)
    }
  } finally {
    if (lock) lock.release()
    releaseWarm()
  }
  return bodies
}

/** Mark a message read on the server (so the unread state stays in sync). */
// Move a message out of the inbox into the account's archive mailbox. The
// target is detected from the special-use \\Archive attribute when the server
// advertises one, falling back to common names, and finally to "Archive"
// (created if missing). Honest failure: throws when the move fails, so the
// caller reports it rather than pretending the inbox changed.
export async function archiveMessage(config: MailAccountConfig, uid: number): Promise<void> {
  const client = await acquireWarm(config)
  let target = 'Archive'
  try {
    const boxes = await client.list()
    const special = boxes.find((b) => (b.specialUse ?? '') === '\\Archive')
    const byName = boxes.find((b) => /^(archive|archived|all mail)$/i.test(b.name))
    if (special) target = special.path
    else if (byName) target = byName.path
    else await client.mailboxCreate('Archive').catch(() => undefined)
  } catch {
    // listing failed; try the default target anyway
  }
  const lock = await client.getMailboxLock('INBOX')
  try {
    await client.messageMove(String(uid), target, { uid: true })
  } finally {
    lock.release()
    releaseWarm()
  }
}

export async function markSeen(config: MailAccountConfig, uid: number): Promise<void> {
  const client = await acquireWarm(config)
  const lock = await client.getMailboxLock('INBOX')
  try {
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
  } finally {
    lock.release()
    releaseWarm()
  }
}

// ── Mailboxes and dispositions ───────────────────────────────────────────
//
// Everything here MOVES a message; nothing erases one. "Delete" puts a message
// in Trash and "spam" puts it in Junk, both of which the person can open and
// undo. Permanent removal (expunge) is deliberately absent: an AI suggestion
// acted on in bulk is exactly the situation where an irreversible operation
// costs someone something they cannot get back.

export interface MailboxInfo {
  path: string
  name: string
  /** The IMAP special-use flag, when the server publishes one (\\Sent, \\Junk…). */
  specialUse: string | null
  /** True for a folder this app should not file ordinary mail into. */
  reserved: boolean
}

const RESERVED = /^(inbox|sent|drafts?|trash|deleted items|junk|spam|archive|all mail|outbox|templates|notes)$/i

/** Every mailbox on the account, with the reserved ones marked. */
/** Clean a folder name into something safe to hand an IMAP server.
 *
 *  Leading or trailing dots and slashes are stripped because on a server whose
 *  hierarchy separator is '.', a name like '.Receipts' or 'Receipts/' nests the
 *  folder somewhere the person did not ask for -- and a stray separator is the
 *  easy typo, not a deliberate choice. Interior separators are left alone: a
 *  deliberate 'Clients/Dolan' is a legitimate request. */
export function normalizeMailboxPath(path: string): string {
  const clean = path.trim().replace(/^[./]+|[./]+$/g, '')
  if (!clean) throw new Error('A folder needs a name.')
  return clean
}

/** Decide which mailbox a special use (Trash, Junk) actually maps to.
 *
 *  Kept pure and separate from the I/O because this is the decision that can
 *  put mail somewhere the person will not find it. Order matters: the server's
 *  own SPECIAL-USE flag beats a name match, because a localised server calls
 *  its trash 'Papierkorb' and flags it '\\Trash' -- trusting the name first
 *  would create an English 'Trash' alongside the real one and quietly split the
 *  mailbox in two.
 *
 *  `needsCreate` is true only when nothing matched, so the caller creates a
 *  folder solely as a last resort. */
export function pickSpecialBox(
  boxes: Array<{ path: string; name: string; specialUse?: string }>,
  use: string,
  fallbacks: RegExp,
  create: string
): { path: string; needsCreate: boolean } {
  const special = boxes.find((b) => (b.specialUse ?? '') === use)
  if (special) return { path: special.path, needsCreate: false }
  const byName = boxes.find((b) => fallbacks.test(b.name))
  if (byName) return { path: byName.path, needsCreate: false }
  return { path: create, needsCreate: true }
}

export async function listMailboxes(config: MailAccountConfig): Promise<MailboxInfo[]> {
  const client = await acquireWarm(config)
  try {
    const boxes = await client.list()
    return boxes.map((b) => ({
      path: b.path,
      name: b.name,
      specialUse: b.specialUse ?? null,
      reserved: Boolean(b.specialUse) || RESERVED.test(b.name)
    }))
  } finally {
    releaseWarm()
  }
}

/** Create a mailbox. Returns false when it already exists — which is a fine
 *  outcome, not a failure, and the caller is told which happened. */
export async function createMailbox(config: MailAccountConfig, path: string): Promise<{ created: boolean; path: string }> {
  const clean = normalizeMailboxPath(path)
  const client = await acquireWarm(config)
  try {
    const existing = (await client.list()).find((b) => b.path.toLowerCase() === clean.toLowerCase())
    if (existing) return { created: false, path: existing.path }
    await client.mailboxCreate(clean)
    return { created: true, path: clean }
  } finally {
    releaseWarm()
  }
}

/** Move a message out of the inbox into `target`. */
export async function moveMessage(config: MailAccountConfig, uid: number, target: string): Promise<void> {
  const client = await acquireWarm(config)
  const lock = await client.getMailboxLock('INBOX')
  try {
    await client.messageMove(String(uid), target, { uid: true })
  } finally {
    lock.release()
    releaseWarm()
  }
}

/** Find the server's folder for a special use, creating a sensible fallback. */
async function specialBox(client: ImapFlow, use: string, fallbacks: RegExp, create: string): Promise<string> {
  let boxes: Array<{ path: string; name: string; specialUse?: string }> = []
  try {
    boxes = await client.list()
  } catch {
    // Listing failed. pickSpecialBox on an empty list falls through to the
    // default name, which is the best guess available.
  }
  const picked = pickSpecialBox(boxes, use, fallbacks, create)
  if (picked.needsCreate) await client.mailboxCreate(picked.path).catch(() => undefined)
  return picked.path
}

/** Move to Trash. Recoverable by design — nothing here expunges. */
export async function trashMessage(config: MailAccountConfig, uid: number): Promise<void> {
  const client = await acquireWarm(config)
  const target = await specialBox(client, '\\Trash', /^(trash|deleted items|bin)$/i, 'Trash')
  const lock = await client.getMailboxLock('INBOX')
  try {
    await client.messageMove(String(uid), target, { uid: true })
  } finally {
    lock.release()
    releaseWarm()
  }
}

/** Move to Junk and flag it, which is what "report spam" means over IMAP.
 *
 *  It is worth being plain that this teaches YOUR server, not the sender's
 *  provider: IMAP has no report-abuse channel, so nothing here notifies anyone
 *  about the sender. Saying "reported" would overstate what happened. */
export async function junkMessage(config: MailAccountConfig, uid: number): Promise<void> {
  const client = await acquireWarm(config)
  const target = await specialBox(client, '\\Junk', /^(junk|spam|bulk mail)$/i, 'Junk')
  const lock = await client.getMailboxLock('INBOX')
  try {
    await client.messageFlagsAdd(String(uid), ['$Junk'], { uid: true }).catch(() => undefined)
    await client.messageMove(String(uid), target, { uid: true })
  } finally {
    lock.release()
    releaseWarm()
  }
}
