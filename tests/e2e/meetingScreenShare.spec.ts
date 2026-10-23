// E2E verification for PlexiMeet screen sharing.
//
// Real getDisplayMedia (OS picker + desktopCapturer) cannot run headless, so the
// meeting itself is entered by driving the __fbMeetingRoom store directly
// (status: 'in') rather than a real getUserMedia join — the same test-hook
// pattern the store's own comment documents. navigator.mediaDevices.getDisplayMedia
// is monkeypatched in-page to return a canvas.captureStream() MediaStream so the
// REAL startScreenShare/stopScreenShare/toggleScreenShare store code executes
// (track wiring, state transitions, layout switch, sender bookkeeping) without
// ever touching Electron's session.setDisplayMediaRequestHandler or a real
// screen/window capture. That main-process handler is verified separately by a
// direct source read (see the tester's report).
//
// Peer screen routing (ontrack → participant.screenStream keyed by announced
// stream id) is simulated by writing participant state directly, since a second
// live peer connection is not available in this harness. The routing logic
// itself (announcedScreenSid matching) and the glare guard are verified by
// source read, not exercised end-to-end here.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, gotoView, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Force the store into an active solo meeting without any real media call, then
// hand back the window. Mirrors the store's own documented test-hook contract.
async function enterFakeMeeting(window: LaunchedApp['window'], roomId: string): Promise<void> {
  await window.evaluate((id) => {
    const w = window as unknown as {
      __fbMeetingRoom?: { setState: (partial: Record<string, unknown>) => void }
    }
    w.__fbMeetingRoom?.setState({
      status: 'in',
      roomId: id,
      title: 'Screen Share Test',
      localStream: null,
      participants: {},
      error: null,
      layout: 'stage'
    })
  }, roomId)
  await window.waitForSelector('[data-testid="meeting-window"]', { timeout: 5_000 })
}

// Replace getDisplayMedia with a canvas capture so the real store code path
// (startScreenShare/pushScreenTo/stopScreenShare) runs against a real
// MediaStream, without invoking Electron's screen-capture permission/picker.
async function stubDisplayMedia(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#3355ff'
      ctx.fillRect(0, 0, 320, 180)
    }
    const stream = (canvas as unknown as { captureStream: (fps?: number) => MediaStream }).captureStream(5)
    ;(navigator.mediaDevices as unknown as { getDisplayMedia: () => Promise<MediaStream> }).getDisplayMedia =
      async () => stream
  })
}

// ── Test 1: control button renders in both stage and collaborate layouts ───────

test('1 — Share your screen control renders in stage and collaborate layouts', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enterFakeMeeting(window, 'meet-share-1')

  const overlay = window.locator('[data-testid="meeting-window"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('[aria-label="Share your screen"]')).toBeVisible()

  // Switch to collaborate (docked) layout; the same control must still render.
  await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { setLayout: (l: string) => void } } }
    w.__fbMeetingRoom?.getState().setLayout('collaborate')
  })
  await expect(window.locator('[data-testid="meeting-window"][data-meeting-layout="collaborate"]')).toBeVisible()
  await expect(window.locator('[aria-label="Share your screen"]')).toBeVisible()
})

// ── Test 2: store exposes the contract (actions + fields) ──────────────────────

test('2 — meetingRoom store exposes startScreenShare/stopScreenShare/toggleScreenShare and screen fields', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const shape = await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => Record<string, unknown> } }
    const s = w.__fbMeetingRoom?.getState()
    if (!s) return null
    return {
      hasStart: typeof s.startScreenShare === 'function',
      hasStop: typeof s.stopScreenShare === 'function',
      hasToggle: typeof s.toggleScreenShare === 'function',
      screenStreamField: 'screenStream' in s,
      sharingScreenField: 'sharingScreen' in s,
      sharingScreenInitial: s.sharingScreen,
      screenStreamInitial: s.screenStream
    }
  })

  expect(shape).toBeTruthy()
  expect(shape!.hasStart).toBe(true)
  expect(shape!.hasStop).toBe(true)
  expect(shape!.hasToggle).toBe(true)
  expect(shape!.screenStreamField).toBe(true)
  expect(shape!.sharingScreenField).toBe(true)
  expect(shape!.sharingScreenInitial).toBe(false)
  expect(shape!.screenStreamInitial).toBeNull()
})

// ── Test 3: real store code path — start then stop a share via stubbed display media ─

