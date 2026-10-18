import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "Make it so widgets and apps both plexii and connected can be dragged to a
// dashboard and configured, and remain there."
//
// REMAIN THERE is the half that a drop handler alone does not give you, so it
// is what this measures: drop, reload, and look again. The layout lives in
// localStorage and the object itself is a widget FILE (docs/widget-files.md),
// so a card that renders after a reload proves both halves persisted.

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close().catch(() => {}); launched = null })

// The app does not land on the dashboard, so go there first. The grid only
// exists on the Home surface.
async function openDashboard(window: LaunchedApp['window']): Promise<void> {
  await window.evaluate(() => {
    const v = (window as unknown as {
      __fbView?: { getState: () => { goHome: () => void } }
    }).__fbView
    v?.getState().goHome()
  })
  await window.waitForSelector('[data-testid="home-widget-grid"]', { timeout: 20_000 })
  await window.waitForTimeout(500)
}

// Must match lib/widgetCatalog's DRAG_MIME exactly — a wrong value here
// makes the grid ignore the drop, and the test fails for the wrong reason.
const DRAG_MIME = 'application/x-fb-widget-kind'
const NEW_FILE_MIME = 'application/x-plexii-widget-new-file'

async function dropOnDashboard(
  window: LaunchedApp['window'],
  mime: string,
  payload: string
): Promise<void> {
  await window.evaluate(
    ({ mime, payload }) => {
      const grid = document.querySelector('[data-testid="home-widget-grid"]')
      if (!grid) throw new Error('no dashboard grid')
      const dt = new DataTransfer()
      dt.setData(mime, payload)
      grid.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      grid.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    { mime, payload }
  )
  await window.waitForTimeout(900)
}

const cardCount = (window: LaunchedApp['window'], widget: string): Promise<number> =>
  window.evaluate(
    (w) =>
      document.querySelectorAll(`[data-testid="home-widget-grid"] [data-widget="${w}"]`).length,
    widget
  )

test('a work widget dropped on a dashboard stays after a reload', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDashboard(window)

  const before = await cardCount(window, 'work-widget')
  await dropOnDashboard(window, NEW_FILE_MIME, 'sticky')
  expect(await cardCount(window, 'work-widget'), 'card did not appear on drop').toBe(before + 1)

  // The object must be a real widget FILE with no desk, not a desk widget.
  const files = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const list = await api.widgetFiles.list()
    return list.filter((f) => f.kind === 'sticky').length
  })
  expect(files, 'no widget file was created').toBeGreaterThan(0)

  await window.reload()
  await waitForReady(window)
  await openDashboard(window)
  expect(await cardCount(window, 'work-widget'), 'card did not survive a reload').toBe(before + 1)
})

test('a desk-only kind is refused, and says why', async () => {
  // A section arranges the desk it sits on, so it cannot be a file and cannot
  // live here. Refusing silently would read as a broken drop.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDashboard(window)

  const before = await cardCount(window, 'work-widget')
  await dropOnDashboard(window, DRAG_MIME, 'section')
  expect(await cardCount(window, 'work-widget'), 'a desk-only kind was placed').toBe(before)
  const notice = await window.evaluate(() => document.body.innerText)
  expect(notice, 'no explanation shown').toMatch(/only lives on one|arranges a desk/i)
})

test('a dropped widget can be filed into Files, without leaving the dashboard', async () => {
  // "Add a file button, so I can easily file new widgets, files and anything
  // not on a desk somewhere in files." A work widget is a documents row, so
  // the chip the office editors already use works here — what this proves is
  // that it is PRESENT where a deskless object actually appears, and that
  // locateDocument answers for a widget file rather than treating it as an
  // unknown document type.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDashboard(window)

  await dropOnDashboard(window, NEW_FILE_MIME, 'sticky')
  const card = window.locator('[data-widget="work-widget"]').first()
  await expect(card).toBeVisible({ timeout: 10_000 })

  // The file button is on the card itself. Matched by its testid, not by its
  // label: in compact mode the chip shows the folder name (or nothing at all
  // while it loads), so matching text asserts the copy rather than the button.
  const chip = card.locator('[data-testid="doc-filed-in-chip"]').first()
  await expect(chip, 'no file button on the dropped card').toBeVisible({ timeout: 8_000 })

  // And the filing API answers for a widget file.
  const located = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const files = await api.widgetFiles.list()
    const f = files.find((x) => x.kind === 'sticky')
    if (!f) return { ok: false as const, why: 'no widget file' }
    const loc = await api.fileManager.locateDocument(f.id)
    return { ok: true as const, answered: loc !== undefined }
  })
  expect(located.ok, JSON.stringify(located)).toBe(true)
  expect(located.ok && located.answered, 'locateDocument did not answer for a widget file').toBe(true)
})

test('a Plexii app tile lands as the right kind of card', async () => {
  // The app tiles drag a widget KIND, and most of those are not work-widget
  // files. Sent down the file path every one but Diagrams was refused with
  // "that arranges a desk" — wrong, and a strange thing to read about
  // PlexiDocs. An office kind lands as a document card instead.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDashboard(window)

  const before = await cardCount(window, 'office-document')
  await dropOnDashboard(window, DRAG_MIME, 'doc')
  expect(await cardCount(window, 'office-document'), 'PlexiDocs did not land').toBe(before + 1)
})

test('a kind with no dashboard card says exactly that, not something untrue', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openDashboard(window)

  await dropOnDashboard(window, DRAG_MIME, 'inbox')
  const text = await window.evaluate(() => document.body.innerText)
  // The honest message, not the desk-arrangement one.
  expect(text, 'wrong or missing explanation').toMatch(/no dashboard card for inbox yet/i)
  expect(text, 'claimed inbox arranges a desk, which is untrue').not.toMatch(/inbox arranges a desk/i)
})
