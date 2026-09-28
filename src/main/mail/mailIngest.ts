// Filling the local mail store, and answering a question out of it.
//
// Three jobs, deliberately separate because they have different costs:
//
//   ingestHeaderPage  — free. A listing already happened; record what it said.
//   backfillBodies    — one IMAP fetch per message. Runs in the background, newest
//                       first, on a budget.
//   findInMail        — the question-time path. Searches what is stored, and when
//                       that is not enough, REACHES FURTHER BACK and searches
//                       again, rather than answering out of whatever happened to
//                       be cached.
//
// The last one is the point. A mailbox answers "what did they say about X" with
// the most recent thing said about X, so the search is ordered by date and the
// widening is backwards through history — never "rank everything and hope the
// recent one wins on relevance", which is how a five-year-old thread ends up
// being quoted as current.

import type { MailAccountConfig } from './mailAccount'
import { listInbox, getMessageForIngest, type IngestAttachment } from './imap'
import { extractTextFromBuffer } from '../fileText'
import { getDb } from '../db/database'
import {
  upsertMailHeaders,
  upsertMailBody,
  upsertMailAttachments,
  searchStoredMail,
  mailMissingBodies,
  mailStoreStats,
  listStoredMail,
  type MailDb,
  type MailSearchHit
} from '../db/mailStore'

/** The IMAP login identifies the store's partition. */
export const accountKeyOf = (config: MailAccountConfig): string => config.user.trim().toLowerCase()

const db = (): MailDb => getDb() as unknown as MailDb

/** Attachment text is worth storing; attachment bytes are not. */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
/** Bodies fetched per background pass. Each is a round trip to the mail server. */
const BACKFILL_BUDGET = 12
/** How far back one widening step reaches. */
const WIDEN_PAGE = 60
/** Hard ceiling on widening steps for a single question. */
const MAX_WIDEN_ROUNDS = 4

export interface IngestHeaderItem {
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

/**
 * Record a listing page. Called from the mail:list handler, so simply using Mail
 * fills the store as a side effect and no separate sync has to be scheduled.
 */
export function ingestHeaderPage(items: IngestHeaderItem[], config: MailAccountConfig): number {
  return upsertMailHeaders(db(), items, { accountKey: accountKeyOf(config) })
}

const extOf = (filename: string): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename)
  return m ? m[1].toLowerCase() : ''
}

async function attachmentText(a: IngestAttachment): Promise<string | null> {
  if (!a.content || a.content.byteLength === 0) return null
  // A 40MB video has no text and would cost minutes to find that out.
  if (a.content.byteLength > MAX_ATTACHMENT_BYTES) return null
  try {
    return await extractTextFromBuffer(a.content, extOf(a.filename), a.contentType)
  } catch {
    // extractTextFromBuffer is already defensive; this is belt-and-braces so one
    // malformed PDF cannot stop the rest of a backfill pass.
    return null
  }
}

/** Fetch one message's body + attachment text into the store. */
export async function ingestMessage(config: MailAccountConfig, uid: number): Promise<boolean> {
  const accountKey = accountKeyOf(config)
  const msg = await getMessageForIngest(config, uid)
  if (!msg) return false
  // Header fields may have been unknown until now (a body fetch is the first time
  // toText and the threading headers are seen), so refresh them too.
  upsertMailHeaders(
    db(),
    [
      {
        uid,
        fromName: msg.fromName,
        fromAddress: msg.fromAddress,
        subject: msg.subject,
        date: msg.date,
        hasAttachments: msg.attachments.length > 0,
        messageId: msg.messageId
      }
    ],
    { accountKey }
  )
  upsertMailBody(db(), uid, {
    accountKey,
    text: msg.text,
    toText: msg.toText,
    inReplyTo: msg.inReplyTo,
    references: msg.references
  })
  if (msg.attachments.length > 0) {
    const rows: Array<{ filename: string; contentType: string; sizeBytes: number; textContent: string | null }> = []
    for (const a of msg.attachments) {
      rows.push({
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.size,
        textContent: await attachmentText(a)
      })
    }
    upsertMailAttachments(db(), uid, rows, { accountKey })
  }
  return true
}

export interface BackfillResult {
  attempted: number
  stored: number
  remaining: number
}

/**
 * Fetch bodies for messages whose headers are known, newest first.
 *
 * Newest first so that an interrupted backfill has still done the part most
 * likely to be asked about. Budgeted because each message is a round trip: left
 * unbounded on a ten-year mailbox this would hammer the server for an hour.
 */
