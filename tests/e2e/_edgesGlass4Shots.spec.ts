import { test } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, switchArea } from './_helpers'

// Edges + Glass Phase 4 frames: the deferred areas join the system. Throwaway.
//   doc      — the document editor (toolbar, fields, side panel chrome)
//   sheet    — the spreadsheet editor (toolbar selects, grid, tab strip)
//   office   — the PlexiOffice shell home (drive, account bar, ask)
//   messages — the comms chat view (pane dividers, hand-rolled fields now fb-field)
// Directory-sweep matrix: dark + atelier + light. 2x capture (no gemstone here).

const OUT = process.env.SHOT_DIR ?? '/tmp'
const THEMES = (process.env.THEMES ?? 'dark,atelier,light').split(',')
const FRAMES = (process.env.FRAMES ?? 'doc,sheet,office,messages').split(',')

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})
type Page = import('@playwright/test').Page

async function openDocumentsHub(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await window.getByRole('heading', { name: 'Documents', level: 1 }).waitFor({ timeout: 8_000 })
}

async function startBlank(window: Page, type: 'Document' | 'Spreadsheet'): Promise<void> {
  const blankRowContainer = window.locator('text=Or start blank:').locator('..')
  await blankRowContainer.locator('button', { hasText: type }).first().click()
}

for (const theme of THEMES) {
  for (const frame of FRAMES) {
    test(`edges+glass 4: ${frame}, ${theme}`, async () => {
      test.setTimeout(120_000)
      launched = await launchApp()
      const { window, app } = launched
      await waitForReady(window)
      const scale = 2
      const zoom = () => app.evaluate(({ BrowserWindow }, z) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z) }, scale)
      await window.setViewportSize({ width: 1440 * scale, height: 900 * scale })
      await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
      await window.reload()
      await waitForReady(window)
      await zoom()
      if (frame === 'doc' || frame === 'sheet') {
        await openDocumentsHub(window)
        await startBlank(window, frame === 'doc' ? 'Document' : 'Spreadsheet')
        if (frame === 'doc') {
          const editor = window.locator('[contenteditable="true"]').first()
          await editor.waitFor({ state: 'visible', timeout: 8_000 })
          await editor.click()
          await editor.type('Edges from light, not outlines.')
        } else {
          await window.waitForSelector('[data-testid="cell-0-0"]', { timeout: 8_000 }).catch(() => undefined)
        }
        await window.waitForTimeout(900)
      } else if (frame === 'office') {
        await switchArea(window, 'office')
        await window.waitForTimeout(1_200)
      } else if (frame === 'messages') {
        await switchArea(window, 'office')
        await window.locator('[data-testid="office-comms-app-chat"]').click()
        await window.waitForTimeout(1_200)
      }
      await window.screenshot({ path: `${OUT}/eg4-${frame}-${theme}.png` })
    })
  }
}
