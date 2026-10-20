// Local AI (Settings → AI → Local on this device), end to end in the real app.
// Throwaway profiles only (launchApp mints a temp userData and deletes it);
// PLEXI_APP=preview3 so nothing can touch a production profile.
//
// The last test runs a REAL on-device completion. It needs the model file, so
// it runs only when LOCAL_AI_E2E_MODEL points at the catalog's GGUF; the file is
// cloned (APFS copy-on-write) into the throwaway profile's models/ directory.
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

function profileWithLocalMode(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-e2e-local-'))
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ keys: {}, aiMode: 'local', v: 1 }))
  return dir
}

async function openAiSettings(window: LaunchedApp['window']): Promise<void> {
  await window.getByRole('button', { name: /appearance settings/i }).click()
  await expect(window.locator('[role="dialog"][aria-label="Settings"]').first()).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="settings-tab-ai"]').click()
  await expect(window.locator('[data-testid="ai-source-section"]')).toBeVisible({ timeout: 5_000 })
}

test('Local AI: the source can be set to Local, and the panel shows models and measured features', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  const { window } = launched
  await waitForReady(window)
  await openAiSettings(window)

  await window.locator('[data-testid="ai-mode-local"]').click()
  await expect(window.locator('[data-testid="ai-mode-local"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(window.locator('[data-testid="ai-local-note"]')).toContainText('No prompt or content is sent to any AI service')

  const section = window.locator('[data-testid="local-ai-section"]')
  await expect(section).toBeVisible()
  // Tiers come from the signed catalog; each says whether this Mac can run it.
  await expect(section.locator('[data-testid^="local-ai-tier-"]').first()).toBeVisible({ timeout: 5_000 })
  await expect(section.locator('[data-testid^="local-ai-download-"]').first()).toBeVisible()
  // Every feature is listed with its measured pass rates.
  for (const f of ['assistant', 'build', 'writing', 'summaries', 'background', 'agents']) {
    await expect(section.locator(`[data-testid="local-ai-feature-${f}"]`)).toContainText('On this device:')
  }
  // The choice persisted through main.
  const status = await window.evaluate(() => window.api.localAi.getStatus())
  expect(status.provider).toBe('local')
})

test('Local AI: with no model downloaded, an AI action fails plainly and nothing is sent', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '' }, userDataDir: profileWithLocalMode() })
  const { window } = launched
  await waitForReady(window)
  const r = await window.evaluate(() =>
    window.api.ai.transformText({ text: 'please tidy this sentence up a bit', instruction: 'Make it formal' })
  )
  expect(r.ok).toBe(false)
  expect(r.error).toMatch(/not downloaded/i)
  expect(r.needsApiKey).toBeFalsy()
  rmSync(launched.userDataDir, { recursive: true, force: true })
})

const MODEL = process.env.LOCAL_AI_E2E_MODEL
test('Local AI: a real on-device completion runs from the app, offline', async () => {
  test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run a real completion')
  test.setTimeout(180_000)
  const dir = profileWithLocalMode()
  const models = join(dir, 'models')
  mkdirSync(models, { recursive: true })
  execFileSync('cp', ['-c', MODEL!, join(models, basename(MODEL!))])
  // The marker records the checksum the file was verified against; the app
  // checks it against the catalog, so a wrong file is not treated as installed.
  const sha = execFileSync('shasum', ['-a', '256', MODEL!], { encoding: 'utf8' }).split(/\s+/)[0]
  writeFileSync(join(models, `${basename(MODEL!)}.verified`), sha + '\n')

  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '' }, userDataDir: dir })
  const { window } = launched
  await waitForReady(window)
  const st = await window.evaluate(() => window.api.localAi.getStatus())
  expect(st.tiers.find((t) => t.id === st.activeTier)?.installed).toBe(true)

  const trial = await window.evaluate(() => window.api.localAi.tryIt())
  expect(trial.error ?? null).toBeNull()
  expect(trial.ok).toBe(true)
  expect((trial.text ?? '').length).toBeGreaterThan(10)

  const r = await window.evaluate(() =>
    window.api.ai.transformText({ text: 'their going to send it tomorow', instruction: 'Fix the spelling and grammar only' })
  )
  expect(r.ok).toBe(true)
  expect(r.result).toMatch(/they're|they are/i)
  rmSync(dir, { recursive: true, force: true })
})
