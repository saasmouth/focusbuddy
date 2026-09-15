// AI reply orchestration — ties the Sent-folder sampling (IMAP) to the tone
// profiler and reply drafter (Anthropic). Everything that reaches the model is
// sanitised here first: quoted prior thread removed, signatures and boilerplate
// footers stripped, and email addresses and phone numbers redacted. The tone
// profile is learned once per session from the user's own sent mail and cached,
// so only the cheap reply-draft call runs on each email open.

import type { MailAccountConfig } from './mailAccount'
import { sampleSent } from './imap'
import { buildToneProfile, draftReply } from '../ai/anthropic'
import { sanitizeBody } from './sanitizeBody'
import type { EmailReplyDraftResult } from '@shared/types'

// Cached style descriptor for this session, plus a flag that the user simply
// does not have enough sent history to model — so we don't re-sample the Sent
// folder on every single email open once we've learned there's too little.
let toneCache: string | null = null
let tooLittleHistory = false

/** Forget the learned style. Call on account change or key rotation. */
export function resetToneCache(): void {
  toneCache = null
  tooLittleHistory = false
}

// Learn (or reuse) the user's writing style. Returns null when we genuinely
// cannot — too little history, or an AI/IMAP error — in which case the drafter
// falls back to a neutral-professional voice. API errors are NOT cached, so a
// later key fix or transient blip gets retried on the next open.
async function ensureToneProfile(config: MailAccountConfig): Promise<string | null> {
  if (toneCache) return toneCache
  if (tooLittleHistory) return null
  let raw: string[]
  try {
    raw = await sampleSent(config, 20)
  } catch {
    return null
  }
  const samples = raw.map(sanitizeBody).filter((s) => s.length > 20)
  if (samples.length < 3) {
    tooLittleHistory = true
    return null
  }
  const r = await buildToneProfile(samples)
  if (r.ok) {
    toneCache = r.profile
    return toneCache
  }
  return null
}

/**
 * Draft a reply to one incoming email in the user's voice. Builds the tone
 * profile on first use, then drafts. The incoming body is sanitised before it
 * reaches the model.
 */
export async function suggestReply(
  config: MailAccountConfig,
  incoming: { subject: string; from: string; body: string },
  /** Earlier messages in the same conversation, oldest first. */
  trail?: Array<{ from: string; date?: number; body: string }>
): Promise<EmailReplyDraftResult> {
  const profile = await ensureToneProfile(config)
  return draftReply(
    {
      subject: incoming.subject,
      from: incoming.from,
      body: sanitizeBody(incoming.body)
    },
    profile,
    // The trail goes through the same sanitiser as the incoming body: quoted
    // blocks and signatures are noise that crowds out the actual exchange.
    trail?.map((m) => ({ ...m, body: sanitizeBody(m.body) }))
  )
}
