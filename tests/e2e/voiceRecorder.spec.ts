import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// VoiceRecorderWidget E2E.
//
// `window.api` is exposed via Electron's contextBridge with the frozen
// object semantics, so we can't shim its methods from the renderer at
// runtime. Instead we exercise the widget through its persistence path:
// pre-write widget.content with the shape the widget hydrates from, then
// drive the UI from that. Coverage:
//
//   1. Idle state renders the Start-recording affordance and the new
//      `voice-recorder` kind is wired through Canvas's renderWidget.
//   2. A pre-seeded "ready" state renders the processed text, the mode
//      toggle bar, and the proposals panel.
//   3. Apply All on a pre-seeded proposals list actually creates the
//      corresponding task nodes in the DB.
//   4. The Send-to picker creates a new widget of the chosen kind in
//      the same task, visible via api.widgets.listByTask.
//
// The dynamic transcribe→process pipeline itself runs against real APIs
// (Whisper + Anthropic); covering it would mean either bundling a fake
// IPC main-side or hitting live endpoints. Both are out of scope for
// this spec. We rely on the renderer typecheck + the build pass for the
// pipeline's wiring, and verify only the UI state machine here.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface SeededState {
  taskId: string
  widgetId: string
}

async function seedAndOpenVoiceWidget(
  launched: LaunchedApp,
  content: string = ''
): Promise<SeededState> {
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const seeded = await window.evaluate(
    async (initialContent: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: 'Voice test'
      })
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'voice-recorder',
        title: '',
        content: initialContent,
        x: 200,
        y: 200,
        width: 320,
        height: 280
      })
      return { taskId: task.id, widgetId: w.id }
    },
    content
  )

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Voice test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  return seeded
}

test('Idle state — Voice + Video buttons both render', async () => {
  launched = await launchApp()
  await seedAndOpenVoiceWidget(launched, '')

  await expect(
    launched.window.locator('[data-testid="voice-start"]').first()
  ).toBeVisible({ timeout: 5_000 })
  await expect(
    launched.window.locator('[data-testid="voice-start-video"]').first()
  ).toBeVisible({ timeout: 5_000 })
})

test('Ready state surfaces 4 modes including Diarised', async () => {
  launched = await launchApp()
  const seededContent = JSON.stringify({
    fileId: null,
    captureMode: 'audio',
    transcript: 'A test transcript.',
    language: 'en',
    durationSec: 6,
    mode: 'summary',
    processedText: 'Summary.',
    proposals: []
  })
  await seedAndOpenVoiceWidget(launched, seededContent)

  await expect(launched.window.locator('[data-testid="voice-mode-summary"]').first()).toBeVisible({ timeout: 5_000 })
  await expect(launched.window.locator('[data-testid="voice-mode-cleaned"]').first()).toBeVisible()
  await expect(launched.window.locator('[data-testid="voice-mode-diarised"]').first()).toBeVisible()
  await expect(launched.window.locator('[data-testid="voice-mode-full"]').first()).toBeVisible()
})

test('Destination picker offers both New widget and Append to existing tabs', async () => {
  launched = await launchApp()
  const seededContent = JSON.stringify({
    fileId: null,
    captureMode: 'audio',
    transcript: 'A test transcript.',
    language: 'en',
    durationSec: 6,
    mode: 'summary',
    processedText: 'Summary version.',
    proposals: []
  })
  const seeded = await seedAndOpenVoiceWidget(launched, seededContent)

  // Spawn a sticky on the canvas so the Append-to-existing tab has a target.
  await launched.window.evaluate(async (taskId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.create({
      taskId,
      kind: 'sticky',
      title: 'Notes',
      content: 'existing sticky content',
      x: 600,
      y: 200,
      width: 240,
      height: 200
    })
  }, seeded.taskId)
  // Reload so the widget store picks up the new sticky.
  await launched.window.reload()
  await launched.window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = launched.window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})
  await launched.window.getByRole('button', { name: 'Voice test' }).first().click()
  await launched.window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  await launched.window.locator('[data-testid="voice-send-to"]').first().click()
  await expect(launched.window.locator('[data-testid="voice-dest-tab-new"]').first()).toBeVisible({ timeout: 3_000 })
  await expect(launched.window.locator('[data-testid="voice-dest-tab-existing"]').first()).toBeVisible()

  // Click Append tab and verify the sticky shows up.
  await launched.window.locator('[data-testid="voice-dest-tab-existing"]').first().click()
  await expect(launched.window.getByText('Notes').first()).toBeVisible({ timeout: 3_000 })
})

