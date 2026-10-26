// Marketing capture, stage 1: create the private capture profile's database.
// Sweep only (underscore): never part of the suite.
import { test } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

test('init capture profile', async () => {
  const app = await launchApp({ userDataDir: process.env.MK_PROFILE! })
  await waitForReady(app.window)
  await app.window.waitForTimeout(1500)
  await app.app.close()
})
