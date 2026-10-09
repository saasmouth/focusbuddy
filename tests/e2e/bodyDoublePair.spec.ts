// Two real PlexiDesk instances, two real accounts, one real signal server:
// pick the same body-double preference, get matched, start the session, and
// see each other in a private PlexiiMeet room over an actual WebRTC
// connection (Chromium's fake camera and microphone stand in for hardware).
//
// This is the check the unit tests cannot make: that the match, the pair room,
// the mesh signalling and the media all line up end to end. It needs a signal
// server it can sign accounts up on, and an app build that points at it, so it
// is opt-in:
//
//   cd ../focusbuddy-signal && npm run build && \
//     DB_PATH=./data-test/bd-e2e.db PORT=8802 node dist/server.js &
//   VITE_SIGNAL_HTTP_URL=http://localhost:8802 VITE_SIGNAL_WS_URL=ws://localhost:8802/ws npm run build
//   BODY_DOUBLE_E2E_SIGNAL=http://localhost:8802 npx playwright test tests/e2e/bodyDoublePair.spec.ts
//
// Rebuild without the VITE_SIGNAL_* overrides afterwards.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const SIGNAL = process.env.BODY_DOUBLE_E2E_SIGNAL
test.skip(!SIGNAL, 'set BODY_DOUBLE_E2E_SIGNAL to a local signal server (see header)')
test.setTimeout(120_000)

const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

let apps: LaunchedApp[] = []
test.afterEach(async () => {
  for (const a of apps) await a.dispose()
  apps = []
})

