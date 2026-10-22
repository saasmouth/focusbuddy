// E2E: PlexiiBrain answers on the on-device model (owner, 4.3.40): "It returned
// an answer, but also this warning: 'The on-device model could not produce a
// reply for this request (no JSON object was found)…'".
//
// Reproduced on the bundled model with this exact set-up: fifteen long
// handbook documents and a question that wants a long answer. The retrieved
// passages were packed to a cloud budget, filled the 16k-token window, the
// streamed answer ran out of room, the retry could not fit at all, and the
// empty retry was reported as "no JSON object was found" next to the answer.
// Now retrieval is sized to the on-device window, so the answer finishes.
//
// Needs the real model: LOCAL_AI_E2E_MODEL=<the catalog GGUF> (the dev tree's
// staged resources/models is used as the app bundle). Throwaway profile, no
// keys, nothing sent anywhere.
import { test, expect } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { checkInventedSpecifics } from '../../src/main/ai/inventedSpecifics'

const MODEL = process.env.LOCAL_AI_E2E_MODEL
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

function handbook(part: number): string {
  return Array.from(
    { length: 14 },
    (_, i) =>
      `Section ${i + 1} of the H${part} handbook. Refunds within 30 days of delivery are paid in full to the original payment method within 5 business days; after 30 days the customer receives store credit only. ` +
      `Orders shipped to Australia, New Zealand or the United Kingdom use standard shipping, which is free over $80; express shipping in Australia costs $15 and arrives in 2 business days. ` +
      `The support desk is staffed Monday to Friday, 9am to 5pm Sydney time, and urgent outages page the on-call engineer. Case H${part}-${i + 1}: a customer asked about a damaged parcel and was offered a replacement or a refund, at their choice.`
  ).join('\n\n')
}

test('LBA-1 — PlexiiAssist over fifteen long documents: the prompt leaves the answer room, it finishes, no warning beside it', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(600_000)
  // The raw-output trace (PLEXII_LOCAL_AI_TRACE) says how much of the window
  // the prompt took: whether an answer fits must not depend on the model
  // happening to write a short one (at e20ce2f6 it took 15,712 of 16,384).
  const trace = join(mkdtempSync(join(tmpdir(), 'plexii-lba-')), 'trace.jsonl')
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PLEXII_LOCAL_AI_TRACE: trace } })
  const { window } = launched
  await waitForReady(window)
  const st = await window.evaluate(() => window.api.localAi.getStatus())
  test.skip(!st.tiers.some((t) => t.source !== null), 'the dev tree has no staged model (resources/models)')
  await expect.poll(async () => (await window.evaluate(() => window.api.localAi.getStatus())).provider, { timeout: 120_000 }).toBe('local')

  await window.evaluate(async (texts) => {
    for (let d = 0; d < texts.length; d++) {
      const content = texts[d].split('\n\n').map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] }))
      await window.api.documents.create({ docType: 'doc', title: `Customer handbook part ${d + 1}`, body: { type: 'doc', content } })
    }
  }, Array.from({ length: 15 }, (_, d) => handbook(d + 1)))

  const question =
    'Go through each customer handbook part one by one and explain, in full detail with a heading for each part, what it says about refunds, shipping, support hours and the customer cases it records.'
  const r = await window.evaluate(async (q) => {
    const out: { deltas: number; error?: string; ok?: boolean; content?: string } = { deltas: 0 }
    await new Promise<void>((resolve) => {
      window.api.chat.sendStream(
        { requestId: `lba-${Date.now()}`, taskId: null, messages: [{ role: 'user', content: q, ts: Date.now() } as never], supportsQuestions: true, includeMemory: true },
        {
          onReplyDelta: () => void out.deltas++,
          onError: (e) => {
            out.error = e.error
            resolve()
          },
          onComplete: (resp) => {
            out.ok = resp.ok
            out.content = (resp as { message?: { content?: string } }).message?.content
            resolve()
          }
        }
      )
    })
    return out
  }, question)
  expect(r.error, 'no failure beside the answer').toBeUndefined()
  expect(r.ok).toBe(true)
  // eslint-disable-next-line no-console
  console.log(`[answer-length] LBA-1 handbook walk-through: ${(r.content ?? '').length} characters`)
  expect(r.content ?? '').toMatch(/refund/i)
  const chat = readFileSync(trace, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { contract: string | null; first: { inputTokens: number } })
    .find((e) => e.contract === 'chat-envelope')
  expect(chat, 'the chat call was traced').toBeTruthy()
  expect(16384 - chat!.first.inputTokens, 'room left for the answer').toBeGreaterThanOrEqual(2048)
})

