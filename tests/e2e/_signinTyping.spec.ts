// Diagnostic: does the sign-in password field drop typed characters?
//
// Reported 2026-10-08: "typing my password which includes upper and lower case
// and symbols and its not typing properly, although pasting it worked fine".
// Paste working narrows it to the per-keystroke path, so this types real
// keystrokes through the Electron window and compares the field's value to
// what was sent.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

const SECRET = 'Aa1!Bb2@Cc3#Dd4$Ee5%'

async function openSignIn(window: Page): Promise<void> {
  // The store's own e2e handle, same convention as __fbView.
  await window.evaluate(() => {
    const w = window as unknown as { __fbSignInPrompt?: { getState: () => { requestOpen: () => void } } }
    w.__fbSignInPrompt?.getState().requestOpen()
  })
  await expect(
    window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
  ).toBeVisible({ timeout: 5_000 })
}

function pwField(window: Page) {
  return window
    .locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')
    .locator('input[type="password"]')
    .first()
}

test('the sign-in password field keeps every typed character', async () => {
  launched = await launchApp()
  const { window } = launched
  const pageErrors: string[] = []
  window.on('pageerror', (e) => pageErrors.push(e.message))
  await waitForReady(window)
  await openSignIn(window)
  const pw = pwField(window)

  for (const delay of [60, 20, 0]) {
    await pw.fill('')
    await pw.click()
    await window.keyboard.type(SECRET, { delay })
    const got = await pw.inputValue()
    console.log(
      got === SECRET
        ? `delay=${delay}ms  OK  ${got.length}/${SECRET.length}`
        : `delay=${delay}ms  MISMATCH sent=${SECRET.length} got=${got.length} value=${JSON.stringify(got)}`
    )
    expect(got, `typing at ${delay}ms delay`).toBe(SECRET)
  }
  expect(pageErrors).toHaveLength(0)
})

test('Shift held across several characters is not swallowed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSignIn(window)
  const pw = pwField(window)
  await pw.click()

  // A physical keyboard sends ONE Shift keydown, then several character
  // keydowns, then one Shift keyup. keyboard.type() instead wraps each shifted
  // character in its own Shift down/up, so it never produces this stream —
  // which is exactly the stream a handler watching Shift would see.
  await window.keyboard.down('Shift')
  for (const k of ['KeyP', 'KeyL', 'KeyX']) await window.keyboard.press(k)
  await window.keyboard.up('Shift')
  console.log(`shift-held letters: ${JSON.stringify(await pw.inputValue())}`)
  expect(await pw.inputValue(), 'uppercase run with Shift held').toBe('PLX')

  // The same for symbols, which on a US layout are all Shift+digit.
  await pw.fill('')
  await pw.click()
  await window.keyboard.down('Shift')
  for (const k of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) await window.keyboard.press(k)
  await window.keyboard.up('Shift')
  console.log(`shift-held symbols: ${JSON.stringify(await pw.inputValue())}`)
  expect(await pw.inputValue(), 'symbol run with Shift held').toBe('!@#$')

  // And a mixed burst with Shift toggling throughout, no delay at all.
  await pw.fill('')
  await pw.click()
  for (let i = 0; i < 3; i++) {
    await window.keyboard.down('Shift')
    await window.keyboard.press('KeyA')
    await window.keyboard.press('Digit1')
    await window.keyboard.up('Shift')
    await window.keyboard.press('KeyB')
    await window.keyboard.press('Digit2')
  }
  console.log(`mixed burst: ${JSON.stringify(await pw.inputValue())}`)
  expect(await pw.inputValue(), 'mixed burst').toBe('A!b2A!b2A!b2')
})

test('characters survive typing while the renderer is busy', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openSignIn(window)
  const pw = pwField(window)
  await pw.click()

  // The two tests above run against a freshly seeded, idle profile. The report
  // came from an app that had just opened a 300MB workspace and was syncing,
  // and a React controlled input is exactly the thing that drops characters
  // under a stalled main thread: a re-render carrying a stale `value` resets
  // the DOM node and the keystrokes in between are gone. So stall it on
  // purpose and type into the stall.
  await window.evaluate(() => {
    const w = window as unknown as { __stall?: number }
    w.__stall = window.setInterval(() => {
      const until = Date.now() + 70
      while (Date.now() < until) {
        /* block the main thread */
      }
    }, 90)
  })

  await window.keyboard.type(SECRET, { delay: 0 })
  const got = await pw.inputValue()
  await window.evaluate(() => {
    const w = window as unknown as { __stall?: number }
    if (w.__stall) window.clearInterval(w.__stall)
  })
  console.log(
    got === SECRET
      ? `busy renderer: OK ${got.length}/${SECRET.length}`
      : `busy renderer: MISMATCH sent=${SECRET.length} got=${got.length} value=${JSON.stringify(got)}`
  )
  expect(got, 'typing while the renderer is stalled').toBe(SECRET)
})
