import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The desk hello through the real IPC path (4.3.55, main/deskWelcomeGate.ts).
// tests/unit/deskWelcomeGate.test.ts drives the gate against counting clients;
// this checks the shipped wiring: preload passes the options, the generated
// argument contract accepts them, and main answers an unasked hello with the
// gate's reason on a fresh profile, where Background AI tasks is off by
// default. A click ({ asked: true }) gets past the gate to the model call's own
// checks, which on this keyless profile stop before anything is sent.

type WelcomeApi = {
  api: {
    chat: {
      proactiveWelcome: (
        taskId: string,
        opts?: { asked?: boolean }
      ) => Promise<{ ok: boolean; reason?: string; needsApiKey?: boolean; error?: string }>
    }
  }
}

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('an unasked desk hello waits for Background AI tasks; a click gets past the gate', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const unasked = await window.evaluate(() =>
    (window as unknown as WelcomeApi).api.chat.proactiveWelcome('no-such-desk')
  )
  expect(unasked).toEqual({ ok: false, reason: 'background_ai_off' })

  const asked = await window.evaluate(() =>
    (window as unknown as WelcomeApi).api.chat.proactiveWelcome('no-such-desk', { asked: true })
  )
  expect(asked.reason).toBeUndefined()
  expect(asked.ok).toBe(false)
  // Past the gate: the model call's first checks (no key on a fresh profile,
  // then the desk lookup). Neither sends anything.
  expect(asked.needsApiKey === true || asked.error === 'Desk not found').toBe(true)
})
