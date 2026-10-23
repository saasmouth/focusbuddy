// The docked assistant composer is absolutely positioned OVER the transcript,
// so the transcript has to reserve room for it. That reservation used to be a
// fixed pb-44 (176px) — correct only while the composer happened to be that
// tall. Tag several references and the chips wrap onto more rows, the composer
// grows past 176px, and it covers the newest messages: the chat appears to
// vanish underneath the tags.
//
// This drives the invariant rather than the mention plumbing: however tall the
// composer becomes, the transcript must reserve at least that much.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('the transcript reserves whatever height the composer actually takes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // The overlaid composer appears as soon as the transcript has content:
  // fullscreenHome is `isFullscreen && messages.length === 0`. Sending one turn
  // is the state every real conversation is in.
  //
  // Into the Plexii hub. It used to be a "Plexii" row in the side menu;
  // cb832f33 (4.3.25) removed that row so the hub has one door, the wordmark
  // on the assistant itself (AssistantHeader, assistant-open-hub). The hub
  // page suppresses the floating assistant, so exactly one ChatPanel is on
  // screen, as before.
  await window.locator('[data-testid="assistant-pill"]').click()
  await window.locator('[data-testid="assistant-open-hub"]').click()
  await expect(window.locator('[data-testid="assistant-pill"]')).toHaveCount(0)
  const composer = window.locator('[data-testid="chat-composer"]')
  await expect(composer).toHaveCount(1)
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  await composer.click()
  await window.keyboard.type('Tell me about the plan', { delay: 5 })
  await window.keyboard.press('Enter')
  // The user's turn renders immediately; no model reply is needed for layout.
  await expect(window.locator('[data-testid="chat-scroll"]')).toContainText('Tell me about the plan', { timeout: 10_000 })
  await window.waitForTimeout(400)

  const read = async (): Promise<{ pad: number; composer: number; docked: boolean }> =>
    window.evaluate(() => {
      const scroll = document.querySelector('[data-testid="chat-scroll"]') as HTMLElement
      const form = document.querySelector('[data-testid="chat-composer"]')?.closest('form') as HTMLElement
      return {
        pad: Math.round(parseFloat(getComputedStyle(scroll).paddingBottom) || 0),
        composer: Math.round(form.getBoundingClientRect().height),
        // Only the docked composer overlays the transcript.
        docked: getComputedStyle(form).position === 'absolute'
      }
    })

  const before = await read()
  // The hub shows the docked composer once the transcript has a message (see
  // 5d0c1dd5): it must overlay, or this measures nothing. Asserted rather than
  // skipped, so a layout change cannot turn the check off silently.
  expect(before.docked, 'the composer is docked over the transcript').toBe(true)
  expect(before.pad, 'the reservation should cover the composer').toBeGreaterThanOrEqual(before.composer)

  // Grow the composer the way several wrapped reference chips would.
  await window.evaluate(() => {
    const form = document.querySelector('[data-testid="chat-composer"]')?.closest('form') as HTMLElement
    const filler = document.createElement('div')
    filler.id = 'fb-test-chips'
    filler.style.height = '180px'
    form.prepend(filler)
  })
  await window.waitForTimeout(500)

  const after = await read()
  console.log('  before ' + JSON.stringify(before) + '  after ' + JSON.stringify(after))
  expect(after.composer, 'the composer should have grown').toBeGreaterThan(before.composer)
  // The whole bug: this is where a fixed 176px stopped tracking and the
  // newest messages went under the composer.
  expect(after.pad, 'the reservation must follow the composer').toBeGreaterThanOrEqual(after.composer)
})
