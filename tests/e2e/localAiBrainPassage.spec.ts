// E2E: "PlexiiBrain ranks by passage" on the REAL on-device model.
//
// Owner check (4.3.41): Settings › AI › "Local on this device", ask PlexiiBrain
// about something deep inside a long document. Expected: Settings shows
// "Passages ranked by meaning: X of Y", the search line shows "· N% ranked by
// meaning", the answer finds the right passage, and NO warning beside it
// ("The on-device model could not produce a reply for this request (no JSON
// object was found)…" was what the owner saw).
//
// One long document (several thousand words) with a specific fact deep inside,
// plus a few short ones. The fact is asked through every PlexiiBrain entry
// point that reaches the model: PlexiiAssist (streamed, the panel's path and
// the Focus chat's), PlexiiAssist non-streamed (its fallback), PlexiSearch Ask
// (the JSON answer contract, plus the "create from this" proposals step), Ask
// your workspace (streamed prose) in both scopes. Raw on-device output is
// recorded through PLEXII_LOCAL_AI_TRACE so a failure names the call.
//
// Needs the real model: LOCAL_AI_E2E_MODEL=<the catalog GGUF> (the dev tree's
// staged resources/models is used as the app bundle). Throwaway profile, no
// keys, nothing sent anywhere.
import { test, expect } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const MODEL = process.env.LOCAL_AI_E2E_MODEL
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

// The deep fact. Its passage shares no rare word with the question except the
// site name, so only the passage that holds it can answer.
const FACT =
  'The standby diesel generator at the Ballarat distribution centre is maintained by Kestrel Power Systems, who service it every fourteen weeks under contract KP-88213.'
const QUESTION = 'Who looks after the backup power generator at our Ballarat site, and how often is it serviced?'
const FACT_IN_ANSWER = [/Kestrel/i, /fourteen|14/i]

const TOPICS = [
  ['Receiving', 'Inbound pallets are checked against the advance shipping notice, photographed, and any damage is logged before the driver leaves the dock.'],
  ['Putaway', 'Fast-moving lines go to the golden zone between knee and shoulder height; slow movers go to the upper racking, which only the reach truck may serve.'],
  ['Picking', 'Pickers work in waves released every forty minutes, and a short pick is reported on the handheld so the replenishment team can top up the face.'],
  ['Packing', 'Every parcel is weighed at the pack bench; a variance over five per cent sends it to the exceptions table for a second check.'],
  ['Dispatch', 'Carrier cut-offs are printed on the board above lane three, and a late trailer is escalated to the shift lead rather than held at the door.'],
  ['Returns', 'Returned goods are graded A, B or C on arrival; grade C goes to the recycler on the first Monday of each month.'],
  ['Safety', 'High-visibility vests are worn on the floor at all times, and the forklift aisles are marked in yellow and kept clear of pallets.'],
  ['Cleaning', 'The mezzanine is swept at the end of every shift and the dock levellers are inspected for debris each morning.'],
  ['Inventory', 'Cycle counts run every Tuesday and Thursday, rotating through the racking so every location is counted at least once a quarter.'],
  ['Training', 'New starters shadow an experienced picker for three days before they are given their own handheld and wave.'],
  ['Security', 'Visitors sign in at reception, wear a lanyard, and are escorted beyond the yellow line on the warehouse floor.'],
  ['Rostering', 'The roster is published two weeks ahead, and shift swaps are approved by the shift lead through the rostering app.']
]

/** A long operations manual (~6,000 words) with FACT about 85% of the way in. */
function longManual(): string[] {
  const paras: string[] = []
  for (let round = 0; round < 7; round++) {
    for (const [topic, rule] of TOPICS) {
      paras.push(
        `${topic}, part ${round + 1}. ${rule} Team members should raise anything unusual with the shift lead, record it in the shift log, and ` +
          `follow the standard operating procedure for ${topic.toLowerCase()} that applies at every site in the network. The procedure is reviewed each ` +
          `quarter by the operations manager and any change is briefed at the start of the next shift so nobody works from an old version.`
      )
    }
  }
  // Deep inside: after ~85% of the manual.
  const at = Math.floor(paras.length * 0.85)
  paras.splice(at, 0, `Site services. ${FACT} The contract covers parts and labour, and the service report is filed with facilities.`)
  return paras
}

