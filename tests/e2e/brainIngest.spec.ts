// E2E: verifies window.api.brain.ingestWorkspace() (and the "Sync workspace to
// Brain" command-palette action) actually walks the workspace and upserts
// PlexiBrain knowledge entries for desks, documents, text widgets and Drive
// files — deterministically, with no AI key required, idempotent on re-run,
// and never touching hand-written entries.
//
// Fixture creation is driven through window.api (the IPC surface) per the
// tester playbook: creating a desk/widget/document/file through real pointer
// gestures is slow and fragile for this many fixtures, and the contract under
// test is the ingest function's DB behaviour, not a UI creation flow. The
// trigger itself (the "Sync workspace to Brain" command) and the Brain Map
// render ARE driven through real UI (Cmd+K + click) with a fresh marker
// planted just before, so the UI path is proven to call the real function —
// not assumed from a direct IPC call.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import type { KnowledgeEntry } from '../../src/shared/knowledge'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('ingestWorkspace indexes desks, documents, widgets and files; idempotent; leaves manual entries alone; Brain Map grows', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // ── (d) plant a manual entry BEFORE ingest, so we can prove it survives untouched ──
  const manual = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.create({ title: 'hand written', body: 'manual', tags: [] })
  })
  expect(manual.id, 'manual entry must be created').toBeTruthy()

  // ── baseline count N0 ──
  const n0 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.knowledge.list()).length
  })

  // ── plant one fixture of each ingestible kind ──
  const fixtures = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api

    // A desk (task node) to host the note widget.
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Brain Ingest Test Desk' })

    // A note widget on that desk with real prose content.
    const widget = await api.widgets.create({
      taskId: desk.id,
      kind: 'note',
      content: 'brain note body alpha',
      x: 100,
      y: 100
    })

    // A standalone Word-class document whose tiptap body contains real text.
    const doc = await api.documents.create({
      docType: 'doc',
      title: 'Brain Ingest Test Doc',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'doc body beta' }] }]
      }
    })

    // A Drive .txt file with real bytes so extractFileText has something to read.
    const bytes = new TextEncoder().encode('file body gamma')
    const file = await api.files.ingestBuffer({
      buffer: bytes.buffer,
      originalName: 'brain-ingest-test.txt',
      mimeType: 'text/plain',
      parentId: null
    })

    return { deskId: desk.id, widgetId: widget.id, docId: doc.id, fileId: file.id }
  })

  expect(fixtures.deskId).toBeTruthy()
  expect(fixtures.widgetId).toBeTruthy()
  expect(fixtures.docId).toBeTruthy()
  expect(fixtures.fileId).toBeTruthy()

  // ── (a) first ingest, called directly via the IPC surface ──
  const stats1 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })

  expect(stats1.desks, 'stats.desks').toBeGreaterThanOrEqual(1)
  expect(stats1.documents, 'stats.documents').toBeGreaterThanOrEqual(1)
  expect(stats1.widgets, 'stats.widgets').toBeGreaterThanOrEqual(1)
  expect(stats1.files, 'stats.files').toBeGreaterThanOrEqual(1)
  expect(stats1.created, 'stats.created on a run with brand-new fixtures').toBeGreaterThan(0)

  // ── (b) the brain now has entries whose bodies contain the fixture content ──
  const afterFirst: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })

  const noteEntry = afterFirst.find((e) => e.body.includes('brain note body alpha'))
  const docEntry = afterFirst.find((e) => e.body.includes('doc body beta'))
  const fileEntry = afterFirst.find((e) => e.body.includes('file body gamma'))

  expect(noteEntry, 'a knowledge entry body must contain the note widget text').toBeTruthy()
  expect(docEntry, 'a knowledge entry body must contain the document text').toBeTruthy()
  expect(
    fileEntry,
    'a knowledge entry body must contain the ingested .txt file text (proves extractFileText fed the brain, not just the filename)'
  ).toBeTruthy()

  const n1 = afterFirst.length
  expect(n1, 'entry count must have grown past baseline').toBeGreaterThan(n0)

  // ── (d) the manual entry planted before ingest is untouched ──
  const manualAfterFirst = afterFirst.find((e) => e.id === manual.id)
  expect(manualAfterFirst, 'manual entry must still exist after ingest').toBeTruthy()
  expect(manualAfterFirst!.body).toBe('manual')
  expect(manualAfterFirst!.title).toBe('hand written')
  expect(manualAfterFirst!.updatedAt).toBe(manual.updatedAt)

  // ── (c) second ingest, direct call again: idempotent, updates in place, no duplicate growth ──
  const stats2 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })
  expect(stats2.updated, 'second run must report updates (idempotent upsert path)').toBeGreaterThan(0)
  expect(stats2.created, 'second run must create nothing new for unchanged fixtures').toBe(0)

  const afterSecond: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  expect(afterSecond.length, 'knowledge count must NOT grow on the second ingest (no duplicates)').toBe(n1)

  // The same three fixture bodies must still resolve to exactly one entry
  // each (not two), and it must be the SAME row id, confirming upsert-by-
  // source, not a fresh insert.
  const noteEntries2 = afterSecond.filter((e) => e.body.includes('brain note body alpha'))
  const docEntries2 = afterSecond.filter((e) => e.body.includes('doc body beta'))
  const fileEntries2 = afterSecond.filter((e) => e.body.includes('file body gamma'))
  expect(noteEntries2.length, 'exactly one note-sourced entry after re-ingest').toBe(1)
  expect(docEntries2.length, 'exactly one document-sourced entry after re-ingest').toBe(1)
  expect(fileEntries2.length, 'exactly one file-sourced entry after re-ingest').toBe(1)
  expect(noteEntries2[0].id, 'the note entry must be the SAME row (updated), not a new one').toBe(noteEntry!.id)
  expect(docEntries2[0].id, 'the document entry must be the SAME row (updated), not a new one').toBe(docEntry!.id)
  expect(fileEntries2[0].id, 'the file entry must be the SAME row (updated), not a new one').toBe(fileEntry!.id)

  // Manual entry still untouched after the second run too.
  const manualAfterSecond = afterSecond.find((e) => e.id === manual.id)
  expect(manualAfterSecond, 'manual entry must survive a second ingest').toBeTruthy()
  expect(manualAfterSecond!.updatedAt).toBe(manual.updatedAt)

  // ── UI-driven proof: plant one more fixture with a fresh marker, then fire
  //    the ACTUAL "Sync workspace to Brain" command-palette action (Cmd+K +
  //    click, no direct API call) and confirm it independently reaches the
  //    same ingest path and picks up the new fixture. ──
  // Reuse the existing fixture desk (rather than creating a new one) so this
  // step adds exactly one new knowledge entry — a fresh node would itself add
  // a second entry (the desk is indexed too), which would conflate "the UI
  // command ingested the new widget" with "a new desk was also indexed".
  await window.evaluate(async (deskId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.create({ taskId: deskId, kind: 'note', content: 'brain note body delta', x: 50, y: 50 })
  }, fixtures.deskId)

  await window.keyboard.press('Meta+k')
  await window.waitForFunction(() => document.activeElement?.tagName === 'INPUT', null, { timeout: 3_000 })
  await window.keyboard.type('sync workspace to brain')
  await window.waitForTimeout(400)
  // By testid, not by accessible name: the palette's omni rows quote whatever
  // you typed ('Search the web — "Sync workspace to Brain"', 'Ask Plexii — …'),
  // so a name regex for the query matches three rows and strict mode refuses.
  const syncOption = window.getByTestId('palette-row-sync-brain')
  await expect(syncOption, 'the "Sync workspace to Brain" command must appear in the palette').toBeVisible({ timeout: 3_000 })
  await syncOption.click()

  // The command's run() does `ingestWorkspace().then(() => goPlexiBrain())`,
  // which opens the PlexiBrain segment with no app selected (its tile-grid
  // home, per SegmentShell — `plexibrain-view` only renders once an app like
  // "Ask Brain" is active). Wait for the segment shell itself to mount, which
  // only happens after the promise chain (ingest, then navigate) resolves.
  await expect(window.locator('[data-testid="segment-plexibrain"]')).toBeVisible({ timeout: 10_000 })

  const afterUiSync: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  const n2 = afterUiSync.length
  const deltaEntry = afterUiSync.find((e) => e.body.includes('brain note body delta'))
  expect(
    deltaEntry,
    'the UI-driven "Sync workspace to Brain" command must have ingested the fixture planted just before it fired'
  ).toBeTruthy()
  expect(n2, 'UI-driven sync must add exactly the one new fixture entry').toBe(n1 + 1)

  // ── (e) Brain Map view renders more nodes than baseline, driven via real UI nav ──
  await window.locator('[data-testid="nav-plexibrain-map"]').click()
  await expect(window.locator('[data-testid="brain-map-svg"]')).toBeVisible({ timeout: 5_000 })

  const nodeCount = await window.locator('[data-testid^="brain-node-"]').count()
  expect(nodeCount, 'Brain Map must render exactly one SVG node per knowledge entry').toBe(n2)
  expect(nodeCount, 'Brain Map node count must exceed the pre-ingest baseline').toBeGreaterThan(n0)
})
