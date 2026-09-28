// A local store for mail: headers, bodies and attachment text.
//
// Until this existed there was nowhere for a message to live. `mail:list` hit
// IMAP, handed the page to the renderer, and kept a few fields in a module-level
// array for global search. So the assistant could only ever know about mail the
// user had already looked at in this session, and an inbox nobody had opened read
// as "not loaded" — honest, but useless for answering "what did the landlord say
// about the deposit?" about a message from March.
//
// WHY THIS IS NOT IN schema.ts. That file is shared verbatim with the cloud/browser
// runtime, and a table declared there rides in workspace sync bodies. Mail must not:
// it is a local cache of the user's own mail server, and syncing message bodies to
// other devices would turn a convenience into a data-escalation nobody asked for.
// So it follows the ensureXSchema() pattern (contacts.ts, mailTags.ts, workItems.ts)
// and stays on this device.
//
// WHAT IS STORED. Everything needed to ANSWER about a message: headers, the plain
// text body, and text extracted from attachments. Deliberately not the attachment
// bytes — a mailbox of PDFs would dwarf the rest of the database, and the text is
// what a question is asked against. The bytes are still on the mail server.
//
// Retention: uid is unique only within a mailbox, so the key is
// (account_key, mailbox, uid). account_key is the IMAP login, lowercased, so two
// accounts on one machine cannot collide.

// The subset of the database API this module touches. Both better-sqlite3 (the
// app) and node:sqlite's DatabaseSync (the tests) satisfy it. Taken as an
// argument rather than reached for via getDb() for the same reason chunkIndex.ts
// does: the value of this module IS its search semantics, and a mocked database
// cannot vouch for an fts5 MATCH expression or the order rows come back in.
export interface MailDb {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
}

// better-sqlite3 wraps a function in a transaction; node:sqlite (the tests) has
// no such method. Detected rather than declared on MailDb, so the interface stays
// the minimum both engines genuinely share.
type Txable = { transaction?: (fn: (...a: never[]) => unknown) => (...a: never[]) => unknown }
function inTransaction(db: MailDb, body: () => void): void {
  const tx = (db as unknown as Txable).transaction
  // Batching is a speed concern here, not a correctness one — every upsert is
  // independently valid — so running unwrapped is an acceptable fallback.
  if (typeof tx === 'function') (tx.call(db, body as never) as () => void)()
  else body()
}

export interface StoredMail {
  uid: number
  accountKey: string
  mailbox: string
  messageId: string | null
  fromName: string
  fromAddress: string
  toText: string
  subject: string
  date: number
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  /** null means the headers are known and the body has not been fetched yet. */
  bodyText: string | null
  headersAt: number
  bodyAt: number | null
}

export interface StoredAttachment {
  uid: number
  filename: string
  contentType: string
  sizeBytes: number
  /** Extracted text, when the type allowed it. null = not extracted. */
  textContent: string | null
}

export interface MailHeaderInput {
  uid: number
  fromName?: string
  fromAddress?: string
  subject?: string
  date?: number
  seen?: boolean
  flagged?: boolean
  hasAttachments?: boolean
  messageId?: string | null
}

export function ensureMailStoreSchema(db: MailDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_messages (
      account_key TEXT NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      uid INTEGER NOT NULL,
      message_id TEXT,
      from_name TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      to_text TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      date INTEGER NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      body_text TEXT,
      in_reply_to TEXT,
      refs TEXT,
      headers_at INTEGER NOT NULL DEFAULT 0,
      body_at INTEGER,
      PRIMARY KEY (account_key, mailbox, uid)
    )`)
  // Recency is the primary access path: every read and every search walks newest
  // first, so this index carries the whole feature.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_messages_date ON mail_messages(account_key, mailbox, date DESC)`)
  // Finding what still needs a body fetched, cheaply, for the backfill.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_messages_bodyless ON mail_messages(account_key, mailbox, body_at, date DESC)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_attachments (
      account_key TEXT NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'INBOX',
      uid INTEGER NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      text_content TEXT,
      extracted_at INTEGER,
      PRIMARY KEY (account_key, mailbox, uid, filename)
    )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_attachments_msg ON mail_attachments(account_key, mailbox, uid)`)

  // FTS over the searchable text. `rowkey` is the composite key flattened to one
  // string, because fts5 has no composite primary key of its own. Kept in step by
  // explicit writes rather than triggers: the body and the attachment text arrive
  // in separate passes long after the header row, so a row is re-indexed several
  // times and doing that from one place is easier to reason about than three
  // triggers racing over the same row.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
      rowkey UNINDEXED, subject, sender, body, attachments
    )`)
}