test('3 — toggling Share your screen runs real store logic: state, layout, and tile render', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enterFakeMeeting(window, 'meet-share-3')
  await stubDisplayMedia(window)

  const overlay = window.locator('[data-testid="meeting-window"]')
  await overlay.locator('[aria-label="Share your screen"]').click()

  // Real startScreenShare: sets sharingScreen, screenStream, and switches layout
  // to 'collaborate' (this is a genuine state read, not an assertion of intent).
  await expect
    .poll(async () =>
      window.evaluate(() => {
        const w = window as unknown as { __fbMeetingRoom?: { getState: () => Record<string, unknown> } }
        const s = w.__fbMeetingRoom?.getState()
        return s ? { sharing: s.sharingScreen, layout: s.layout, hasStream: !!s.screenStream } : null
      })
    , { timeout: 4_000 })
    .toEqual({ sharing: true, layout: 'collaborate', hasStream: true })

  // The docked overlay now shows a screen tile labelled "Your screen".
  await expect(window.locator('[data-testid="meeting-screen-me"]')).toBeVisible({ timeout: 3_000 })
  await expect(window.locator('text=Your screen')).toBeVisible()
  // The control now reads "Stop sharing your screen" and is active.
  await expect(window.locator('[aria-label="Stop sharing your screen"]')).toBeVisible()

  // Switch to stage: presentation layout (screen tile + filmstrip) must render.
  await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { setLayout: (l: string) => void } } }
    w.__fbMeetingRoom?.getState().setLayout('stage')
  })
  await expect(window.locator('[data-meeting-layout="stage"] [data-testid="meeting-screen-me"]')).toBeVisible()

  // Stop sharing via the real control — real stopScreenShare code path.
  await window.locator('[aria-label="Stop sharing your screen"]').click()

  await expect
    .poll(async () =>
      window.evaluate(() => {
        const w = window as unknown as { __fbMeetingRoom?: { getState: () => Record<string, unknown> } }
        const s = w.__fbMeetingRoom?.getState()
        return s ? { sharing: s.sharingScreen, hasStream: !!s.screenStream } : null
      })
    , { timeout: 4_000 })
    .toEqual({ sharing: false, hasStream: false })

  await expect(window.locator('[data-testid="meeting-screen-me"]')).toHaveCount(0)
  await expect(window.locator('[aria-label="Share your screen"]')).toBeVisible()
})

// ── Test 4: a peer's shared screen renders separately from their camera tile ───

test('4 — a peer with screenStream renders a labelled screen tile plus their own camera tile', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enterFakeMeeting(window, 'meet-share-4')

  // Simulate the outcome of ontrack routing a peer's announced screen stream:
  // participant.screenStream populated, participant.stream (camera) untouched/null.
  // This is a state simulation, not a real second peer connection.
  await window.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const stream = (canvas as unknown as { captureStream: (fps?: number) => MediaStream }).captureStream(5)
    const w = window as unknown as {
      __fbMeetingRoom?: { getState: () => { participants: Record<string, unknown> }; setState: (p: Record<string, unknown>) => void }
    }
    const store = w.__fbMeetingRoom
    if (!store) return
    store.setState({
      participants: {
        ...store.getState().participants,
        peer1: {
          accountId: 'peer1',
          handle: 'peer_one',
          firstName: 'Pat',
          lastName: 'Presenter',
          stream: null,
          screenStream: stream,
          connected: true
        }
      }
    })
  })

  // Peer's screen tile, separate from any camera tile, labelled with their name.
  await expect(window.locator('[data-testid="meeting-screen-peer1"]')).toBeVisible({ timeout: 3_000 })
  await expect(window.locator('text=Pat Presenter · screen')).toBeVisible()
  // Camera tile for the peer still renders in the filmstrip (no camera stream yet
  // → shows the "Connecting…" / initials placeholder, never the screen content).
  await expect(window.locator('[data-testid="meeting-tile-peer1"]')).toBeVisible()
})

// ── Test 5 (regression): dock-side geometry ─────────────────────────────────────

test('5 — collaborate dock-side buttons switch data-dock-side and panel geometry', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enterFakeMeeting(window, 'meet-share-5')

  await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { setLayout: (l: string) => void } } }
    w.__fbMeetingRoom?.getState().setLayout('collaborate')
  })
  const overlay = window.locator('[data-testid="meeting-window"]')
  await expect(overlay).toHaveAttribute('data-meeting-layout', 'collaborate')

  for (const side of ['left', 'top', 'bottom', 'right'] as const) {
    await window.locator(`[data-testid="meeting-dock-${side}"]`).click()
    await expect(overlay).toHaveAttribute('data-dock-side', side)
  }
})

// ── Test 6 (regression): meeting survives navigation while docked ──────────────

test('6 — collaborate meeting survives navigating to Documents (goDocuments)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enterFakeMeeting(window, 'meet-share-6')

  await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { setLayout: (l: string) => void } } }
    w.__fbMeetingRoom?.getState().setLayout('collaborate')
  })
  await expect(window.locator('[data-testid="meeting-window"][data-meeting-layout="collaborate"]')).toBeVisible()

  await gotoView(window, 'goDocuments')
  await window.waitForTimeout(500)

  // The docked meeting window is still mounted (global store survives navigation).
  await expect(window.locator('[data-testid="meeting-window"][data-meeting-layout="collaborate"]')).toBeVisible()
  const status = await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { status: string } } }
    return w.__fbMeetingRoom?.getState().status
  })
  expect(status).toBe('in')
})

// ── Test 7 (regression): transcribe toggle still flips transcribing ────────────

test('7 — transcribe control toggles the transcribing state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await enterFakeMeeting(window, 'meet-share-7')

  const before = await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { transcribing: boolean } } }
    return w.__fbMeetingRoom?.getState().transcribing
  })
  expect(before).toBe(false)

  // The control is recording-under-consent since 6e68bb9a (DEC-098 M1); it
  // still drives the room's transcribing state.
  await window.locator('[aria-label="Start recording — everyone will be asked"]').click()
  await window.waitForTimeout(200)

  const after = await window.evaluate(() => {
    const w = window as unknown as { __fbMeetingRoom?: { getState: () => { transcribing: boolean } } }
    return w.__fbMeetingRoom?.getState().transcribing
  })
  expect(after).toBe(true)
  await expect(window.locator('[aria-label="Stop recording"]')).toBeVisible()
})
