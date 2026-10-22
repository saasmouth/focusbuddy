/**
 * E2E: importing a Microsoft Visio .vsdx into PlexiDraw.
 *
 * We write a real (tiny) .vsdx to a temp path, mock the main-process open
 * dialog to return it, click "Import Visio" in the Documents hub, and assert a
 * new map document opens with the imported shapes and connector — proving the
 * whole unzip → parse → create-document → editor pipeline, not just a function.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { zipSync, strToU8 } from 'fflate'
import { writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

const PAGE = `<?xml version="1.0"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Shapes>
    <Shape ID="1" Master="3"><Cell N="PinX" V="1"/><Cell N="PinY" V="10"/><Cell N="Width" V="1.5"/><Cell N="Height" V="0.75"/><Text>Kickoff</Text></Shape>
    <Shape ID="2" Master="2"><Cell N="PinX" V="1"/><Cell N="PinY" V="8"/><Cell N="Width" V="1.5"/><Cell N="Height" V="0.75"/><Text>Approve?</Text></Shape>
    <Shape ID="5"><Cell N="BeginX" V="1"/><Cell N="EndX" V="1"/><Text>then</Text></Shape>
  </Shapes>
  <Connects>
    <Connect FromSheet="5" FromCell="BeginX" ToSheet="1" ToCell="PinX"/>
    <Connect FromSheet="5" FromCell="EndX" ToSheet="2" ToCell="PinX"/>
  </Connects>
</PageContents>`

function writeVsdx(path: string): void {
  const zip = zipSync({
    'visio/pages/page1.xml': strToU8(PAGE),
    'visio/masters/masters.xml': strToU8('<Masters><Master ID="2" NameU="Decision"/><Master ID="3" NameU="Process"/></Masters>'),
    'visio/pages/pages.xml': strToU8('<Pages><Page Name="Launch flow"/></Pages>')
  })
  writeFileSync(path, Buffer.from(zip))
}

async function openDocumentsHub(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
}

test('MIV-1 — import a .vsdx: shapes and connector land in a new PlexiMap', async () => {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  const path = join(tmpdir(), `plexi-vsdx-${process.pid}.vsdx`)
  written.push(path)
  writeVsdx(path)

  // Point the main-process open dialog at our temp file.
  await app.evaluate(async ({ dialog }, filePath) => {
    // @ts-expect-error test override
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, path)

  await openDocumentsHub(window)
  await window.locator('[data-testid="documents-import-vsdx"]').click()

  // The imported map opens in the editor (its toolbar is the definitive signal).
  await expect(window.locator('[data-testid="diagram-tool-select"]')).toBeVisible({ timeout: 10_000 })

  // Both 2-D shapes imported as nodes (the connector is an edge, not a node).
  await expect(window.locator('.react-flow__node')).toHaveCount(2, { timeout: 6_000 })
  await expect(window.locator('.react-flow__node')).toContainText(['Kickoff'])
  await expect(window.locator('.react-flow__node')).toContainText(['Approve?'])

  // The connector imported as an edge.
  await expect(window.locator('.react-flow__edge')).toHaveCount(1, { timeout: 6_000 })
})