const keyOf = (accountKey: string, mailbox: string, uid: number): string =>
  `${accountKey}\u0000${mailbox}\u0000${uid}`

const norm = (s: string): string => s.trim().toLowerCase()

/** Re-index one message from whatever is currently stored for it. */
function reindex(db: MailDb, accountKey: string, mailbox: string, uid: number): void {
  const rowkey = keyOf(accountKey, mailbox, uid)
  db.prepare(`DELETE FROM mail_fts WHERE rowkey = ?`).run(rowkey)
  const m = db
    .prepare(
      `SELECT subject, from_name, from_address, body_text FROM mail_messages
       WHERE account_key = ? AND mailbox = ? AND uid = ?`
    )
    .get(accountKey, mailbox, uid) as
    | { subject: string; from_name: string; from_address: string; body_text: string | null }
    | undefined
  if (!m) return
  const atts = db
    .prepare(
      `SELECT filename, text_content FROM mail_attachments
       WHERE account_key = ? AND mailbox = ? AND uid = ?`
    )
    .all(accountKey, mailbox, uid) as Array<{ filename: string; text_content: string | null }>
  const attText = atts.map((a) => `${a.filename} ${a.text_content ?? ''}`).join('\n')
  db.prepare(`INSERT INTO mail_fts(rowkey, subject, sender, body, attachments) VALUES (?, ?, ?, ?, ?)`).run(
    rowkey,
    m.subject,
    `${m.from_name} ${m.from_address}`,
    m.body_text ?? '',
    attText
  )
}

/**
 * Record the headers from a listing page.
 *
 * Upsert, not insert: a page is re-fetched constantly and read state changes
 * under us. Header fields are refreshed; the body and attachments are left
 * alone, because a listing does not carry them and overwriting a fetched body
 * with nothing is how a store quietly empties itself.
 */
export function upsertMailHeaders(
  db: MailDb,
  items: MailHeaderInput[],
  opts: { accountKey: string; mailbox?: string }
): number {
  if (items.length === 0) return 0
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  const now = Date.now()
  const stmt = db.prepare(`
    INSERT INTO mail_messages (
      account_key, mailbox, uid, message_id, from_name, from_address,
      subject, date, seen, flagged, has_attachments, headers_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_key, mailbox, uid) DO UPDATE SET
      message_id = COALESCE(excluded.message_id, mail_messages.message_id),
      from_name = excluded.from_name,
      from_address = excluded.from_address,
      subject = excluded.subject,
      date = excluded.date,
      seen = excluded.seen,
      flagged = excluded.flagged,
      has_attachments = excluded.has_attachments,
      headers_at = excluded.headers_at`)
  const body = (rows: MailHeaderInput[]): void => {
    for (const m of rows) {
      stmt.run(
        accountKey,
        mailbox,
        m.uid,
        m.messageId ?? null,
        m.fromName ?? '',
        m.fromAddress ?? '',
        m.subject ?? '',
        m.date ?? 0,
        m.seen ? 1 : 0,
        m.flagged ? 1 : 0,
        m.hasAttachments ? 1 : 0,
        now
      )
      reindex(db, accountKey, mailbox, m.uid)
    }
  }
  inTransaction(db, () => body(items))
  return items.length
}

