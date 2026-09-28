// The background sweep that makes the mail store actually cover the mailbox.
//
// Without this, the store only holds what a listing happened to show: the newest
// page on launch, plus whatever the user scrolled back through, plus a little
// widening at question time. That is not the promise. The promise is that Plexii
// can answer about a message WITHOUT it having been opened first, and a levy
// notice from six months ago is outside every one of those windows.
//
// The same reasoning calendar/sync.ts already wrote down about its own loop: "a
// mirror that only updates when somebody opens the settings screen is a mirror of
// last Tuesday."
//
// THE SHAPE. Two phases, in order, both resumable:
//
//   1. Headers, oldest-ward. Page back from the oldest message known until the
//      server has nothing older. Cheap — one fetch per 60 messages — and it is
//      what makes the whole mailbox SEARCHABLE by subject and sender.
//   2. Bodies, newest-first. One fetch each, so this is the expensive phase and
//      the one that is throttled hardest. Newest first so the most-likely-asked
//      part is covered earliest.
//
// Resumability is free because the STORE is the progress: the lowest stored uid
// says how far back headers reach, and body_at IS NULL says what still needs a
// body. The one thing that cannot be re-derived is "the server has nothing
// older" — re-discovering that costs a round trip on every launch forever — so
// that single fact is persisted in mail_sync_state.
//
// THROTTLING. This talks to somebody's real mail server, on their connection,
// possibly metered. It sweeps in small batches with real gaps between them, does
// nothing at all when there is nothing to do, and stops for the session on a
// failure that looks like the server pushing back rather than retrying into a
// rate limit.

import { getFull, type MailAccountConfig } from './mailAccount'
import { accountKeyOf, ingestOlderPage, backfillBodies } from './mailIngest'
import { getDb } from '../db/database'
import { getMailSyncState, setMailSyncState, mailStoreStats, type MailDb } from '../db/mailStore'

const db = (): MailDb => getDb() as unknown as MailDb

/** Wait after launch before touching the network, so boot stays quiet. */
const FIRST_SWEEP_DELAY_MS = 45_000
/** Gap between sweep ticks. Slow on purpose: nothing here is urgent. */
const SWEEP_INTERVAL_MS = 90_000
/** Header pages per tick. One page is ~60 messages for one round trip. */
const HEADER_PAGES_PER_TICK = 2
/** Bodies per tick. One round trip each — the expensive phase. */
const BODIES_PER_TICK = 8

let timer: ReturnType<typeof setInterval> | null = null
let running = false
/** Set when the server looks like it is pushing back; cleared on next launch. */
let backedOff = false

export interface SweepTick {
  headersAdded: number
  bodiesStored: number
  headersComplete: boolean
  /** Nothing left to do for this account. */
  idle: boolean
}

/**
 * One unit of work. Exported so a test can drive the state machine directly
 * rather than waiting on a timer.
 */
export async function sweepOnce(config: MailAccountConfig): Promise<SweepTick> {
  const accountKey = accountKeyOf(config)
  const state = getMailSyncState(db(), { accountKey })
  let headersAdded = 0
  let headersComplete = state.headersComplete

  // Phase 1: reach back until the server has nothing older. Doing this before
  // bodies means the mailbox becomes searchable by subject and sender quickly,
  // which is often enough to find the right message even before its body lands.
  if (!headersComplete) {
    for (let i = 0; i < HEADER_PAGES_PER_TICK; i++) {
      const added = await ingestOlderPage(config)
      headersAdded += added
      if (added === 0) {
        // The bottom of the mailbox. Recorded so no future launch pays to
        // rediscover it.
        headersComplete = true
        setMailSyncState(db(), { accountKey, headersComplete: true })
        break
      }
    }
  }

  // Phase 2: bodies, newest first.
  const backfill = await backfillBodies(config, { budget: BODIES_PER_TICK })
  setMailSyncState(db(), { accountKey })

  return {
    headersAdded,
    bodiesStored: backfill.stored,
    headersComplete,
    idle: headersComplete && backfill.attempted === 0
  }
}

async function tick(): Promise<void> {
  if (running || backedOff) return
  const config = getFull()
  if (!config) return
  running = true
  try {
    await sweepOnce(config)
  } catch {
    // A sweep failing is usually the machine being offline, which will pass. But
    // it can also be the server refusing — and retrying every 90 seconds into a
    // rate limit is how an account gets locked. Stand down for the session; the
    // user's own listings still fill the store meanwhile, and the next launch
    // tries again.
    backedOff = true
  } finally {
    running = false
  }
}

/** Sweep in the background: once shortly after boot, then on a slow cadence. */
export function startMailSyncLoop(): void {
  if (timer) return
  backedOff = false
  setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS)
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS)
}

export function stopMailSyncLoop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export interface MailSyncProgress {
  connected: boolean
  messages: number
  withBodies: number
  attachments: number
  headersComplete: boolean
  oldestDate: number | null
  newestDate: number | null
  backedOff: boolean
}

/**
 * What the sweep has actually covered.
 *
 * Exists so the app can answer "why doesn't Plexii know about that email?" with a
 * fact instead of a shrug — and so an answer can say "I have read 1,240 of your
 * messages back to March" rather than implying it searched everything.
 */
export function mailSyncProgress(): MailSyncProgress {
  const config = getFull()
  if (!config) {
    return {
      connected: false,
      messages: 0,
      withBodies: 0,
      attachments: 0,
      headersComplete: false,
      oldestDate: null,
      newestDate: null,
      backedOff
    }
  }
  const accountKey = accountKeyOf(config)
  const stats = mailStoreStats(db(), { accountKey })
  const state = getMailSyncState(db(), { accountKey })
  return {
    connected: true,
    messages: stats.messages,
    withBodies: stats.withBodies,
    attachments: stats.attachments,
    headersComplete: state.headersComplete,
    oldestDate: stats.oldestDate,
    newestDate: stats.newestDate,
    backedOff
  }
}