const OTHERS: Array<{ title: string; paras: string[] }> = [
  { title: 'Holiday calendar', paras: ['The office closes between Christmas and New Year. Public holidays follow the state calendar.'] },
  { title: 'Brand guidelines', paras: ['Use the reversed logo on dark backgrounds. Headlines are set in sentence case.'] },
  { title: 'IT onboarding', paras: ['New laptops are imaged by IT before the first day. Passwords are reset on first sign-in.'] }
]

interface TraceLine {
  purpose: string
  contract: string | null
  shape: string | null
  ok: boolean
  problem?: string
  retryProblem?: string
  first: { text: string; stopReason: string; inputTokens: number; outputTokens: number }
  retry?: { text: string; stopReason: string }
}
function readTrace(file: string): TraceLine[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceLine)
}
const NO_JSON = /no JSON|could not produce|could not write|did not come out|unusable/i

async function boot(trace: string): Promise<LaunchedApp['window']> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PLEXII_LOCAL_AI_TRACE: trace } })
  const { window } = launched
  await waitForReady(window)
  const st = await window.evaluate(() => window.api.localAi.getStatus())
  test.skip(!st.tiers.some((t) => t.source !== null), 'the dev tree has no staged model (resources/models)')
  // Settings › AI › "Local on this device".
  await window.evaluate(() => window.api.ai.setMode('local'))
  await expect.poll(async () => (await window.evaluate(() => window.api.localAi.getStatus())).provider, { timeout: 120_000 }).toBe('local')
  await window.evaluate(
    async ({ manual, others }) => {
      const doc = (paras: string[]) => ({ type: 'doc', content: paras.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) })
      await window.api.documents.create({ docType: 'doc', title: 'Warehouse operations manual', body: doc(manual) })
      for (const o of others) await window.api.documents.create({ docType: 'doc', title: o.title, body: doc(o.paras) })
    },
    { manual: longManual(), others: OTHERS }
  )
  return window
}