/** Record a fetched body. Marks body_at so the backfill stops asking for it. */
export function upsertMailBody(
  db: MailDb,
  uid: number,
  opts: {
    accountKey: string
    mailbox?: string
    text: string
    toText?: string
    inReplyTo?: string | null
    references?: string[]
  }
): void {
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  db.prepare(
    `UPDATE mail_messages
       SET body_text = ?, to_text = COALESCE(?, to_text), in_reply_to = ?, refs = ?, body_at = ?
     WHERE account_key = ? AND mailbox = ? AND uid = ?`
  ).run(
    opts.text,
    opts.toText ?? null,
    opts.inReplyTo ?? null,
    opts.references && opts.references.length ? JSON.stringify(opts.references) : null,
    Date.now(),
    accountKey,
    mailbox,
    uid
  )
  reindex(db, accountKey, mailbox, uid)
}

/** Record attachment metadata, and extracted text where the caller managed it. */
export function upsertMailAttachments(
  db: MailDb,
  uid: number,
  atts: Array<{ filename: string; contentType: string; sizeBytes: number; textContent?: string | null }>,
  opts: { accountKey: string; mailbox?: string }
): void {
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  const stmt = db.prepare(`
    INSERT INTO mail_attachments (
      account_key, mailbox, uid, filename, content_type, size_bytes, text_content, extracted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_key, mailbox, uid, filename) DO UPDATE SET
      content_type = excluded.content_type,
      size_bytes = excluded.size_bytes,
      text_content = COALESCE(excluded.text_content, mail_attachments.text_content),
      extracted_at = COALESCE(excluded.extracted_at, mail_attachments.extracted_at)`)
  const body = (): void => {
    for (const a of atts) {
      stmt.run(
        accountKey,
        mailbox,
        uid,
        a.filename || 'attachment',
        a.contentType || '',
        a.sizeBytes || 0,
        a.textContent ?? null,
        a.textContent ? Date.now() : null
      )
    }
    reindex(db, accountKey, mailbox, uid)
  }
  inTransaction(db, body)
}

function rowToStored(r: Record<string, unknown>): StoredMail {
  return {
    uid: r.uid as number,
    accountKey: r.account_key as string,
    mailbox: r.mailbox as string,
    messageId: (r.message_id as string | null) ?? null,
    fromName: (r.from_name as string) ?? '',
    fromAddress: (r.from_address as string) ?? '',
    toText: (r.to_text as string) ?? '',
    subject: (r.subject as string) ?? '',
    date: (r.date as number) ?? 0,
    seen: !!r.seen,
    flagged: !!r.flagged,
    hasAttachments: !!r.has_attachments,
    bodyText: (r.body_text as string | null) ?? null,
    headersAt: (r.headers_at as number) ?? 0,
    bodyAt: (r.body_at as number | null) ?? null
  }
}

/** Newest first. `beforeDate` pages backwards through history. */
export function listStoredMail(
  db: MailDb,
  opts: {
  accountKey: string
  mailbox?: string
  limit?: number
    beforeDate?: number
  }
): StoredMail[] {
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 500))
  const rows = (
    opts.beforeDate
      ? db
          .prepare(
            `SELECT * FROM mail_messages WHERE account_key = ? AND mailbox = ? AND date < ?
             ORDER BY date DESC LIMIT ?`
          )
          .all(accountKey, mailbox, opts.beforeDate, limit)
      : db
          .prepare(
            `SELECT * FROM mail_messages WHERE account_key = ? AND mailbox = ?
             ORDER BY date DESC LIMIT ?`
          )
          .all(accountKey, mailbox, limit)
  ) as Array<Record<string, unknown>>
  return rows.map(rowToStored)
}

