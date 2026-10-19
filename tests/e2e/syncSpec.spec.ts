import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Sync-duplicate SPEC, verified through the real UI:
//   • Editing one copy updates its linked copy LIVE (no hard refresh), same task.
//   • Works for content widgets (sticky, card) — the adopt effect.
//   • An INDEPENDENT copy never receives the other's edits.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedPair(
  l: LaunchedApp,
  kind: string,
  content: string,
  groupId: string | null
): Promise<{ taskId: string; a: string; b: string }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(
    async ({ kind, content, groupId }: { kind: string; content: string; groupId: string | null }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'SyncSpec' })
      const mk = (x: number): Promise<{ id: string }> =>
        api.widgets.create({
          taskId: t.id,
          kind: kind as never,
          title: '',
          content,
          x,
          y: 140,
          width: 220,
          height: 180,
          syncGroupId: groupId as never
        })
      const a = await mk(120)
      const b = await mk(420)
      return { taskId: t.id, a: a.id, b: b.id }
    },
    { kind, content, groupId }
  )
  await window.reload()
  await waitForReady(window)
  await window.evaluate((taskId) => {
    const view = (window as unknown as {
      __fbView?: { getState: () => { goTask: (id: string) => void } }
    }).__fbView
    view?.getState().goTask(taskId)
  }, seeded.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.a}"]`, { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.b}"]`, { timeout: 5_000 })
  await window.waitForTimeout(300)
  return seeded
}

test('sticky: editing one synced copy updates the other LIVE (no refresh)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { a, b } = await seedPair(launched, 'sticky', 'before', 'grp-sticky')

  const firstSticky = window.locator(`[data-widget-id="${a}"]`)
  await firstSticky.locator('.fb-sticky-rendered').click()
  await firstSticky.locator('textarea').fill('LIVE-SYNCED-TEXT')
  // debounced save (300ms) → store mirror → sibling adopt effect
  await window.waitForTimeout(900)

  await expect(window.locator(`[data-widget-id="${b}"] .fb-sticky-rendered`)).toHaveText(
    'LIVE-SYNCED-TEXT'
  )
})

test('card: editing one synced copy title updates the other LIVE', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const card = JSON.stringify({ title: 'before', body: '', accent: '#6366f1' })
  const { a, b } = await seedPair(launched, 'card', card, 'grp-card')

  // First input in a card is the title.
  await window.locator(`[data-widget-id="${a}"] input`).first().fill('SYNCED-CARD-TITLE')
  await window.waitForTimeout(900)

  const bTitle = await window.locator(`[data-widget-id="${b}"] input`).first().inputValue()
  expect(bTitle).toBe('SYNCED-CARD-TITLE')
})

test('independent copy (no group) does NOT receive the edit', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { a, b } = await seedPair(launched, 'sticky', 'before', null)

  const firstSticky = window.locator(`[data-widget-id="${a}"]`)
  await firstSticky.locator('.fb-sticky-rendered').click()
  await firstSticky.locator('textarea').fill('ONLY-IN-A')
  await window.waitForTimeout(900)

  await expect(window.locator(`[data-widget-id="${b}"] .fb-sticky-rendered`)).toHaveText('before')
})