test('LBP-1 — a deep fact in a long document, through every PlexiiBrain entry point: right passage, no warning, indicators sane', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(900_000)
  const trace = join(mkdtempSync(join(tmpdir(), 'plexii-lbp-')), 'trace.jsonl')
  const window = await boot(trace)
  const words = longManual().join(' ').split(/\s+/).length
  // eslint-disable-next-line no-console
  console.log(`[lbp] long document: ${words} words`)
  expect(words).toBeGreaterThan(4000)

  // The long document's passages get vectors from the bundled nomic model.
  let cov = await window.evaluate(() => window.api.localAi.coverage())
  await expect
    .poll(
      async () => {
        cov = await window.evaluate(() => window.api.localAi.coverage())
        return cov.passages ? cov.passages.usable === cov.passages.total && cov.passages.total > 0 : false
      },
      { timeout: 240_000, intervals: [2_000] }
    )
    .toBe(true)
  // eslint-disable-next-line no-console
  console.log(`[lbp] coverage: ${JSON.stringify(cov)}`)
  expect(cov.meaningModel ?? '').toMatch(/nomic/i)
  // The long document is many passages, not one vector.
  expect(cov.passages!.total).toBeGreaterThan(10)

  const results: Record<string, { answer: string; error?: string; coverage?: number | null; sources?: string[] }> = {}

  // 1. PlexiiAssist, streamed (the panel, the Focus chat, "Ask PlexiiBrain").
  results.assistStream = await window.evaluate(async (q) => {
    const out: { answer: string; error?: string; coverage?: number | null; sources?: string[] } = { answer: '' }
    await new Promise<void>((resolve) => {
      window.api.chat.sendStream(
        { requestId: `lbp-${Date.now()}`, taskId: null, messages: [{ role: 'user', content: q, ts: Date.now() } as never], supportsQuestions: true, includeMemory: true },
        {
          onSources: (t) => {
            out.coverage = (t as { semanticCoverage?: number | null }).semanticCoverage ?? null
            out.sources = t.sources.map((s) => s.title)
          },
          onError: (e) => {
            out.error = e.error
            resolve()
          },
          onComplete: (resp) => {
            out.answer = (resp as { message?: { content?: string } }).message?.content ?? ''
            if (!resp.ok) out.error = (resp as { error?: string }).error
            resolve()
          }
        }
      )
    })
    return out
  }, QUESTION)

  // 2. PlexiiAssist, non-streamed (chat:send, the fallback path).
  results.assistSend = await window.evaluate(async (q) => {
    const r = await window.api.chat.send({ taskId: null, messages: [{ role: 'user', content: q, ts: Date.now() } as never] } as never)
    return { answer: r.message?.content ?? '', error: r.ok ? undefined : r.error, sources: (r.sources ?? []).map((s) => s.title) }
  }, QUESTION)

  // 3. PlexiSearch Ask (askWorkspace: the JSON answer contract + proposals).
  results.plexiSearchAsk = await window.evaluate(async (q) => {
    const r = await window.api.workspace.ask(q)
    return { answer: r.answer ?? '', error: r.ok ? undefined : r.error, sources: (r.sources ?? []).map((s) => s.title) }
  }, QUESTION)

  // 4. Ask your workspace (document editor), workspace scope, streamed prose.
  results.askWorkspace = await window.evaluate(async (q) => {
    const r = await window.api.workspace.askStream(q, [], `lbp-ws-${Date.now()}`, () => undefined, null)
    return { answer: r.answer ?? '', error: r.ok ? undefined : r.error, sources: (r.sources ?? []).map((s) => s.title) }
  }, QUESTION)

  // 5. Ask your workspace, "This document" scope, on the long document itself.
  results.askThisDocument = await window.evaluate(
    async ({ q, text }) => {
      const r = await window.api.workspace.askStream(q, [], `lbp-doc-${Date.now()}`, () => undefined, { title: 'Warehouse operations manual', text })
      return { answer: r.answer ?? '', error: r.ok ? undefined : r.error }
    },
    { q: QUESTION, text: longManual().join('\n\n') }
  )

  const lines = readTrace(trace)
  // eslint-disable-next-line no-console
  console.log(`[lbp] results: ${JSON.stringify(results, null, 1)}`)
  for (const l of lines) {
    // eslint-disable-next-line no-console
    console.log(
      `[lbp-trace] purpose=${l.purpose} contract=${l.contract} shape=${l.shape} ok=${l.ok} in=${l.first.inputTokens} out=${l.first.outputTokens} stop=${l.first.stopReason}` +
        (l.problem ? ` problem=${l.problem}` : '') +
        (l.retryProblem ? ` retryProblem=${l.retryProblem}` : '') +
        ` first=${JSON.stringify(l.first.text.slice(0, 600))}` +
        (l.retry ? ` retry=${JSON.stringify(l.retry.text.slice(0, 400))}` : '')
    )
  }

  for (const [entry, r] of Object.entries(results)) {
    expect.soft(r.error, `${entry}: no failure`).toBeUndefined()
    expect.soft(r.answer, `${entry}: no internal warning in the answer`).not.toMatch(NO_JSON)
    for (const re of FACT_IN_ANSWER) expect.soft(r.answer, `${entry}: the deep fact is found`).toMatch(re)
  }
  // The search line: a sane share of the workspace ranked by meaning. Every
  // document here holds passage vectors, so all of it was (0% at 37115bfb).
  expect(typeof results.assistStream.coverage).toBe('number')
  expect(results.assistStream.coverage!).toBeGreaterThan(0)
  expect(results.assistStream.coverage!).toBeLessThanOrEqual(1)

  // And on screen, as the owner asks it: the PlexiiAssist panel, typed.
  await window.evaluate(() => window.api.localAi.dismissIntro())
  await window.evaluate(() => {
    const w = window as unknown as { __fbAssistantChrome?: { getState: () => { openPanel: () => void; setMode: (m: string) => void; setTab: (t: string) => void } } }
    const st = w.__fbAssistantChrome?.getState()
    st?.setMode('sidebar')
    st?.setTab('chat')
    st?.openPanel()
  })
  const panel = window.locator('[data-testid="assistant-panel"]')
  await expect(panel).toBeVisible()
  const composer = panel.locator('[data-testid="chat-composer"]').first()
  await composer.click()
  await window.keyboard.type(QUESTION, { delay: 2 })
  await window.keyboard.press('Enter')
  await expect(panel).toContainText('Kestrel', { timeout: 300_000 })
  const searchLine = panel.locator('[data-testid="assistant-trace"]').last()
  await expect(searchLine).toContainText(/Searched your workspace · \d+ sources? · \d+ms · \d{1,3}% ranked by meaning/, { timeout: 30_000 })
  await expect(panel).not.toContainText(NO_JSON)
  // eslint-disable-next-line no-console
  console.log(`[lbp] panel trace: ${JSON.stringify(((await searchLine.textContent()) ?? '').slice(0, 300))}`)
})

