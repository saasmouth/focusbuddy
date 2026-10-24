// Local AI for people who UPDATE to 4.3.40, end to end in the real app.
//
// The Mac update zip carries no model (nor does Windows), and 4.3.39-local.x
// moved every 'auto'/unset profile to Local regardless, leaving an AI that
// could not answer behind a banner with no close button. Now the switch to
// Local happens only with a verified model; otherwise the previous engine is
// kept and Local is OFFERED as a download that, once finished and checked,
// completes the switch.
//
// Throwaway profiles only (launchApp mints a temp userData; PLEXI_APP=preview3).
// No sign-in, no keys, no app URLs. PLEXII_BUNDLED_MODELS_DIR stands in for an
// app bundle without the model (the update-zip case).
//
// MIG-4 needs resources/models staged in this tree (a fresh DMG install).
// MIG-5 downloads the real model files from a local HTTP server in this
// process; it runs only when LOCAL_AI_E2E_MODELS_DIR points at a staged
// models folder (<bundleId>/<file>, as scripts/fetch-bundled-models.mjs
// leaves it), and it writes ~2.6 GB into the throwaway profile, deleted after.
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
const cleanup: string[] = []
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

function profile(envelope: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-e2e-mig-'))
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ keys: {}, v: 1, ...envelope }))
  cleanup.push(dir)
  return dir
}
function noBundle(): string {
  const d = mkdtempSync(join(tmpdir(), 'plexii-nobundle-'))
  cleanup.push(d)
  return d
}
const secretsOf = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))

test('MIG-1 — update with no model: an auto (credits) profile keeps its engine and is offered the download; nothing blocks AI', async () => {
  const dir = profile({ aiMode: 'auto' })
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', PLEXII_BUNDLED_MODELS_DIR: noBundle() }, userDataDir: dir })
  const { window } = launched
  await waitForReady(window)

  const status = await window.evaluate(() => window.api.ai.getStatus())
  expect(status.mode).toBe('auto')
  expect((await window.evaluate(() => window.api.localAi.getStatus())).provider).toBe('credits')
  expect(secretsOf(dir)).toMatchObject({ aiMode: 'auto', aiModeMigration: 2, localAiPending: { kept: 'auto', from: 'auto' } })

  // The offer: size and a Download button; the source has not changed.
  const card = window.locator('[data-testid="local-ai-intro"][data-variant="offer"]')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText(/one-time download of 2\.\d GB/)
  await expect(card.locator('[data-testid="local-ai-intro-download"]')).toContainText(/Download \(2\.\d GB\)/)
  await expect(window.locator('[data-testid="local-ai-intro-unchanged"]')).toContainText('You are using Plexii AI credits; that has not changed')
  // No "needs a download" banner over the toolbars: AI is not routed to the device.
  await expect(window.locator('[data-testid="local-ai-missing"]')).toHaveCount(0)

  // An AI action takes the cloud path (no key here, so it asks for one), not
  // the dead "model not downloaded" path.
  const r = await window.evaluate(() => window.api.ai.transformText({ text: 'please tidy this sentence up a bit', instruction: 'Make it formal' }))
  expect(r.ok).toBe(false)
  expect(r.error ?? '').not.toMatch(/not downloaded/i)

  // Maybe later: gone, and it stays gone after a reload (recorded in main).
  await card.locator('[data-testid="local-ai-intro-dismiss"]').click()
  await expect(window.locator('[data-testid="local-ai-intro"]')).toHaveCount(0)
  await window.reload()
  await waitForReady(window)
  await window.waitForTimeout(1_000)
  await expect(window.locator('[data-testid="local-ai-intro"]')).toHaveCount(0)

  // Settings › AI › Local on this device still offers it, with the size.
  await window.getByRole('button', { name: /appearance settings/i }).click()
  await window.locator('[data-testid="settings-tab-ai"]').click()
  await expect(window.locator('[data-testid="local-ai-offer-note"]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="local-ai-offer-note"]')).toContainText(/one-time\s+2\.\d GB/)
  await expect(window.locator('[data-testid^="local-ai-download-"]').first()).toBeVisible()
  await expect(window.locator('[data-testid="ai-mode-local"]')).toContainText(/One-time download \(2\.\d GB\)/)
})

test('MIG-2 — a 4.3.39-local.x profile stuck on Local with no model is moved back to its engine and offered the download', async () => {
  const dir = profile({ aiMode: 'local', aiModeMigration: 1, localAiIntro: { pending: false, from: 'auto' } })
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', PLEXII_BUNDLED_MODELS_DIR: noBundle() }, userDataDir: dir })
  const { window } = launched
  await waitForReady(window)
  expect((await window.evaluate(() => window.api.ai.getStatus())).mode).toBe('auto')
  expect(secretsOf(dir)).toMatchObject({ aiMode: 'auto', aiModeMigration: 2 })
  await expect(window.locator('[data-testid="local-ai-intro"][data-variant="offer"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="local-ai-missing"]')).toHaveCount(0)
})

