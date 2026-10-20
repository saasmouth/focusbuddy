import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// AI Builder ("Build with AI") workspace dialog — the desk-side free-form
// generator. Its command-bar hand-off (the __fbAiCmd seeded 'ready' stage this
// spec used to drive) retired with the one-shot AI command bar in the Plexii
// consolidation, so the dialog's one entry is now its own prompt. With no API
// key in e2e (stripped by _helpers), the honest journey to lock is: open from
// the canvas pill, type a prompt, generate, land on the no-key error stage —
// never a fabricated suggestion.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('Build-with-AI opens from the canvas pill and degrades honestly with no key', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // This spec exercises the CLOUD path with no key. Since 4.3.39 a fresh
  // profile's AI source is Local (the model ships in the app), so choose the
  // automatic cloud source explicitly, as an existing cloud user would have.
  await window.evaluate(() => (window as unknown as { api: { ai: { setMode: (m: string) => Promise<unknown> } } }).api.ai.setMode('auto'))
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'BuilderHost' })
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /BuilderHost/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // The Build entry on the canvas pill (hover expands its labels; the button
  // itself is clickable either way).
  const build = window.locator('[data-testid="pill-build"]').first()
  await build.waitFor({ state: 'visible', timeout: 8_000 })
  await build.click()

  // Prompt stage.
  await expect(window.getByRole('heading', { name: 'Build with AI' })).toBeVisible({
    timeout: 6_000
  })
  const promptBox = window.locator('textarea').first()
  await promptBox.fill('Track my freelance clients')
  await window.getByRole('button', { name: /Generate/ }).click()

  // No key in e2e: the dialog lands on its error stage and says how to fix it,
  // rather than inventing suggestions.
  await expect(window.getByText(/API key/i).first()).toBeVisible({ timeout: 8_000 })

  // Escape closes.
  await window.keyboard.press('Escape')
  await expect(window.getByRole('heading', { name: 'Build with AI' })).toHaveCount(0, {
    timeout: 6_000
  })
})
