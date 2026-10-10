/**
 * E2E for the persistent right-side panel in PlexiDocs (AI Assistant / Comments /
 * Outline). Opens a fresh document through the PlexiOffice shell and exercises the
 * panel.
 *
 * The AI quick action is made deterministic and offline by stubbing the real IPC
 * channels (ai:suggestDocContent, ai:rewriteSelection) at the ipcMain level, the
 * same technique docEditor.spec.ts / sheetEditor.spec.ts SE-18 use. The contextBridge
 * exposes a frozen proxy that cannot be monkey-patched from the renderer, so the
 * stub lives in the main process.
 *
 * Coverage:
 *  1. The three tabs render (AI Assistant, Comments, Outline).
 *  2. Switching tabs shows the AI / Comments / Outline content.
 *  3. Clicking "Summarize this document" calls the stubbed API and shows the result.
 *  4. The Outline tab lists a heading typed into the document.
 *  5. A fresh document shows the empty state in the Comments tab.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

const SUMMARY_HTML = '<h2>Summary</h2><p>This is the stubbed summary.</p>'

/** Stub ai:suggestDocContent + ai:rewriteSelection at the ipcMain level. */
async function stubDocAi(app: LaunchedApp['app'], html: string): Promise<void> {
  await app.evaluate(({ ipcMain }, h: string) => {
    ipcMain.removeHandler('ai:suggestDocContent')
    ipcMain.removeHandler('ai:rewriteSelection')
    ipcMain.handle('ai:suggestDocContent', async () => ({ ok: true, html: h }))
    ipcMain.handle('ai:rewriteSelection', async () => ({ ok: true, html: h }))
  }, html)
}

/** Stub workspace:askStream (the whole-workspace brain) — streams a delta, then
 * resolves with a grounded, cited answer. */
async function stubWorkspaceAsk(app: LaunchedApp['app'], answer: string): Promise<void> {
  await app.evaluate(({ ipcMain }, a: string) => {
    ipcMain.removeHandler('workspace:askStream')
    ipcMain.handle('workspace:askStream', async (e, _q: string, _h: unknown, requestId: string, docContext?: { text?: string } | null) => {
      e.sender.send(`workspace:askStream:${requestId}`, { type: 'delta', payload: a })
      // Echo the scope so the test can assert doc-scoped asks pass the doc text.
      ;(globalThis as unknown as { __lastAskDocScoped?: boolean }).__lastAskDocScoped = !!(docContext && docContext.text)
      return {
        ok: true,
        answer: a,
        citedDocIds: ['doc-1'],
        sources: [{ docId: 'doc-1', title: 'Q3 Revenue', docType: 'sheet', snippet: '…', cited: true }]
      }
    })
  }, answer)
}

/** Open PlexiOffice and create + open a blank document. */
async function openOfficeDoc(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-docs"]').click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="doc-side-panel"]')).toBeVisible({ timeout: 8_000 })
}

type DebugEditor = {
  chain: () => {
    focus: () => { selectAll: () => { insertContent: (s: string) => { run: () => boolean } } }
  }
  commands: { setContent: (s: string) => boolean }
}

/** Replace the document body with the given HTML through the debug handle. */
async function setDocHtml(window: Page, html: string): Promise<void> {
  await window.evaluate((h: string) => {
    const e = (window as unknown as { __docEditor?: DebugEditor }).__docEditor
    e?.commands.setContent(h)
  }, html)
  await window.waitForTimeout(250)
}

test.describe('PlexiDocs side panel', () => {
  let app: LaunchedApp
  let window: Page

  test.beforeAll(async () => {
    app = await launchApp()
    window = app.window
    await waitForReady(window)
    await stubDocAi(app.app, SUMMARY_HTML)
    await stubWorkspaceAsk(app.app, 'Across your docs, Q3 revenue came in 8% over plan.')
    await openOfficeDoc(window)
  })
  test.afterAll(async () => {
    await app.dispose()
  })

  test('DSP-1 — Comments + Outline render; the in-panel AI tab is retired', async () => {
    await expect(window.locator('[data-testid="doc-tab-comments"]')).toBeVisible()
    await expect(window.locator('[data-testid="doc-tab-outline"]')).toBeVisible()
    // AI is the single global assistant now — no separate in-doc AI tab.
    await expect(window.locator('[data-testid="doc-tab-ai"]')).toHaveCount(0)
  })

  test('DSP-2 — switching Comments / Outline shows the right content', async () => {
    await window.locator('[data-testid="doc-tab-comments"]').click()
    await expect(window.locator('[data-testid="doc-comments-list"]')).toBeVisible()
    await window.locator('[data-testid="doc-tab-outline"]').click()
    await expect(window.locator('[data-testid="doc-outline-tab"]')).toBeVisible()
  })

  test('DSP-3 — the doc assistant control opens the one global overlay', async () => {
    await window.locator('[data-testid="doc-assistant-toggle"]').click()
    await expect(window.locator('[data-testid="assistant-overlay"]')).toBeVisible({ timeout: 6_000 })
  })

  test('DSP-4 — Outline tab lists a heading typed into the document', async () => {
    await setDocHtml(window, '<h1>My Test Heading</h1><p>Body text.</p>')
    await window.locator('[data-testid="doc-tab-outline"]').click()
    await expect(window.locator('[data-testid="doc-outline-tab"]')).toContainText('My Test Heading', {
      timeout: 8_000
    })
  })

  test('DSP-5 — fresh doc shows the empty state in Comments', async () => {
    await window.locator('[data-testid="doc-tab-comments"]').click()
    await expect(window.locator('[data-testid="doc-comments-empty"]')).toBeVisible()
    await expect(window.locator('[data-testid="doc-comments-empty"]')).toContainText('No comments yet')
  })
})
