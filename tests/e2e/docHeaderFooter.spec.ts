/**
 * E2E for PlexiDocs running headers & footers: in Page view, the Header/Footer
 * control edits header/footer text and a page-number toggle, they render in the
 * page margins, and they persist on the document body.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView, selectBarTab } from './_helpers'

async function openDocumentsHub(window: Page): Promise<void> {
  await gotoView(window, 'goDocuments')
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

async function startBlankDoc(window: Page): Promise<void> {
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Document' }).first().click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 8_000 })
}

async function enterPageView(window: Page): Promise<void> {
  const visible = await window.locator('[data-testid="doc-page"]').isVisible().catch(() => false)
  if (!visible) {
    await selectBarTab(window, 'doc-toolbar', 'layout')
    await window.locator('[data-testid="doc-pageview-btn"]').click()
    await expect(window.locator('[data-testid="doc-page"]')).toBeVisible({ timeout: 4_000 })
  }
}

async function savedPage(window: Page): Promise<Record<string, unknown>> {
  await window.waitForTimeout(1_600)
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = await api.documents.list()
    const doc = await api.documents.get(docs[0].id)
    const body = doc?.body as { page?: Record<string, unknown> }
    return body?.page ?? {}
  })
}

test('DHF-1 — set a header + footer with page number; renders and persists', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await openDocumentsHub(window)
    await startBlankDoc(window)
    await enterPageView(window)

    await selectBarTab(window, 'doc-toolbar', 'insert')
    await window.locator('[data-testid="doc-headerfooter-btn"]').click()
    await expect(window.locator('[data-testid="doc-headerfooter-menu"]')).toBeVisible({ timeout: 4_000 })

    await window.locator('[data-testid="doc-header-input"]').fill('Confidential draft')
    await window.locator('[data-testid="doc-footer-input"]').fill('Acme Corp')
    await window.locator('[data-testid="doc-footer-pageno"]').check()

    // The running header/footer render on the page (they live in the sheet layer,
    // in the DOM regardless of the still-open popover).
    await expect(window.locator('[data-testid="doc-header"]').first()).toContainText('Confidential draft', { timeout: 4_000 })
    const footer = window.locator('[data-testid="doc-footer"]').first()
    await expect(footer).toContainText('Acme Corp')
    await expect(footer).toContainText('Page 1')

    // Persisted on the body.
    const page = await savedPage(window)
    expect(page.header).toEqual({ text: 'Confidential draft' })
    expect(page.footer).toEqual({ text: 'Acme Corp', showPageNumber: true })
  } finally {
    await dispose()
  }
})