test('LBP-2 — Settings shows "Passages ranked by meaning: X of Y" and it fills in after indexing', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
  test.setTimeout(600_000)
  const trace = join(mkdtempSync(join(tmpdir(), 'plexii-lbp-')), 'trace.jsonl')
  const window = await boot(trace)
  // The intro card sits over the foot of the window; dismiss it without
  // changing the source (chooseCloudAiSource would switch it to cloud).
  await window.evaluate(() => window.api.localAi.dismissIntro())
  const intro = window.locator('[data-testid="local-ai-intro-dismiss"]')
  if (await intro.isVisible().catch(() => false)) await intro.click({ timeout: 2_000 }).catch(() => undefined)
  // Settings › AI › "Local on this device", as the owner does it. The panel is
  // opened BEFORE the passages are embedded: the count must fill in by itself.
  await window.getByRole('button', { name: /appearance settings/i }).click()
  await expect(window.locator('[role="dialog"][aria-label="Settings"]').first()).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="settings-tab-ai"]').click()
  await window.locator('[data-testid="ai-mode-local"]').click()
  await expect(window.locator('[data-testid="ai-mode-local"]')).toHaveAttribute('aria-pressed', 'true')
  const passages = window.getByTestId('brain-coverage-passages')
  await expect(passages).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(async () => {
      const t = (await passages.textContent()) ?? ''
      const m = /(\d+)\s*of\s*(\d+)/.exec(t)
      return m ? Number(m[1]) > 0 && m[1] === m[2] : false
    }, { timeout: 240_000, intervals: [3_000] })
    .toBe(true)
})

// What the owner actually saw on 4.3.41. The sentence in the check is the
// 4.3.40 template ("could not produce … (no JSON object was found)"), which
// 4.3.41 has no code to write: it was SAVED with two PlexiiAssist turns on
// 2026-10-22, before 4.3.41 was built, and every reopening of those
// conversations shows it again beside the saved answer. Needs no model.
const SAVED_4340_WARNING =
  'The on-device model could not produce a reply for this request (no JSON object was found). Nothing was sent anywhere. Try again, rephrase it, or use your own key for PlexiiAssist and PlexiiBrain answers in Settings → AI.'

test('LBP-3 — a conversation saved by 4.3.40 with the warning reopens without the parser detail', async () => {
  test.setTimeout(120_000)
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } })
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(async (warning) => {
    const conv = await window.api.aiChat.createConversation({ taskId: null, title: 'Generator servicing' })
    const t = Date.now() - 86_400_000
    await window.api.aiChat.appendMessage(conv.id, { role: 'user', content: 'Who services the Ballarat generator?', ts: t })
    await window.api.aiChat.appendMessage(conv.id, {
      role: 'assistant',
      content: 'Kestrel Power Systems services it every fourteen weeks [1].',
      ts: t + 1,
      trace: { sources: [{ n: 1, docId: 'd1', title: 'Warehouse operations manual', docType: 'doc', snippet: '' }], tools: [], mentions: [], retrievalMs: 20, error: warning, semantic: true, semanticCoverage: 1 }
    })
    // A turn that failed before any prose saved the warning as its text.
    await window.api.aiChat.appendMessage(conv.id, { role: 'user', content: 'And the contract number?', ts: t + 2 })
    await window.api.aiChat.appendMessage(conv.id, {
      role: 'assistant',
      content: warning,
      ts: t + 3,
      trace: { sources: [], tools: [], mentions: [], retrievalMs: 20, error: warning, semantic: true, semanticCoverage: 1 }
    })
  }, SAVED_4340_WARNING)
  await window.evaluate(() => {
    const w = window as unknown as { __fbAssistantChrome?: { getState: () => { openPanel: () => void; setMode: (m: string) => void; setTab: (t: string) => void } } }
    const st = w.__fbAssistantChrome?.getState()
    st?.setMode('sidebar')
    st?.setTab('chat')
    st?.openPanel()
  })
  const panel = window.locator('[data-testid="assistant-panel"]')
  await expect(panel).toBeVisible()
  await window.locator('[data-testid="assistant-history-toggle"]').click()
  await window.locator('[data-testid="conversation-overlay"] [data-testid="conversation-row"]').first().click()
  await expect(panel).toContainText('Kestrel Power Systems')
  // The failure is still told, in plain words; the parser's reason is not.
  await expect(panel).toContainText('could not write a reply this time')
  await expect(panel).not.toContainText(/no JSON|could not produce/)
  // eslint-disable-next-line no-console
  console.log(`[lbp-3] panel: ${JSON.stringify(((await panel.textContent()) ?? '').slice(0, 1200))}`)
})
