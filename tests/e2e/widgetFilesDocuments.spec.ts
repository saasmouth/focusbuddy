/**
 * Office documents as .plexii-* files, in the real app (F1, 2026-11-20).
 *
 *   WD-1  Each document example (tests/fixtures/widget-files/example.plexii-doc …
 *         -draw) imports through the app's own channel as a NEW document, goes
 *         into Files, and exports back to the same file text.
 *   WD-2  An imported spreadsheet opens in Cells with what the file held.
 *   WD-3  A file that is not what it says is refused, and nothing is created.
 */
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const DIR = resolve(__dirname, '../fixtures/widget-files')
const DOC_TYPES = ['doc', 'sheet', 'slides', 'map', 'design', 'draw'] as const
const fixture = (t: string): string => readFileSync(join(DIR, `example.plexii-${t}`), 'utf8')
const withoutStamp = (text: string): unknown => {
  const o = JSON.parse(text) as Record<string, unknown>
  delete o.exportedAt
  return o
}

type ImportResult = { ok: true; kind: 'document'; document: { id: string; docType: string; title: string } } | { ok: false; error: string } | { ok: true; kind: 'widget' }
const importText = (window: Page, text: string): Promise<ImportResult> =>
  window.evaluate((t) => (window as unknown as { api: { widgetFiles: { import: (i: { text: string }) => Promise<ImportResult> } } }).api.widgetFiles.import({ text: t }), text)
const exportText = (window: Page, documentId: string): Promise<{ ok: boolean; name?: string; text?: string; error?: string }> =>
  window.evaluate(
    (id) => (window as unknown as { api: { widgetFiles: { exportText: (r: { documentId: string }) => Promise<{ ok: boolean; name?: string; text?: string }> } } }).api.widgetFiles.exportText({ documentId: id }),
    documentId
  )

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

test('WD-1 every document type imports as a new document in Files, and exports back to the same file', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  for (const t of DOC_TYPES) {
    const text = fixture(t)
    const r = await importText(window, text)
    expect(r.ok && r.kind, `${t}: ${JSON.stringify(r)}`).toBe('document')
    if (!r.ok || r.kind !== 'document') continue
    expect(r.document.docType).toBe(t)
    const filed = await window.evaluate(
      async (id) => ((await (window as unknown as { api: { fileManager: { list: (p: string | null) => Promise<Array<{ docId?: string }>> } } }).api.fileManager.list(null)) ?? []).some((e) => e.docId === id),
      r.document.id
    )
    expect(filed, `${t} is in Files`).toBe(true)
    const back = await exportText(window, r.document.id)
    expect(back.ok, `${t}: ${back.error}`).toBe(true)
    expect(back.name?.endsWith(`.plexii-${t}`)).toBe(true)
    expect(withoutStamp(back.text!)).toEqual(withoutStamp(text))
  }
})

test('WD-2 an imported spreadsheet opens in Cells with what the file held', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const r = await importText(window, fixture('sheet'))
  if (!r.ok || r.kind !== 'document') throw new Error(`not imported: ${JSON.stringify(r)}`)
  await window.evaluate((id) => (window as unknown as { __fbView: { getState: () => { goDocument: (id: string) => void } } }).__fbView.getState().goDocument(id), r.document.id)
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('[data-testid="cell-1-0"]')).toContainText('Pens')
  await expect(window.locator('[data-testid="cell-2-2"]')).toContainText('4.00')
})

test('WD-3 a file that is not what it says is refused, and nothing is created', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const count = (): Promise<number> =>
    window.evaluate(async () => ((await (window as unknown as { api: { documents: { list: () => Promise<unknown[]> } } }).api.documents.list()) ?? []).length)
  const before = await count()
  const bad = JSON.stringify({ type: 'plexii.document.sheet', version: 1, title: 'Not a sheet', docType: 'sheet', body: { hello: 'world' } })
  const r = await importText(window, bad)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(/damaged/)
  expect(await count()).toBe(before)
})
