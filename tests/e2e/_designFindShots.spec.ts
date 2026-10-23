/**
 * ONE-OFF screenshot sweep for Design's Find… / Find and replace… (the last
 * §9.6 menu exception). The behaviour is guarded by officeMenus.spec.ts; this
 * exists to SHOW it — 9d asked for a real-click sample of Edit ▸ Find and of
 * ⌘F in the handback.
 *
 * `_`-prefixed, so `npm run test:e2e` excludes it.
 *
 *   npm run build && npx playwright test tests/e2e/_designFindShots.spec.ts
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

const SHOTS = 'tests/e2e/__screenshots__/design-find'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

test('Design: Edit ▸ Find…, and ⌘F opening the panel', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)

  // A design with a threaded story, so the panel searches something real
  // rather than an empty document.
  const id = await w.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const body = {
      schemaVersion: 1,
      width: 800,
      height: 600,
      activePage: 0,
      elements: [
        { id: 'frame1', type: 'text', x: 60, y: 60, w: 320, h: 400, paragraphs: [], storyId: 'st1', storyOrder: 1 }
      ],
      pages: [
        {
          id: 'p1',
          elements: [
            { id: 'frame1', type: 'text', x: 60, y: 60, w: 320, h: 400, paragraphs: [], storyId: 'st1', storyOrder: 1 }
          ]
        }
      ],
      stories: {
        st1: {
          blocks: [
            { kind: 'heading', level: 2, text: 'The quarterly review' },
            { kind: 'paragraph', text: 'Revenue grew in every region we opened this year.' },
            { kind: 'paragraph', text: 'The second half depends on the same regions holding.' }
          ]
        }
      }
    }
    const d = (await api.documents.create({ docType: 'design', title: 'Find in Design', body } as never)) as { id: string }
    return d.id
  })
  await w.reload()
  await waitForReady(w)
  await w.evaluate(
    (i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i),
    id
  )
  await expect(w.locator('[data-testid="design-menubar"]')).toBeVisible({ timeout: 15_000 })

  // 1. Edit ▸ Find…, opened by a real click on the menu.
  await w.locator('[data-testid="design-menubar-edit"]').click()
  const list = w.locator('[data-testid="design-menubar-edit-list"]')
  await expect(list).toBeVisible()
  await expect(list, 'the two rows are really in the menu').toContainText('Find…')
  await expect(list).toContainText('Find and replace…')
  await w.screenshot({ path: `${SHOTS}/01-edit-menu-find.png` })

  // Run it from the menu: the panel opens.
  await list.getByText('Find…', { exact: true }).click()
  const panel = w.locator('[data-testid="design-find"]')
  await expect(panel, 'Edit ▸ Find… opens the panel').toBeVisible()
  await w.screenshot({ path: `${SHOTS}/02-panel-from-menu.png` })
  await w.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // 2. ⌘F, typed, with a query that matches the story's text.
  await w.locator('[data-testid="design-menubar"]').click({ position: { x: 400, y: 5 } }).catch(() => undefined)
  await w.keyboard.press('Meta+f')
  await expect(panel, '⌘F opens it').toBeVisible()
  // "region" is in BOTH story blocks ("every region", "the same regions");
  // "regions" is in only one, which is what my first run asserted and why it
  // read 1/1. The count is "current/total".
  await w.locator('[data-testid="design-find-input"]').fill('region')
  // Two hits proves it searched the STORY: this text is in stories.st1, and
  // the frame showing it has no paragraphs of its own at all.
  await expect(w.locator('[data-testid="design-find-count"]')).toContainText('/2')
  await w.screenshot({ path: `${SHOTS}/03-cmd-f-two-hits-in-the-story.png` })

  // 3. ⇧⌘H shows the Replace row.
  await w.keyboard.press('Escape')
  await w.locator('[data-testid="design-menubar"]').click({ position: { x: 400, y: 5 } }).catch(() => undefined)
  await w.keyboard.press('Meta+Shift+h')
  await expect(panel).toBeVisible()
  await expect(panel.getByPlaceholder('Replace with').first()).toBeVisible()
  await w.locator('[data-testid="design-find-input"]').fill('region')
  await w.screenshot({ path: `${SHOTS}/04-shift-cmd-h-replace-row.png` })
})