export async function backfillBodies(
  config: MailAccountConfig,
  opts: { budget?: number } = {}
): Promise<BackfillResult> {
  const accountKey = accountKeyOf(config)
  const budget = Math.max(1, opts.budget ?? BACKFILL_BUDGET)
  const todo = mailMissingBodies(db(), { accountKey, limit: budget })
  let stored = 0
  for (const m of todo) {
    try {
      if (await ingestMessage(config, m.uid)) stored += 1
    } catch {
      // A single unreadable message must not end the pass. It keeps body_at NULL,
      // so the next pass will try again rather than losing it silently.
    }
  }
  return {
    attempted: todo.length,
    stored,
    remaining: mailMissingBodies(db(), { accountKey, limit: 1 }).length
  }
}

/**
 * Reach one page further back than anything currently stored.
 *
 * listInbox's `beforeUid` cursor is what makes this possible: uids ascend with
 * arrival, so the lowest stored uid is the boundary of what is known.
 */
export async function ingestOlderPage(
  config: MailAccountConfig,
  opts: { limit?: number } = {}
): Promise<number> {
  const accountKey = accountKeyOf(config)
  const oldest = listStoredMail(db(), { accountKey, limit: 1_000 })
  const beforeUid = oldest.length ? Math.min(...oldest.map((m) => m.uid)) : undefined
  const page = await listInbox(config, { limit: opts.limit ?? WIDEN_PAGE, beforeUid })
  if (page.items.length === 0) return 0
  return ingestHeaderPage(page.items as IngestHeaderItem[], config)
}

export interface FindInMailResult {
  hits: MailSearchHit[]
  /** How many times the search had to reach further back. 0 = answered from store. */
  rounds: number
  /** True when history ran out before `want` hits were found. */
  exhausted: boolean
  /** Bodies fetched during this call, so a caller can explain a slow answer. */
  fetched: number
}

/**
 * Answer a question from mail, widening backwards until it is answered.
 *
 * The loop is the feature:
 *
 *   1. search what is stored, newest first
 *   2. not enough? the matches may be header-only — fetch those bodies and retry,
 *      because a subject line rarely contains the answer
 *   3. still not enough? pull an older page of headers and go round again
 *
 * It stops on the first round that has enough, when history runs out, or at
 * MAX_WIDEN_ROUNDS — which exists so one vague question cannot walk a decade of
 * mail one page at a time.
 */
export async function findInMail(
  question: string,
  config: MailAccountConfig,
  opts: { want?: number; maxRounds?: number } = {}
): Promise<FindInMailResult> {
  const accountKey = accountKeyOf(config)
  const want = Math.max(1, opts.want ?? 6)
  const maxRounds = Math.max(0, opts.maxRounds ?? MAX_WIDEN_ROUNDS)
  let fetched = 0

  for (let round = 0; ; round++) {
    const hits = searchStoredMail(db(), question, { accountKey, limit: want * 2 })

    // A hit whose body was never fetched is a subject-line match. It might be the
    // answer, but nothing can be quoted from it, so fetch before judging whether
    // this round succeeded.
    const bodyless = hits.filter((h) => h.message.bodyAt === null).slice(0, want)
    if (bodyless.length > 0) {
      for (const h of bodyless) {
        try {
          if (await ingestMessage(config, h.message.uid)) fetched += 1
        } catch {
          // Leave it header-only; it stays a candidate next round.
        }
      }
      const withBodies = searchStoredMail(db(), question, { accountKey, limit: want * 2 })
      if (withBodies.length >= want || round >= maxRounds) {
        return { hits: withBodies.slice(0, want), rounds: round, exhausted: false, fetched }
      }
    } else if (hits.length >= want || round >= maxRounds) {
      return { hits: hits.slice(0, want), rounds: round, exhausted: false, fetched }
    }

    // Not enough, and rounds remain: reach further back.
    const added = await ingestOlderPage(config)
    if (added === 0) {
      // History is exhausted. Return what there is and say so — "I looked through
      // everything and this is all there is" is a different answer from "here are
      // the first few I found", and the caller needs to be able to tell the user
      // which one it is.
      const final = searchStoredMail(db(), question, { accountKey, limit: want })
      return { hits: final, rounds: round, exhausted: true, fetched }
    }
  }
}

/** What the store holds, for an honest "I have looked at N messages" line. */
export function mailCoverage(config: MailAccountConfig): {
  messages: number
  withBodies: number
  attachments: number
  newestDate: number | null
  oldestDate: number | null
} {
  return mailStoreStats(db(), { accountKey: accountKeyOf(config) })
}