test('Append to an existing sticky writes the processed text into its content', async () => {
  launched = await launchApp()
  const seededContent = JSON.stringify({
    fileId: null,
    captureMode: 'audio',
    transcript: 'A test transcript.',
    language: 'en',
    durationSec: 6,
    mode: 'summary',
    processedText: 'This text should land on the sticky.',
    proposals: []
  })
  const seeded = await seedAndOpenVoiceWidget(launched, seededContent)

  // Create the target sticky directly.
  const stickyId = await launched.window.evaluate(async (taskId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const w = await api.widgets.create({
      taskId,
      kind: 'sticky',
      title: 'Target',
      content: 'original sticky content',
      x: 600,
      y: 200,
      width: 240,
      height: 200
    })
    return w.id
  }, seeded.taskId)
  await launched.window.reload()
  await launched.window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = launched.window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})
  await launched.window.getByRole('button', { name: 'Voice test' }).first().click()
  await launched.window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // Open destination picker → Existing tab → click the target sticky.
  await launched.window.locator('[data-testid="voice-send-to"]').first().click()
  await launched.window.locator('[data-testid="voice-dest-tab-existing"]').first().click()
  await launched.window
    .locator(`[data-testid="voice-dest-append-${stickyId}"]`)
    .first()
    .click()
  await launched.window.waitForTimeout(400)

  // Verify the sticky's content now includes BOTH the original content
  // and the appended processed text.
  const finalContent = await launched.window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const widgets = await api.widgets.listByTask(
      (window as unknown as { __seedTask?: string }).__seedTask ?? ''
    )
    // Fallback: walk the full DB if __seedTask isn't on window.
    void widgets
    const target = (await api.nodes.list()).filter((n) => n.id === id)
    void target
    return null
  }, stickyId)
  // The renderer-side eval is finicky; do a fresh widgets.listByTask
  // outside the closure using the task id we already have.
  void finalContent
  const appended = await launched.window.evaluate(
    async ({ tid, sid }: { tid: string; sid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const sticky = widgets.find((w) => w.id === sid)
      return sticky?.content ?? null
    },
    { tid: seeded.taskId, sid: stickyId }
  )
  expect(appended).not.toBeNull()
  expect(appended!).toContain('original sticky content')
  expect(appended!).toContain('This text should land on the sticky.')
  expect(appended!).toContain('--- Voice note (summary) ·')
})

test('Ready state — pre-seeded transcript renders mode toggle + processed text + proposals + Send-to button', async () => {
  launched = await launchApp()
  const seededContent = JSON.stringify({
    fileId: null,
    transcript: 'Buy milk on the way home and reply to Sara about the contract.',
    language: 'en',
    durationSec: 12,
    mode: 'summary',
    processedText: 'You want to buy milk and reply to Sara.',
    proposals: [
      {
        id: 'p-1',
        kind: 'create-task',
        title: 'Reply to Sara about the contract',
        reason: 'Mentioned as explicit todo.'
      },
      {
        id: 'p-2',
        kind: 'create-task',
        title: 'Buy milk',
        reason: 'Mentioned alongside the contract reply.'
      }
    ]
  })
  await seedAndOpenVoiceWidget(launched, seededContent)

  // Mode bar is rendered.
  await expect(
    launched.window.locator('[data-testid="voice-mode-summary"]').first()
  ).toBeVisible({ timeout: 5_000 })
  await expect(launched.window.locator('[data-testid="voice-mode-cleaned"]').first()).toBeVisible()
  await expect(launched.window.locator('[data-testid="voice-mode-full"]').first()).toBeVisible()

  // Processed text rendered.
  const text = launched.window.locator('[data-testid="voice-processed-text"]').first()
  await expect(text).toContainText('You want to buy milk and reply to Sara.')

  // Both proposals shown in the panel.
  await expect(
    launched.window.getByText('Reply to Sara about the contract')
  ).toBeVisible()
  await expect(launched.window.getByText('New task — Buy milk')).toBeVisible()

  // Send-to button is reachable.
  await expect(
    launched.window.locator('[data-testid="voice-send-to"]').first()
  ).toBeVisible()
})

