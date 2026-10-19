import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// "Lever 2: preset transform recipes" (plexi-4.0):
//   The WireEditor's transform panel now shows a "Recipes" chip row above the
//   verb input — one-click presets (src/renderer/src/lib/wireRecipes.ts) that
//   set the wire's verb (and trigger a run) so the user never faces a blank
//   instruction box. Recipes are only offered when the wire's SOURCE widget is
//   a text-bearing kind (note/sticky/markdown/page/doc/etc); a non-text source
//   (timer, color, ...) shows no chips, just the plain verb input.
//
// Driven via window.api for widget/link creation (deterministic, no drag)
// plus real UI clicks on the wire badge / WireEditor / recipe chips. Because
// the e2e env has no ANTHROPIC_API_KEY (see _helpers.ts), a real transform run
// degrades gracefully with no AI output — so these specs assert the wire's
// VERB was set by the recipe, not any AI-generated content.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Seeded {
  taskId: string
  noteAId: string
  noteBId: string
  timerId: string
  linkId: string
  timerLinkId: string
}

// Seeds a task with a note A (text source) -> note B (target), transform wire,
// plus a timer T (non-text source) -> note B, also transform, for the
// non-text-source assertion.
async function seed(window: Page): Promise<Seeded> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Wire recipes' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'A',
      content: 'Meeting notes: ship the recipe chips by Friday, follow up with design.',
      x: 120,
      y: 160,
      width: 220,
      height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'B',
      content: '',
      x: 520,
      y: 160,
      width: 220,
      height: 180
    })
    const t = await api.widgets.create({
      taskId: task.id,
      kind: 'timer',
      title: 'T',
      content: '',
      x: 920,
      y: 160,
      width: 220,
      height: 180
    })
    const link = await api.widgetLinks.create(a.id, b.id, task.id)
    await api.widgetLinks.update(link!.id, { type: 'transform' })
    const timerLink = await api.widgetLinks.create(t.id, b.id, task.id)
    await api.widgetLinks.update(timerLink!.id, { type: 'transform' })
    return { taskId: task.id, noteAId: a.id, noteBId: b.id, timerId: t.id, linkId: link!.id, timerLinkId: timerLink!.id }
  })
}

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

async function linkVerb(window: Page, taskId: string, linkId: string): Promise<string | undefined> {
  return window.evaluate(
    async ({ tid, lid }: { tid: string; lid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const links = await api.widgetLinks.listByTask(tid)
      return links.find((l) => l.id === lid)?.verb
    },
    { tid: taskId, lid: linkId }
  )
}

test('(a) the WireEditor for a text-source transform wire shows the recipes row with action-items + summarize chips', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire recipes/)

  await window.locator(`[data-testid="wire-badge-${s.linkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })

  const recipes = window.locator('[data-testid="wire-recipes"]')
  await expect(recipes).toBeVisible()
  await expect(window.locator('[data-testid="wire-recipe-action-items"]')).toBeVisible()
  await expect(window.locator('[data-testid="wire-recipe-summarize"]')).toBeVisible()
})

test('(b) clicking the summarize recipe sets the wire verb to the summarize instruction, durably', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire recipes/)

  await window.locator(`[data-testid="wire-badge-${s.linkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })

  await window.locator('[data-testid="wire-recipe-summarize"]').click()

  const verbInput = window.locator('[data-testid="wire-verb-input"]')
  await expect(verbInput).toHaveValue(/^Summarize/)

  await expect
    .poll(async () => linkVerb(window, s.taskId, s.linkId), { timeout: 4_000, intervals: [150, 250] })
    .toMatch(/^Summarize/)
})

test('(c) a non-text source (timer) shows no recipes chips in its WireEditor', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire recipes/)

  await window.locator(`[data-testid="wire-badge-${s.timerLinkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })

  // Transform panel (verb input) is still there...
  await expect(window.locator('[data-testid="wire-verb-input"]')).toBeVisible()
  // ...but no recipes row / chips for a non-text source.
  await expect(window.locator('[data-testid="wire-recipes"]')).toHaveCount(0)
  await expect(window.locator('[data-testid="wire-recipe-action-items"]')).toHaveCount(0)
})

test('(d) the plain verb input still accepts a custom verb and persists it on blur', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await openTask(window, /Wire recipes/)

  await window.locator(`[data-testid="wire-badge-${s.linkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible({ timeout: 3_000 })

  const verbInput = window.locator('[data-testid="wire-verb-input"]')
  await verbInput.fill('Translate this into French')
  // Blur via the input's own blur() so we don't risk the click landing on a
  // recipe chip underneath (the popover reflows once the input grows).
  await verbInput.blur()

  await expect
    .poll(async () => linkVerb(window, s.taskId, s.linkId), { timeout: 4_000, intervals: [150, 250] })
    .toBe('Translate this into French')
})
