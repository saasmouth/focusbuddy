import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'

// ⌘P / Ctrl+P runs File › Print… in every office app that shows it (19's find,
// 9d's class closure). The menus showed "Print… ⌘P" and nothing bound the key
// outside Draw. MenuBarShell now binds it to the bar's own Print… row. Pressed
// as a real key; the print seam (PLEXI_PRINT_CAPTURE) records the job instead
// of opening a dialog. Seen red on the build before the binding. Draw keeps
// its own ⌘P (reserved, as in Illustrator) and has no Print row.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

const jobs = (app: ElectronApplication): Promise<unknown[]> => app.evaluate(() => ((globalThis as { __plexiiPrintJobs?: unknown[] }).__plexiiPrintJobs ?? []) as never)

async function open(docType: string, body: unknown, bar: string): Promise<Page> {
  launched = await launchApp({ env: { PLEXI_PRINT_CAPTURE: '1' } })
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = await w.evaluate(
    async ({ d, b }) => ((await (window as unknown as { api: typeof window.api }).api.documents.create({ docType: d, title: 'Print by key', body: b } as never)) as { id: string }).id,
    { d: docType, b: body }
  )
  await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  await expect(w.locator(`[data-testid="${bar}"]`)).toBeVisible({ timeout: 15_000 })
  // The host can print this document (the engine binds it).
  await expect
    .poll(() => w.evaluate((docId) => (window as unknown as { __fbPrint?: { bound: () => Array<{ id: string; canPrint: boolean }> } }).__fbPrint?.bound().some((b) => b.id === docId && b.canPrint) ?? false, id), { timeout: 15_000 })
    .toBe(true)
  return w
}

const APPS = [
  { name: 'Write', docType: 'doc', bar: 'doc-menubar', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Print me' }] }] } },
  { name: 'Cells', docType: 'sheet', bar: 'sheet-menubar', body: undefined },
  { name: 'Deck', docType: 'slides', bar: 'slides-menubar', body: undefined },
  { name: 'Diagrams', docType: 'map', bar: 'draw-menubar', body: { version: 1, nodes: [{ id: 'a', x: 200, y: 160, label: 'A', shape: 'process', width: 160, height: 80 }], edges: [] } },
  { name: 'Design', docType: 'design', bar: 'design-menubar', body: undefined }
]

for (const app of APPS) {
  test(`${app.name}: ⌘P prints, as File › Print… says`, async () => {
    test.setTimeout(90_000)
    const w = await open(app.docType, app.body, app.bar)
    const before = (await jobs(launched!.app)).length
    await w.locator(`[data-testid="${app.bar}"]`).click({ position: { x: 600, y: 5 } }).catch(() => undefined)
    await w.keyboard.press('Meta+p')
    await expect.poll(async () => (await jobs(launched!.app)).length, { message: `${app.name}: ⌘P sent one print job`, timeout: 8_000 }).toBe(before + 1)
  })
}

test('Draw: no Print… row, and ⌘P still does Draw’s own thing (no print job)', async () => {
  test.setTimeout(90_000)
  launched = await launchApp({ env: { PLEXI_PRINT_CAPTURE: '1' } })
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = await w.evaluate(async () => ((await (window as unknown as { api: typeof window.api }).api.documents.create({ docType: 'draw', title: 'Draw keys' } as never)) as { id: string }).id)
  await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  await expect(w.locator('[data-testid="draw-studio-menubar"]')).toBeVisible({ timeout: 15_000 })
  await w.locator('[data-testid="draw-studio-menubar-file"]').click()
  await expect(w.locator('[data-testid="draw-studio-menubar-file-list"]').getByText('Print…', { exact: true })).toHaveCount(0)
  await w.keyboard.press('Escape')
  await w.keyboard.press('Meta+p')
  await w.waitForTimeout(800)
  expect((await jobs(launched!.app)).length, 'Draw does not print on ⌘P').toBe(0)
})
