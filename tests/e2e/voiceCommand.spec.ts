import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Voice prefs E2E. What remains of the original VoiceCommandFAB spec:
// the FAB itself was deleted in A3 (voice moved into the mascot, d055f25)
// and the voiceCommand proposals engine retired in A6/B0 (R30) — the prefs
// (hold mode, silence stop, voiceback) still drive the mascot voice UX and
// their persistence contract is what this covers.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function boot(): Promise<LaunchedApp> {
  const app = await launchApp()
  const { window } = app
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', {
    name: /Continue without account|Skip|Not now/i
  })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})
  return app
}


test('voiceCommand prefs round-trip through IPC', async () => {
  launched = await boot()
  const { window } = launched
  await waitForReady(window)
  const initial = await window.evaluate(() => window.api.voiceCommand.getPrefs())
  expect(initial.commandMode).toMatch(/press-hold|click-toggle/)
  expect(initial.autoStopSilenceMs).toBeGreaterThanOrEqual(1000)
  expect(typeof initial.voiceback).toBe('boolean')

  // Flip to click-toggle, change silence to 8s, disable voiceback.
  const next = await window.evaluate(() =>
    window.api.voiceCommand.setPrefs({
      commandMode: 'click-toggle',
      autoStopSilenceMs: 8000,
      voiceback: false
    })
  )
  expect(next.commandMode).toBe('click-toggle')
  expect(next.autoStopSilenceMs).toBe(8000)
  expect(next.voiceback).toBe(false)

  // Reload and confirm persistence.
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const after = await window.evaluate(() => window.api.voiceCommand.getPrefs())
  expect(after.commandMode).toBe('click-toggle')
  expect(after.autoStopSilenceMs).toBe(8000)
  expect(after.voiceback).toBe(false)

  // Restore defaults so this test doesn't pollute other test runs.
  await window.evaluate(() =>
    window.api.voiceCommand.setPrefs({
      commandMode: 'press-hold',
      autoStopSilenceMs: 5000,
      voiceback: true
    })
  )
})