test('LBA-2 — PlexiSearch Ask (the PlexiiBrain answer contract) over the same documents', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(600_000)
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } })
  const { window } = launched
  await waitForReady(window)
  const st = await window.evaluate(() => window.api.localAi.getStatus())
  test.skip(!st.tiers.some((t) => t.source !== null), 'the dev tree has no staged model (resources/models)')
  await expect.poll(async () => (await window.evaluate(() => window.api.localAi.getStatus())).provider, { timeout: 120_000 }).toBe('local')
  await window.evaluate(async (texts) => {
    for (let d = 0; d < texts.length; d++) {
      const content = texts[d].split('\n\n').map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] }))
      await window.api.documents.create({ docType: 'doc', title: `Customer handbook part ${d + 1}`, body: { type: 'doc', content } })
    }
  }, Array.from({ length: 15 }, (_, d) => handbook(d + 1)))
  const a = await window.evaluate(() => window.api.workspace.ask('What happens to a refund after 30 days?'))
  expect(a.error, 'no failure').toBeUndefined()
  expect(a.ok).toBe(true)
  // eslint-disable-next-line no-console
  console.log(`[answer-length] LBA-2 PlexiSearch Ask: ${(a.answer ?? '').length} characters`)
  expect(a.answer ?? '').toMatch(/store credit/i)
})

// ── Grounding (4.3.41): the "Support is open 24/7" repro ─────────────────────
// Only the refund policy is in the workspace; the question also asks when
// support is open. The on-device model answered "Support is open 24/7, as
// stated in the policy [1]". Now the answer may state nothing the policy does
// not say, and must say the gap instead.
const REFUND =
  'Customers can return any product within 30 days of delivery for a full refund. After 30 days we offer store credit only. Refunds go back to the original payment method within 5 business days.'
const GAP_QUESTION = 'What is our refund policy after 30 days, and when is support open?'
const SAYS_GAP = /\b(?:don'?t|do not|doesn'?t|does not)\b|\bnot (?:mention|say|specif|includ|cover|stat|provid|given|listed|found)|not in your documents/i

async function bootWithRefundOnly(): Promise<LaunchedApp['window']> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } })
  const { window } = launched
  await waitForReady(window)
  const st = await window.evaluate(() => window.api.localAi.getStatus())
  test.skip(!st.tiers.some((t) => t.source !== null), 'the dev tree has no staged model (resources/models)')
  await expect.poll(async () => (await window.evaluate(() => window.api.localAi.getStatus())).provider, { timeout: 120_000 }).toBe('local')
  await window.evaluate((body) => window.api.knowledge.create({ title: 'Refund policy', body, tags: ['support'] }), REFUND)
  return window
}
/** High-confidence specifics the answer states that neither the policy nor the question gives. */
const unsupported = (answer: string): string[] =>
  checkInventedSpecifics(answer, [REFUND, GAP_QUESTION], { minConfidence: 'high' }).flagged.map((f) => f.span)

test('LBA-3 — PlexiiAssist: no invented opening hours; the gap is said plainly', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(300_000)
  const window = await bootWithRefundOnly()
  const r = await window.evaluate(async (q) => {
    const out: { error?: string; content?: string } = {}
    await new Promise<void>((resolve) => {
      window.api.chat.sendStream(
        { requestId: `lba3-${Date.now()}`, taskId: null, messages: [{ role: 'user', content: q, ts: Date.now() } as never], supportsQuestions: true, includeMemory: true },
        {
          onError: (e) => {
            out.error = e.error
            resolve()
          },
          onComplete: (resp) => {
            out.content = (resp as { message?: { content?: string } }).message?.content
            resolve()
          }
        }
      )
    })
    return out
  }, GAP_QUESTION)
  // eslint-disable-next-line no-console
  console.log(`[answer] LBA-3: ${JSON.stringify(r.content)}`)
  expect(r.error).toBeUndefined()
  const answer = r.content ?? ''
  expect(answer).toMatch(/store credit/i) // the part the documents cover is still answered
  expect(unsupported(answer), 'no specific the documents do not give').toEqual([])
  expect(answer).not.toMatch(/24\/7|around the clock|24 hours/i)
  expect(answer, 'the gap is stated').toMatch(SAYS_GAP)
})

test('LBA-4 — PlexiSearch Ask: the same, on the PlexiiBrain answer contract', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(300_000)
  const window = await bootWithRefundOnly()
  const a = await window.evaluate((q) => window.api.workspace.ask(q), GAP_QUESTION)
  // eslint-disable-next-line no-console
  console.log(`[answer] LBA-4: ${JSON.stringify(a.answer)}`)
  expect(a.ok).toBe(true)
  const answer = a.answer ?? ''
  expect(answer).toMatch(/store credit/i)
  expect(unsupported(answer)).toEqual([])
  expect(answer).toMatch(SAYS_GAP)
})

test('LBA-5 — a well-supported question still gets a full answer (length logged)', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(300_000)
  const window = await bootWithRefundOnly()
  const a = await window.evaluate(() => window.api.workspace.ask('Explain our refund policy in full: what happens within 30 days, after 30 days, and how refunds are paid.'))
  // eslint-disable-next-line no-console
  console.log(`[answer-length] LBA-5 well-supported: ${(a.answer ?? '').length} characters: ${JSON.stringify(a.answer)}`)
  expect(a.ok).toBe(true)
  const answer = a.answer ?? ''
  for (const fact of [/full refund/i, /store credit/i, /5 business days|five business days/i]) expect(answer).toMatch(fact)
  expect(a.grounding, 'nothing to mark in a grounded answer').toBeUndefined()
})
