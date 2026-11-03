// "Changed elsewhere" with nothing changed (owner, 2026-11-03: "fix").
//
// A document whose editor tidies its body on load (here: it ends in a snippet
// embed, so the editor appends the empty paragraph it always keeps last) saves
// that tidy-up about half a second later. Open the desk on the canvas and switch
// to the Workcentre before that save lands: the Workcentre's editor loads the
// same revision, makes the SAME tidy-up, and its save is refused as stale — so
// the person is shown "Changed elsewhere. Your edit has not been saved" for an
// edit they never made, with three choices about nothing.
//
// A refused save whose content equals what is stored is not a conflict: the
// editor takes the stored revision and carries on. A real difference still
// raises the bar (covered by the existing document conflict tests).
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: Page, docs: number): Promise<string> {
  return window.evaluate(async (n: number) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Same edit desk' })
    for (let i = 0; i < n; i++) {
      const snip = (await (api as unknown as { snippets: { create: (d: Record<string, unknown>) => Promise<{ snippet: { id: string } }> } }).snippets.create({
        name: `S${i}`,
        kind: 'doc',
        scope: 'personal',
        body: { kind: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `SNIPPET ${i}` }] }], text: `SNIPPET ${i}` }
      })) as { snippet: { id: string } }
      const doc = (await api.documents.create({
        docType: 'doc',
        title: `Doc ${i}`,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Body ${i}` }] }, { type: 'snippetEmbed', attrs: { snippetId: snip.snippet.id } }] }
      } as never)) as { id: string }
      await api.widgets.create({ taskId: task.id, kind: 'doc', content: doc.id, x: 40 + (i % 2) * 560, y: 40 + Math.floor(i / 2) * 460, width: 520, height: 420 } as never)
    }
    return task.id
  }, docs)
}

test('DOC-RACE-1 — opening the Workcentre while the canvas is still saving its own tidy-up raises no "Changed elsewhere"', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const taskId = await seed(window, 4)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), taskId)
  // On the canvas: the editors mount and tidy their bodies (the saves are debounced ~500ms).
  await expect(window.locator('[data-testid="doc-editor-surface"]').first()).toBeVisible({ timeout: 15_000 })
  // Straight to the Workcentre, inside that window.
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator('[data-testid="view-opt-workcentre"]').click()
  await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid^="workcentre-body-"] [data-testid="doc-editor-surface"]')).toHaveCount(4, { timeout: 15_000 })
  // Give every save and its refusal time to happen.
  await window.waitForTimeout(3_000)
  await expect(window.locator('[data-testid="document-conflict"]'), 'a "Changed elsewhere" bar for an edit nobody made').toHaveCount(0)
})
