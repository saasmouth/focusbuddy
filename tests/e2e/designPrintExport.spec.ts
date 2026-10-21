import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, chooseCloudAiSource } from './_helpers'
import { readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// PlexiDesign print export: a "Print PDF (crop marks)" renders the design on a
// larger sheet (trim + bleed + crop-mark margin) in the main process. We mock the
// save dialog and drive the real design:export IPC, then read the PDF back to
// prove a real, larger print file is produced.

let launched: LaunchedApp | null = null
const written: string[] = []
test.afterEach(async () => {
  for (const p of written) if (existsSync(p)) rmSync(p)
  written.length = 0
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const DESIGN = {
  schemaVersion: 1,
  width: 800,
  height: 600,
  bleed: 18,
  background: { type: 'solid', color: '#ffddaa' },
  elements: [
    { id: 't1', type: 'text', x: 100, y: 100, w: 400, h: 80, z: 1, paragraphs: [{ runs: [{ text: 'Poster', fontSize: 48 }] }] }
  ]
}

test('DPX-1 — print PDF exports a real, larger-than-trim PDF with crop marks', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  // A fresh profile's AI source is Local since 4.3.39. Choose the cloud
  // source explicitly: it is what these specs assume, and it clears the
  // fixed "local AI missing" notice, which otherwise intercepts clicks on
  // the design toolbar and fails as if Design were broken.
  await chooseCloudAiSource(window)

  const path = join(tmpdir(), `plexi-design-print-${process.pid}.pdf`)
  written.push(path)

  await app.evaluate(async ({ dialog }, filePath) => {
    // @ts-expect-error test override
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, path)

  const res = await window.evaluate(async (design) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.design.export({ design: design as never, title: 'poster', format: 'pdf', printMarks: true })
  }, DESIGN)

  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)
  const buf = readFileSync(path)
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  // A print PDF (trim 800×600 + bleed 18 + 24 mark margin each side) is a real,
  // non-trivial file.
  expect(buf.length).toBeGreaterThan(1000)
})