async function signUp(page: Page, name: string): Promise<string> {
  const email = `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  const result = await page.evaluate(
    async ({ email, name }) => {
      const store = (window as unknown as { __fbAccount: { getState: () => any } }).__fbAccount
      const r = await store.getState().signup({ email, password: 'password123', handle: name, firstName: `Real${name}`, lastName: 'Person' })
      return { ok: r.ok, id: store.getState().account?.id ?? null, error: r.error ?? null }
    },
    { email, name }
  )
  expect(result.ok, `signup ${name}: ${result.error}`).toBe(true)
  return result.id as string
}

async function openAndFind(page: Page, mode: string): Promise<void> {
  await page.locator('button[aria-label="Body double"]').click()
  await expect(page.locator('[data-testid="body-double-dialog"]')).toBeVisible()
  await page.locator(`[data-testid="body-double-mode-${mode}"]`).click()
  // The plan check resolves after sign-in; the Find button appears once it does.
  await expect(page.locator('[data-testid="body-double-find"]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-testid="body-double-find"]').click()
}

// The partner's tile as the meeting store sees it: connected, with live tracks.
async function remoteMedia(page: Page): Promise<{ connected: boolean; handle: string | null; firstName: unknown; kinds: string[] }> {
  return page.evaluate(() => {
    const room = (window as unknown as { __fbMeetingRoom: { getState: () => any } }).__fbMeetingRoom.getState()
    const p = Object.values(room.participants)[0] as any
    if (!p) return { connected: false, handle: null, firstName: null, kinds: [] }
    const kinds = p.stream ? p.stream.getTracks().filter((t: MediaStreamTrack) => t.readyState === 'live').map((t: MediaStreamTrack) => t.kind).sort() : []
    return { connected: p.connected, handle: p.handle, firstName: p.firstName ?? null, kinds }
  })
}

async function pair(mode: string): Promise<[Page, Page]> {
  const a = await launchApp({ extraArgs: FAKE_MEDIA })
  const b = await launchApp({ extraArgs: FAKE_MEDIA })
  apps = [a, b]
  await waitForReady(a.window)
  await waitForReady(b.window)
  await signUp(a.window, 'bdea')
  await signUp(b.window, 'bdeb')
  await openAndFind(a.window, mode)
  await openAndFind(b.window, mode)
  for (const w of [a.window, b.window]) {
    await expect(w.locator('[data-testid="body-double-start"]')).toBeVisible({ timeout: 20_000 })
  }
  return [a.window, b.window]
}

test('happy to talk: matched strangers see and hear each other in a private room', async () => {
  const [a, b] = await pair('open')
  const handleSeenByA = await a.locator('[data-testid="body-double-partner"]').textContent()
  const handleSeenByB = await b.locator('[data-testid="body-double-partner"]').textContent()

  await a.locator('[data-testid="body-double-start"]').click()
  await b.locator('[data-testid="body-double-start"]').click()

  for (const w of [a, b]) {
    const overlay = w.locator('[data-testid="meeting-window"]')
    await expect(overlay).toBeVisible({ timeout: 15_000 })
    await expect(overlay).toHaveAttribute('data-meeting-layout', 'collaborate')
    await expect(w.locator('[data-testid="body-double-mode-line"]').first()).toContainText('Happy to talk')
    // A stranger's room offers no recording, invite or screen share.
    await expect(overlay.locator('[aria-label="Invite people"]')).toHaveCount(0)
    await expect(overlay.locator('[aria-label^="Start recording"]')).toHaveCount(0)
    await expect(overlay.locator('[aria-label="Share your screen"]')).toHaveCount(0)
  }

  // The WebRTC connection forms and carries camera and microphone, both ways.
  await expect.poll(() => remoteMedia(a), { timeout: 30_000 }).toMatchObject({ connected: true, kinds: ['audio', 'video'] })
  await expect.poll(() => remoteMedia(b), { timeout: 30_000 }).toMatchObject({ connected: true, kinds: ['audio', 'video'] })
  // Each knows the other only by session handle — never their real name.
  const ra = await remoteMedia(a)
  const rb = await remoteMedia(b)
  expect(ra.handle).toBe(handleSeenByA)
  expect(rb.handle).toBe(handleSeenByB)
  expect(ra.firstName).toBeNull()
  expect(rb.firstName).toBeNull()
  await expect(a.locator('[data-testid="meeting-window"]')).not.toContainText('Realbde')

  // Chat rides alongside.
  await a.locator('[data-testid="body-double-dialog"] input').fill('hi from A')
  await a.keyboard.press('Enter')
  await expect(b.locator('[data-testid="body-double-dialog"]')).toContainText('hi from A', { timeout: 10_000 })

  // B hides the panel and keeps working with the video docked.
  await b.keyboard.press('Escape')
  await expect(b.locator('[data-testid="body-double-dialog"]')).toHaveCount(0)
  await expect(b.locator('[data-testid="meeting-window"]')).toBeVisible()

  // Ending from one side ends it for both: the room closes, and B's panel
  // comes back to say why the video went away.
  await a.locator('[data-testid="body-double-end"]').click()
  await expect(a.locator('[data-testid="meeting-window"]')).toHaveCount(0)
  await expect(b.locator('[data-testid="body-double-toast"]')).toContainText('Your partner ended the session', { timeout: 10_000 })
  await expect(b.locator('[data-testid="meeting-window"]')).toHaveCount(0)
})

test('silent: cameras only — no microphone is sent and there is no chat', async () => {
  const [a, b] = await pair('silent')
  await a.locator('[data-testid="body-double-start"]').click()
  await b.locator('[data-testid="body-double-start"]').click()

  await expect.poll(() => remoteMedia(a), { timeout: 30_000 }).toMatchObject({ connected: true, kinds: ['video'] })
  await expect.poll(() => remoteMedia(b), { timeout: 30_000 }).toMatchObject({ connected: true, kinds: ['video'] })
  for (const w of [a, b]) {
    await expect(w.locator('[data-testid="body-double-mode-line"]').first()).toContainText('Silent')
    await expect(w.locator('[data-testid="meeting-window"] [aria-label="Mute"], [data-testid="meeting-window"] [aria-label="Unmute"]')).toHaveCount(0)
    await expect(w.locator('[data-testid="body-double-dialog"] input')).toHaveCount(0)
  }

  // Block: the session ends for both.
  await b.locator('[data-testid="body-double-block"]').click()
  await expect(a.locator('[data-testid="body-double-toast"]')).toContainText('Your partner ended the session', { timeout: 10_000 })
  await expect(a.locator('[data-testid="meeting-window"]')).toHaveCount(0)
  await expect(b.locator('[data-testid="meeting-window"]')).toHaveCount(0)
})
