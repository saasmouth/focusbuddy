// BM: an e2e result must not depend on whether the worktree staged the
// on-device models (tests/e2e/_bundledModels.ts). Run in a tree WITH
// resources/models staged, a fresh profile launched the default way sees no
// bundled model and does not start on Local; a launch that opts in sees it and
// does. In a tree without the models BM-2 has nothing to see, so it skips.

import { test, expect } from '@playwright/test'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const STAGED = join(process.cwd(), 'resources', 'models')
const staged = existsSync(STAGED) && readdirSync(STAGED).length > 0

let launched: LaunchedApp | undefined
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = undefined
})

async function sourceOf(l: LaunchedApp): Promise<{ bundled: boolean; provider: string }> {
  const st = await l.window.evaluate(() => window.api.localAi.getStatus())
  return { bundled: st.tiers.some((t) => t.source === 'bundle'), provider: st.provider }
}

test('BM-1 a default launch sees no bundled model, so a fresh profile does not start on Local', async () => {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  await waitForReady(launched.window)
  const s = await sourceOf(launched)
  expect(s.bundled, 'the staged models must be hidden from a default launch').toBe(false)
  expect(s.provider).not.toBe('local')
})

test('BM-2 a launch that opts in sees the staged model, and a fresh profile starts on Local', async () => {
  test.skip(!staged, 'this tree has no resources/models staged')
  launched = await launchApp({ env: { PLEXI_APP: 'preview3' }, bundledModels: true })
  await waitForReady(launched.window)
  await expect.poll(async () => (await sourceOf(launched!)).bundled, { timeout: 120_000 }).toBe(true)
  await expect.poll(async () => (await sourceOf(launched!)).provider, { timeout: 120_000 }).toBe('local')
})
