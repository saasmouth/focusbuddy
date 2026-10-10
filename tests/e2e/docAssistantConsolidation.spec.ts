/**
 * Assistant consolidation (main app): ONE assistant. The doc side panel keeps
 * Comments + Outline (no in-panel AI tab); the doc assistant control opens the
 * single global overlay, which can insert its answers into the open document; and
 * a non-office proposal (a table) applied off a desk offers to create or pick a
 * desk, then applies there.
 */
import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea, openDocSidePanel } from './_helpers'

test.describe('one assistant — in a document', () => {
  let app: LaunchedApp
  let window: Page
  test.beforeAll(async () => { app = await launchApp(); window = app.window; await waitForReady(window) })
  test.afterAll(async () => { await app.dispose() })

  test('doc panel has no AI tab; the assistant control opens the one overlay', async () => {
    await switchArea(window, 'office')
    await window.locator('[data-testid="office-app-docs"]').click()
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
    await openDocSidePanel(window)
    await expect(window.locator('[data-testid="doc-tab-ai"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="doc-tab-comments"]')).toBeVisible()
    await expect(window.locator('[data-testid="doc-tab-outline"]')).toBeVisible()
    await window.locator('[data-testid="doc-assistant-toggle"]').click()
    await expect(window.locator('[data-testid="assistant-overlay"]')).toBeVisible({ timeout: 6_000 })
  })

  test('the assistant can insert an answer into the open document', async () => {
    // A doc is open from the previous test; the overlay is open. Switch to Chat and
    // seed an assistant turn, then insert it into the doc.
    await window.locator('[data-testid="assistant-tab-chat"]').click()
    await window.evaluate(() => {
      const store = (window as unknown as { __docEditor?: { commands: { setContent: (h: string) => void } } }).__docEditor
      store?.commands.setContent('<p>Report:</p>')
      const chat = (window as unknown as { __fbChat?: { getState: () => { messagesByTask: Record<string, unknown[]> }; setState: (p: unknown) => void } }).__fbChat
      if (!chat) return
      // A fresh overlay's thread is keyed by the conversation ('__new__'), and the
      // test workspace has no API key, so unblock the list and seed the turn there.
      const s = chat.getState()
      chat.setState({
        hasApiKey: true,
        messagesByTask: { ...s.messagesByTask, __new__: [{ role: 'assistant', content: 'INSERTED_BY_ASSISTANT_MARKER', ts: 1755000000001 }] }
      })
    })
    const insertBtn = window.locator('[data-testid="turn-insert-doc"]').last()
    await expect(insertBtn).toBeVisible({ timeout: 6_000 })
    await insertBtn.click()
    await window.waitForTimeout(300)
    await expect(window.locator('[data-testid="doc-editor-surface"]')).toContainText('INSERTED_BY_ASSISTANT_MARKER')
  })
})

test.describe('one assistant — a non-office proposal off a desk', () => {
  let app: LaunchedApp
  let window: Page
  test.beforeAll(async () => { app = await launchApp(); window = app.window; await waitForReady(window) })
  test.afterAll(async () => { await app.dispose() })

  test('applying a table off a desk offers to create or pick a desk', async () => {
    // Fresh app on the workspace home (no active desk). Open the one overlay's Chat.
    await window.locator('[data-testid="assistant-pill"]').click().catch(() => {})
    await window.locator('[data-testid="assistant-tab-chat"]').click()
    // Seed an assistant turn carrying a create-table proposal on the fresh thread.
    await window.evaluate(() => {
      const chat = (window as unknown as { __fbChat?: { getState: () => { messagesByTask: Record<string, unknown[]>; proposalsByMessage: Record<string, unknown[]> }; setState: (p: unknown) => void } }).__fbChat
      if (!chat) return
      const ts = 1755000000000
      const s = chat.getState()
      chat.setState({
        hasApiKey: true,
        messagesByTask: { ...s.messagesByTask, __new__: [{ role: 'assistant', content: 'Here is a tracker table.', ts }] },
        proposalsByMessage: {
          ...s.proposalsByMessage,
          [String(ts)]: [{ id: 'p-tbl-1', kind: 'create-table', title: 'Tracker', columns: [{ label: 'Name', type: 'text-short' }], reason: 'test' }]
        }
      })
    })
    await expect(window.locator('[data-testid="proposal-card-p-tbl-1"]')).toBeVisible({ timeout: 6_000 })
    await window.locator('[data-testid="proposal-card-p-tbl-1"]').click()
    // The desk-offer chooser appears instead of a dead-end "open a task first" error.
    await expect(window.locator('[data-testid="desk-offer"]')).toBeVisible({ timeout: 4_000 })
    await window.locator('[data-testid="desk-offer-name"]').fill('Tracker desk')
    await window.locator('[data-testid="desk-offer-create"]').click()
    await window.waitForTimeout(700)
    // The app navigated to a real desk (task view).
    const kind = await window.evaluate(() => {
      const v = (window as unknown as { __fbView?: { getState: () => { view: { kind: string } } } }).__fbView
      return v?.getState().view.kind
    })
    expect(kind).toBe('task')
  })
})
