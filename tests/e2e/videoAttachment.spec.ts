// E2E verification for the 'video' chat attachment kind.
//
//   1. MessagesView renders attachment{kind:'video'} as a <video controls>
//      element with data-testid="attachment-video-<id>", not an <img> or a link.
//   2. ChatComposer: a video/* file uploads as kind 'video' and the pending chip
//      shows a <video>, not an <img>; 2b the mirror case for an image.
//   3. PlexiMeet's Message dialog (DEC-119) still offers a video message and is
//      honest about having nobody online.
//   4. The image / voice / file branches still render their own elements.
//
// The conversation pane and composer exist only in a signed-in session. These
// tests sign in through _fakeSignal: the session is seeded into the renderer's
// real stores and every request to the signal server (list, messages, the
// upload) is answered locally, so nothing reaches the production server and the
// upload's outcome is deterministic. (They used to broadcast fake state into
// every React useState dispatcher they could find, and when that missed, log
// "source-attested" and pass without checking anything.)
//
// What is NOT verified (requires two live peers and the real server):
//   - A video attachment delivered to and rendered by a second client.
//   - Video blob playback and the server-side store of the 'video' kind
//     (covered by signal-repo tests).
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, openProduct, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openChat(window: Page): Promise<void> {
  await suppressFeatureSpotlights(window)
  await openProduct(window, 'chat')
  await expect(window.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: 8_000 })
}

// ── Helper: build a minimal video-attachment message payload ──────────────────
function videoMsg(id: string, conv: string): object {
  return {
    id,
    conversationId: conv,
    fromAccount: 'acc_other',
    body: '',
    createdAt: Date.now() - 1000,
    reactions: [],
    replyCount: 0,
    attachment: {
      kind: 'video',
      id: 'att-video-001',
      name: 'message-video.webm',
      mimeType: 'video/webm',
      sizeBytes: 128000,
      durationMs: 5000
    }
  }
}

// ── Check 1: MessagesView renders video attachment as <video> ─────────────────
test('1 — video attachment renders as <video controls> with data-testid="attachment-video-<id>"', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)

  const conv = 'conv-video-test'
  const msgId = 'msg-video-e2e-001'
  await signInWithFakeSignal(window, { conversation: { id: conv, title: 'other' }, messages: [videoMsg(msgId, conv)] })

  const videoEl = window.locator(`[data-testid="attachment-video-${msgId}"]`)
  await expect(videoEl).toBeVisible({ timeout: 5_000 })
  expect(await videoEl.evaluate((el) => el.tagName.toLowerCase()), 'attachment element is a <video>').toBe('video')
  expect(await videoEl.evaluate((el) => (el as HTMLVideoElement).controls), '<video> has controls').toBe(true)
  // Not mistaken for the image/gif or file branch.
  await expect(window.locator(`[data-testid="attachment-image-${msgId}"]`)).toHaveCount(0)
  await expect(window.locator(`[data-testid="attachment-file-${msgId}"]`)).toHaveCount(0)
})

// ── Check 2: ChatComposer video file → kind 'video' → <video> preview chip ───
test('2 — ChatComposer: selecting a video file produces a <video> pending chip, not <img>', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)

  const fake = await signInWithFakeSignal(window, { conversation: { id: 'conv-composer-video', title: 'other' } })
  const fileInput = window.locator('[data-testid="composer-file-input"]')
  await expect(fileInput).toBeAttached({ timeout: 5_000 })
  // The kind is classified from file.type, so four bytes with a video MIME type
  // exercise the branch.
  await fileInput.setInputFiles({ name: 'test-clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0x00, 0x00, 0x00, 0x18]) })

  const chip = window.locator('[data-testid="composer-pending"]')
  await expect(chip).toBeVisible({ timeout: 5_000 })
  expect(fake.uploads, 'one upload, sent as kind video').toEqual([{ kind: 'video', bytes: 4 }])
  await expect(chip.locator('video'), 'pending chip shows a <video> thumbnail').toHaveCount(1)
  await expect(chip.locator('img'), 'pending chip shows no <img> for a video').toHaveCount(0)
  await expect(window.locator('[data-testid="composer-error"]')).toHaveCount(0)
})