export function getStoredMail(
  db: MailDb,
  uid: number,
  opts: { accountKey: string; mailbox?: string }
): StoredMail | null {
  const r = db
    .prepare(`SELECT * FROM mail_messages WHERE account_key = ? AND mailbox = ? AND uid = ?`)
    .get(norm(opts.accountKey), opts.mailbox ?? 'INBOX', uid) as Record<string, unknown> | undefined
  return r ? rowToStored(r) : null
}

export function getStoredAttachments(
  db: MailDb,
  uid: number,
  opts: { accountKey: string; mailbox?: string }
): StoredAttachment[] {
  const rows = db
    .prepare(
      `SELECT uid, filename, content_type, size_bytes, text_content FROM mail_attachments
       WHERE account_key = ? AND mailbox = ? AND uid = ? ORDER BY filename`
    )
    .all(norm(opts.accountKey), opts.mailbox ?? 'INBOX', uid) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    uid: r.uid as number,
    filename: (r.filename as string) ?? '',
    contentType: (r.content_type as string) ?? '',
    sizeBytes: (r.size_bytes as number) ?? 0,
    textContent: (r.text_content as string | null) ?? null
  }))
}

/**
 * Messages whose headers are stored but whose body is not, newest first.
 *
 * Newest first on purpose: it is the order the user is most likely to ask about,
 * so a backfill that is interrupted has still done the most useful part.
 */
export function mailMissingBodies(
  db: MailDb,
  opts: { accountKey: string; mailbox?: string; limit?: number }
): StoredMail[] {
  const rows = db
    .prepare(
      `SELECT * FROM mail_messages
       WHERE account_key = ? AND mailbox = ? AND body_at IS NULL
       ORDER BY date DESC LIMIT ?`
    )
    .all(norm(opts.accountKey), opts.mailbox ?? 'INBOX', Math.max(1, Math.min(opts.limit ?? 20, 200))) as Array<
    Record<string, unknown>
  >
  return rows.map(rowToStored)
}

export interface MailStoreStats {
  messages: number
  withBodies: number
  attachments: number
  newestDate: number | null
  oldestDate: number | null
}