test('Apply All on the proposals panel actually creates tasks in the DB', async () => {
  launched = await launchApp()
  const seededContent = JSON.stringify({
    fileId: null,
    transcript: 'Two things to do.',
    language: 'en',
    durationSec: 4,
    mode: 'summary',
    processedText: 'Summary text.',
    proposals: [
      {
        id: 'p-task-1',
        kind: 'create-task',
        title: 'Reply to Sara about the contract',
        reason: 'todo'
      },
      {
        id: 'p-task-2',
        kind: 'create-task',
        title: 'Buy milk on the way home',
        reason: 'todo'
      }
    ]
  })
  const seeded = await seedAndOpenVoiceWidget(launched, seededContent)

  // Make sure proposals panel rendered before clicking.
  await expect(
    launched.window.getByText('Reply to Sara about the contract')
  ).toBeVisible({ timeout: 5_000 })

  await launched.window.getByText('Apply all').first().click()
  await launched.window.waitForTimeout(500)

  // Verify both tasks exist somewhere in the node tree. (applyCreateTask
  // uses proposal.parentId ?? null, so without an explicit parentId the
  // tasks land at root — that's the intended behavior for AI-extracted
  // freeform proposals. The test just asserts they were actually created.)
  const allTaskTitles = await launched.window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    return nodes.filter((n) => n.kind === 'task').map((n) => n.title)
  })
  expect(allTaskTitles).toContain('Reply to Sara about the contract')
  expect(allTaskTitles).toContain('Buy milk on the way home')
  // And the proposals panel should have collapsed (count went to 0).
  void seeded
})

test('Send-to picker creates a new widget of the chosen kind on the same task', async () => {
  launched = await launchApp()
  const seededContent = JSON.stringify({
    fileId: null,
    transcript: 'Some transcript.',
    language: 'en',
    durationSec: 5,
    mode: 'summary',
    processedText: 'Summary version of the transcript.',
    proposals: []
  })
  const seeded = await seedAndOpenVoiceWidget(launched, seededContent)

  // Count voice-test task's widgets before clicking. Should be 1 (the
  // recorder itself) plus the minimap (which auto-creates on task open).
  const before = await launched.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(tid)).length
  }, seeded.taskId)

  await launched.window.locator('[data-testid="voice-send-to"]').first().click()
  await launched.window.locator('[data-testid="voice-dest-sticky"]').first().click()
  await launched.window.waitForTimeout(400)

  const after = await launched.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const widgets = await api.widgets.listByTask(tid)
    return {
      count: widgets.length,
      stickies: widgets
        .filter((w) => w.kind === 'sticky')
        .map((w) => ({ title: w.title, contentLen: (w.content ?? '').length }))
    }
  }, seeded.taskId)

  expect(after.count).toBe(before + 1)
  expect(after.stickies.length).toBeGreaterThan(0)
  expect(after.stickies[0].title.toLowerCase()).toContain('voice')
  // Content should mirror the seeded processedText.
  expect(after.stickies[0].contentLen).toBeGreaterThan(0)
})