// ── Check 2b: the mirror case — an image is still an image ────────────────────
test('2b — ChatComposer: an image file uploads as kind image with an <img> chip (the video branch did not swallow images)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)

  const fake = await signInWithFakeSignal(window, { conversation: { id: 'conv-composer-image', title: 'other' } })
  const fileInput = window.locator('[data-testid="composer-file-input"]')
  await expect(fileInput).toBeAttached({ timeout: 5_000 })
  await fileInput.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })

  const chip = window.locator('[data-testid="composer-pending"]')
  await expect(chip).toBeVisible({ timeout: 5_000 })
  expect(fake.uploads, 'one upload, sent as kind image').toEqual([{ kind: 'image', bytes: 4 }])
  await expect(chip.locator('img')).toHaveCount(1)
  await expect(chip.locator('video')).toHaveCount(0)
})

// ── Check 3: PlexiMeet's Message dialog after the video-message changes ───────
// (regression: video recording must not break the Message door. DEC-119
// replaced the popover picker with the Message dialog.)
test('3 — PlexiMeet Message dialog offers a video message and is honest with nobody online', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await suppressFeatureSpotlights(window)

  await openProduct(window, 'meet')
  await window.waitForSelector('[data-testid="pleximeet-view"]', { timeout: 8_000 })
  await window.locator('[data-testid="meet-message"]').click()
  const dialog = window.locator('[data-testid="message-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 3_000 })
  await expect(dialog.locator('[data-testid="message-kind-video"]'), 'a video message is offered').toBeVisible()
  // With no presence peers, the honest empty state.
  await expect(dialog.locator('[data-testid="message-to-input"]')).toHaveAttribute('placeholder', 'No teammates online right now.')
  await expect(window.locator('[data-testid="pleximeet-view"]')).toBeVisible()
})

// ── Check 4: No regressions — existing attachment kinds render correctly ───────
test('4 — no regressions: image / voice / file attachment branches still render correct elements', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openChat(window)

  const conv = 'conv-regression-test'
  const regressionMsgs = [
    { id: 'msg-img-reg', conversationId: conv, fromAccount: 'acc_other', body: '', createdAt: Date.now() - 4000, reactions: [], replyCount: 0, attachment: { kind: 'image', id: 'att-img', name: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 50000 } },
    { id: 'msg-voice-reg', conversationId: conv, fromAccount: 'acc_other', body: '', createdAt: Date.now() - 3000, reactions: [], replyCount: 0, attachment: { kind: 'voice', id: 'att-voice', name: 'Voice note', mimeType: 'audio/webm', sizeBytes: 20000, durationMs: 3000 } },
    { id: 'msg-file-reg', conversationId: conv, fromAccount: 'acc_other', body: '', createdAt: Date.now() - 2000, reactions: [], replyCount: 0, attachment: { kind: 'file', id: 'att-file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 80000 } }
  ]
  await signInWithFakeSignal(window, { conversation: { id: conv, title: 'other' }, messages: regressionMsgs })

  // Image → <img>, voice → <audio>, file → <a>, each under its own testid.
  for (const [tid, tag] of [
    ['attachment-image-msg-img-reg', 'img'],
    ['attachment-voice-msg-voice-reg', 'audio'],
    ['attachment-file-msg-file-reg', 'a']
  ] as const) {
    const el = window.locator(`[data-testid="${tid}"]`)
    await expect(el).toBeVisible({ timeout: 5_000 })
    expect(await el.evaluate((e) => e.tagName.toLowerCase()), `${tid} renders as <${tag}>`).toBe(tag)
  }
})