export function mailStoreStats(
  db: MailDb,
  opts: { accountKey: string; mailbox?: string }
): MailStoreStats {
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  const m = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN body_at IS NOT NULL THEN 1 ELSE 0 END) AS withBodies,
              MAX(date) AS newest, MIN(date) AS oldest
       FROM mail_messages WHERE account_key = ? AND mailbox = ?`
    )
    .get(accountKey, mailbox) as { n: number; withBodies: number | null; newest: number | null; oldest: number | null }
  const a = db
    .prepare(`SELECT COUNT(*) AS n FROM mail_attachments WHERE account_key = ? AND mailbox = ?`)
    .get(accountKey, mailbox) as { n: number }
  return {
    messages: m.n ?? 0,
    withBodies: m.withBodies ?? 0,
    attachments: a.n ?? 0,
    newestDate: m.newest ?? null,
    oldestDate: m.oldest ?? null
  }
}

/**
 * Turn a natural-language question into an fts5 MATCH expression.
 *
 * OR rather than AND, because the caller is walking history looking for an
 * answer and a missing word should not hide the message that holds it. Very
 * short and very common words are dropped: they match nearly everything, which
 * turns a search into a scan and buries the message that actually matters.
 *
 * Returns null when nothing usable is left, which the caller must treat as "do
 * not search" rather than "match everything".
 */
export function toMailFtsQuery(question: string): string | null {
  const STOP = new Set([
    'the', 'and', 'for', 'was', 'were', 'what', 'when', 'who', 'how', 'why', 'did', 'does',
    'you', 'your', 'me', 'my', 'about', 'from', 'with', 'that', 'this', 'there', 'their',
    'have', 'has', 'had', 'are', 'any', 'all', 'can', 'could', 'would', 'should', 'said',
    'say', 'says', 'tell', 'find', 'show', 'get', 'got', 'into', 'out', 'over', 'been',
    'email', 'emails', 'mail', 'inbox', 'message', 'messages'
  ])
  const tokens = [
    ...new Set(
      question
        .toLowerCase()
        // fts5 treats most punctuation as syntax; strip it rather than escape it.
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP.has(t))
    )
  ]
  if (tokens.length === 0) return null
  // Prefix-match each term so "deposit" finds "deposits" without a stemmer.
  //
  // Prefix only works one way, though: "receipt"* finds "receipts", and
  // "receipts"* finds nothing for a message that said "receipt". Someone asking
  // "what were the receipts for?" must not miss the message because they used a
  // plural, so a trailing -s also contributes its stem. Crude on purpose — a real
  // stemmer is a dependency and a behaviour change, and this covers the case that
  // actually comes up. "ss" is left alone so "address" does not become "addres".
  const terms = new Set<string>()
  for (const t of tokens) {
    terms.add(t)
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) terms.add(t.slice(0, -1))
  }
  return [...terms].map((t) => `"${t}"*`).join(' OR ')
}

export interface MailSearchHit {
  message: StoredMail
  attachments: StoredAttachment[]
  /** fts5 bm25: LOWER is a better match. Negated here so higher = better. */
  score: number
}

/**
 * Search stored mail, NEWEST FIRST.
 *
 * Ordered by date rather than by relevance on purpose. A mailbox answers "what
 * did they say about X" with the most recent thing said about X; ranking purely
 * by relevance surfaces a five-year-old thread because it happened to repeat the
 * word more often. Relevance is used as a FILTER (is this a real match at all?)
 * and recency as the ORDER.
 *
 * `beforeDate` walks further back, so a caller can keep going until it has what
 * it needs or runs out of history.
 */
export function searchStoredMail(
  db: MailDb,
  question: string,
  opts: { accountKey: string; mailbox?: string; limit?: number; beforeDate?: number }
): MailSearchHit[] {
  const match = toMailFtsQuery(question)
  if (!match) return []
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  const limit = Math.max(1, Math.min(opts.limit ?? 12, 100))
  const prefix = `${accountKey}\u0000${mailbox}\u0000`
  const params: unknown[] = [match, prefix]
  let dateClause = ''
  if (opts.beforeDate) {
    dateClause = ' AND m.date < ?'
    params.push(opts.beforeDate)
  }
  params.push(limit)
  let rows: Array<Record<string, unknown>>
  try {
    rows = db
      .prepare(
        `SELECT m.*, bm25(mail_fts) AS bm
         FROM mail_fts
         JOIN mail_messages m
           ON m.account_key || char(0) || m.mailbox || char(0) || m.uid = mail_fts.rowkey
         WHERE mail_fts MATCH ?
           AND mail_fts.rowkey LIKE ? || '%'${dateClause}
         ORDER BY m.date DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>
  } catch {
    // A malformed MATCH is a bad question, not a broken database. Returning
    // nothing lets the caller fall back rather than failing the whole answer.
    return []
  }
  return rows.map((r) => {
    const message = rowToStored(r)
    return {
      message,
      attachments: getStoredAttachments(db, message.uid, { accountKey, mailbox }),
      score: -((r.bm as number) ?? 0)
    }
  })
}

/** Drop everything for an account — used when a mailbox is disconnected. */
export function clearStoredMail(db: MailDb, opts: { accountKey: string; mailbox?: string }): void {
  const accountKey = norm(opts.accountKey)
  const mailbox = opts.mailbox ?? 'INBOX'
  const prefix = `${accountKey}\u0000${mailbox}\u0000`
  db.prepare(`DELETE FROM mail_fts WHERE rowkey LIKE ? || '%'`).run(prefix)
  db.prepare(`DELETE FROM mail_attachments WHERE account_key = ? AND mailbox = ?`).run(accountKey, mailbox)
  db.prepare(`DELETE FROM mail_messages WHERE account_key = ? AND mailbox = ?`).run(accountKey, mailbox)
}