test('MIG-3 — Local chosen by hand with no model: the "needs a download" banner says so and can be dismissed', async () => {
  const dir = profile({ aiMode: 'local', aiModeMigration: 2 })
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', PLEXII_BUNDLED_MODELS_DIR: noBundle() }, userDataDir: dir })
  const { window } = launched
  await waitForReady(window)
  const banner = window.locator('[data-testid="local-ai-missing"]')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(banner).toContainText(/Local AI needs a one-time download \(2\.\d GB\)/)
  await expect(banner).toContainText('choose another AI source')
  await banner.locator('[data-testid="local-ai-missing-dismiss"]').click()
  await expect(banner).toHaveCount(0)
  // The choice itself was not touched.
  expect((await window.evaluate(() => window.api.ai.getStatus())).mode).toBe('local')
})

const STAGED = join(process.cwd(), 'resources', 'models')
const stagedHere = existsSync(join(STAGED, 'qwen3-4b-instruct-2507', 'manifest.sha256'))

test('MIG-4 — fresh install with the bundled model: checked once, then Local, with the "now built in" card', async () => {
  test.skip(!stagedHere, 'resources/models is not staged in this tree (scripts/fetch-bundled-models.mjs)')
  test.setTimeout(120_000)
  // Needs the staged model, so it opts in (every other launch hides it: _bundledModels.ts).
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '' }, bundledModels: true })
  const { window } = launched
  await waitForReady(window)
  // The background sha256 check of the bundled model completes the switch.
  await expect.poll(async () => (await window.evaluate(() => window.api.ai.getStatus())).mode, { timeout: 90_000 }).toBe('local')
  const card = window.locator('[data-testid="local-ai-intro"]')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText('Local AI is now built in')
  await expect(card).not.toHaveAttribute('data-variant', 'offer')
  await expect(window.locator('[data-testid="local-ai-missing"]')).toHaveCount(0)
})

const MODELS_SRC = process.env.LOCAL_AI_E2E_MODELS_DIR

test('MIG-5 — the offer\'s Download fetches from the host, verifies, and completes the switch to Local', async () => {
  test.skip(!MODELS_SRC || !existsSync(join(MODELS_SRC, 'nomic-embed-text-v1.5')), 'set LOCAL_AI_E2E_MODELS_DIR to a staged models folder')
  test.setTimeout(600_000)
  const catalog = JSON.parse(readFileSync(join(process.cwd(), 'resources', 'local-models.json'), 'utf8'))
  // The host layout, <bundleId>/<version>/<file>, served from the staged folder with Range.
  const routes = new Map<string, string>()
  for (const m of [...catalog.models, catalog.embedding]) {
    for (const f of [m.file, 'manifest.sha256', 'LICENSE.txt']) routes.set(`/models/${m.bundleId}/${m.version}/${f}`, join(MODELS_SRC!, m.bundleId, f))
  }
  const served: Array<{ path: string; range: string | null }> = []
  const server = http.createServer((req, res) => {
    const file = routes.get(req.url ?? '')
    served.push({ path: req.url ?? '', range: (req.headers.range as string) ?? null })
    if (!file || !existsSync(file)) {
      res.writeHead(404)
      return void res.end()
    }
    const size = statSync(file).size
    const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
    const from = m ? Number(m[1]) : 0
    res.writeHead(m ? 206 : 200, { 'content-length': String(size - from), ...(m ? { 'content-range': `bytes ${from}-${size - 1}/${size}` } : {}) })
    createReadStream(file, { start: from }).pipe(res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/models`
    const dir = profile({ aiMode: 'auto' })
    launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', PLEXII_BUNDLED_MODELS_DIR: noBundle(), PLEXII_MODEL_BASE_URL: base }, userDataDir: dir })
    const { window } = launched
    await waitForReady(window)
    const card = window.locator('[data-testid="local-ai-intro"][data-variant="offer"]')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.locator('[data-testid="local-ai-intro-download"]').click()
    await expect(window.locator('[data-testid="local-ai-intro-progress"]')).toBeVisible({ timeout: 15_000 })
    // Downloaded, verified, and the deferred switch completed.
    // 'local' when done; a failed download names its reason instead of timing out.
    await expect
      .poll(
        async () => {
          const err = await window.locator('[data-testid="local-ai-intro-error"]').textContent().catch(() => null)
          if (err) return `download error: ${err}`
          return (await window.evaluate(() => window.api.ai.getStatus())).mode
        },
        { timeout: 540_000, intervals: [2_000] }
      )
      .toBe('local')
    const built = window.locator('[data-testid="local-ai-intro"]')
    await expect(built).toContainText('Local AI is now built in', { timeout: 10_000 })
    await expect(window.locator('[data-testid="local-ai-intro-switch-back"]')).toContainText('Switch back to Plexii AI credits')
    // Manifests were read before the model bytes.
    const paths = served.map((s) => s.path)
    expect(paths.indexOf(`/models/${catalog.models[0].bundleId}/${catalog.models[0].version}/manifest.sha256`)).toBeLessThan(
      paths.indexOf(`/models/${catalog.models[0].bundleId}/${catalog.models[0].version}/${catalog.models[0].file}`)
    )
    const st = await window.evaluate(() => window.api.localAi.getStatus())
    expect(st.tiers.find((t) => t.id === st.activeTier)).toMatchObject({ installed: true, source: 'userData' })
    expect(st.embeddings.installed).toBe(true)
    expect(secretsOf(dir).localAiPending).toBeUndefined()
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
