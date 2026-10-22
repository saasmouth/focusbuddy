// E2E (owner, 4.3.41): a reopened chat keeps its "check this" marks.
//
// The marks are what the grounding check found in an answer: specifics its
// sources do not support (a2f5d94a). They lived only in memory, so after a
// reload the conversation reopened without them. Now they are saved with the
// turn and restored exactly as saved, never recomputed.
//
// The whole real path runs: a stand-in for the Claude API (_fakeClaude)
// streams an answer that states an opening time nothing supports; the real
// grounding check marks it; the turn is saved; the app reloads; the
// conversation is reopened and the same marks must be on screen.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, typeInComposer, type LaunchedApp } from './_helpers'
import { startFakeClaude, type FakeClaude } from './_fakeClaude'

let launched: LaunchedApp | null = null
let fake: FakeClaude | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
  await fake?.close()
  fake = null
})

const ANSWER = 'Refunds after 30 days are given as store credit. Support is open 24/7.'

async function marks(window: LaunchedApp['window']): Promise<{ spans: string[]; summary: string }> {
  const panel = window.locator('[data-testid="assistant-panel"]')
  return {
    spans: await panel.locator('[data-testid="check-this"]').allInnerTexts(),
    summary: (await panel.locator('[data-testid="check-this-summary"]').allInnerTexts()).join(' ')
  }
}

test('CG-1 — the "check this" marks on an answer are still there after the app reloads', async () => {
  test.setTimeout(120_000)
  fake = await startFakeClaude({ text: JSON.stringify({ reply: ANSWER, actions: [] }), shortText: 'Support hours' })
  launched = await launchApp({ env: { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-e2e-fake', OPENAI_API_KEY: '' } })
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window, 'byok')

  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  await expect(window.locator('[data-testid="assistant-panel"]')).toBeVisible({ timeout: 8000 })
  await typeInComposer(window, 'What is our refund policy after 30 days, and when is support open?')
  await window.locator('button[aria-label="Send"]').click()

  // The real check marks the opening time nothing supports.
  const panel = window.locator('[data-testid="assistant-panel"]')
  await expect(panel.locator('[data-testid="check-this"]').first()).toBeVisible({ timeout: 20_000 })
  const before = await marks(window)
  expect(before.spans.join(' ')).toContain('24/7')
  expect(before.summary).not.toBe('')

  // Saved with the turn (wait for the write), then reload.
  const convId = await expect
    .poll(async () => window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const list = await api.aiChat.listConversations()
      if (!list[0]) return null
      const conv = await api.aiChat.getConversation(list[0].id)
      return conv?.messages.some((m) => m.role === 'assistant' && m.grounding) ? list[0].id : null
    }), { timeout: 10_000 })
    .not.toBeNull()
    .then(() => window.evaluate(async () => (await (window as unknown as { api: typeof window.api }).api.aiChat.listConversations())[0].id))

  const requestsBeforeReload = fake.requests.length
  console.log('[CG-1] streamed requests before reload:', requestsBeforeReload, JSON.stringify(fake.requests.map((r) => {
    const b = r as { system?: unknown; messages?: Array<{ content?: unknown }> }
    return { system: JSON.stringify(b.system ?? '').slice(0, 80), last: JSON.stringify(b.messages?.at(-1)?.content ?? '').slice(0, 80) }
  })))
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  await expect(panel).toBeVisible({ timeout: 8000 })
  await window.evaluate(async (id) => {
    const s = (window as unknown as { __fbChat: { getState: () => { openConversation: (x: string) => Promise<void> } } }).__fbChat
    await s.getState().openConversation(id)
  }, convId)
  await expect(panel).toContainText('store credit', { timeout: 8000 })

  // The same marks, from what was saved: nothing recomputed, nothing added.
  await expect(panel.locator('[data-testid="check-this"]').first()).toBeVisible({ timeout: 8000 })
  const after = await marks(window)
  expect(after).toEqual(before)
  // Reopening asked the model nothing: no answer was recomputed.
  expect(fake.requests.length).toBe(requestsBeforeReload)
})
