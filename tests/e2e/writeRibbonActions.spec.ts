import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, selectBarTab, type LaunchedApp } from './_helpers'

// Write actions that two surfaces implemented twice (registry-41 inventory).
//
// Three of Write's ribbon buttons did nothing: Insert ›
// Link, Review › Word count and Review › Accessibility check were wired to
// `setFindOpen(false)`. The menu bar's items worked, through their own code.
// Each button now runs the same command as its menu item. Seen red on the
// e1f7ec5f build (the buttons do nothing) before the fix.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

async function openDoc(): Promise<Page> {
  launched = await launchApp()
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = await w.evaluate(
    async () =>
      ((await (window as unknown as { api: typeof window.api }).api.documents.create({
        docType: 'doc',
        title: 'Ribbon actions',
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plexii makes work easy' }] }] }
      } as never)) as { id: string }).id
  )
  await w.reload()
  await waitForReady(w)
  await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  await expect(w.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
  return w
}

const ribbonButton = (w: Page, name: string) => w.locator('[data-testid="doc-toolbar"]').getByRole('button', { name: new RegExp(`^${name}\\b`) }).first()

test('Insert › Link asks for the URL and links the selected words', async () => {
  test.setTimeout(90_000)
  const w = await openDoc()
  // Select "Plexii".
  await w.locator('.ProseMirror p').first().evaluate((p) => {
    const t = p.firstChild!
    const r = document.createRange()
    r.setStart(t, 0)
    r.setEnd(t, 6)
    const s = getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  })
  await selectBarTab(w, 'doc-toolbar', 'insert')
  await ribbonButton(w, 'Link').click()
  const dialog = w.locator('[data-testid="prompt-dialog"]')
  await expect(dialog, 'the Link button asks for a URL').toBeVisible()
  await expect(dialog).toContainText('Link URL')
  await dialog.locator('input').fill('https://plexiidesk.com')
  await dialog.getByRole('button', { name: 'Set link' }).click()
  await expect(w.locator('.ProseMirror a[href="https://plexiidesk.com"]')).toHaveText('Plexii')
})

test('Review › Word count opens the count', async () => {
  test.setTimeout(90_000)
  const w = await openDoc()
  await selectBarTab(w, 'doc-toolbar', 'review')
  await ribbonButton(w, 'Word count').click()
  const sheet = w.getByRole('dialog', { name: 'Word count' })
  await expect(sheet, 'the Word count button opens the count').toBeVisible()
  await expect(sheet).toContainText('4') // "Plexii makes work easy"
})

test('Review › Accessibility check opens the check', async () => {
  test.setTimeout(90_000)
  const w = await openDoc()
  await selectBarTab(w, 'doc-toolbar', 'review')
  await ribbonButton(w, '(Check accessibility|Accessibility check)').click()
  await expect(w.getByRole('dialog', { name: 'Accessibility check' }), 'the Accessibility button opens the check').toBeVisible()
})

// Edit › Paste inserted the clipboard's plain text, so a pasted bold, link or
// heading arrived flat, while ⌘V kept it. Both now run the same paste.
test('Edit › Paste keeps formatting, as ⌘V does', async () => {
  test.setTimeout(90_000)
  const w = await openDoc()
  await launched!.app.evaluate(({ clipboard }) => clipboard.write({ html: '<p><strong>Bold words</strong> and plain</p>', text: 'Bold words and plain' }))
  await w.locator('.ProseMirror p').first().click()
  await w.keyboard.press('End')
  await w.locator('[data-testid="doc-menu-edit"]').click()
  await w.locator('[data-testid="doc-menu-edit-list"]').getByText('Paste', { exact: true }).click()
  await expect(w.locator('.ProseMirror strong', { hasText: 'Bold words' }), 'the bold survived the menu paste').toBeVisible()
})
