// E2E: verifies the brain-sync hardening on top of ingestWorkspaceIntoBrain:
//   (a) PRUNE — deleting a widget whose note was ingested causes the next
//       ingestWorkspace() to report stats.removed >= 1 and the entry vanishes
//       from knowledge.list().
//   (b) Manual (source-less) entries are never pruned, even though a prune
//       run just happened.
//   (c) A file entry is skipped (not re-parsed, not duplicated, not pruned)
//       on a second ingestWorkspace() call — hasKnowledgeSource short-circuits
//       the re-extract.
//   (d) Opening the Brain Map view (PlexiBrain -> Brain Map tile) triggers an
//       automatic ingestWorkspace() on mount, with no manual command — proven
//       by planting a fixture beforehand and asserting it appears in the
//       knowledge base purely from having opened the map.
//
// All fixture creation and assertions go through window.api (the IPC
// surface), per the tester playbook: the contract under test is main-process
// DB/sync behaviour, not a UI creation flow. Scenario (d) drives the actual
// UI navigation (sidebar -> PlexiBrain -> Brain Map tile) since the auto-sync
// effect is wired to the BrainMapView mount, and that mount IS the behavior
// under test.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp, switchArea } from './_helpers'
import type { KnowledgeEntry } from '../../src/shared/knowledge'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── (a) prune removes the entry for a deleted widget; (b) manual survives ──

test('(a)(b) ingestWorkspace prunes the entry for a deleted widget and reports removed>=1, while a manual entry survives the same prune run', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const setup = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Prune Test Desk' })
    const widget = await api.widgets.create({
      taskId: desk.id,
      kind: 'note',
      content: 'prune me delta',
      x: 100,
      y: 100
    })
    return { deskId: desk.id, widgetId: widget.id }
  })
  expect(setup.widgetId).toBeTruthy()

  // First ingest: the note's entry must exist.
  const stats1 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })
  expect(stats1.widgets, 'first ingest sees the note widget').toBeGreaterThanOrEqual(1)

  const afterFirst: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  const pruneEntry = afterFirst.find((e) => e.body.includes('prune me delta'))
  expect(pruneEntry, 'entry for the note widget exists before deletion').toBeTruthy()

  // (b) Plant a manual (hand-authored) entry now, right before the prune run,
  // so we can prove the SAME ingestWorkspace() call that prunes the deleted
  // widget's entry leaves this one alone.
  const manual = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.create({ title: 'keep me', body: 'manual', tags: [] })
  })
  expect(manual.id).toBeTruthy()

  // Delete the widget (soft-delete: trashed_at set, excluded from listWidgetsByTask).
  const deleted = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.widgets.delete(id)
  }, setup.widgetId)
  expect(deleted, 'widget delete call succeeded').toBe(true)

  // Second ingest: must prune the now-orphaned entry and report removed>=1.
  const stats2 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })
  expect(stats2.removed, 'ingestWorkspace reports at least one pruned entry').toBeGreaterThanOrEqual(1)

  const afterSecond: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  const pruneEntryGone = afterSecond.find((e) => e.body.includes('prune me delta'))
  expect(pruneEntryGone, 'the deleted widget entry is gone from knowledge.list()').toBeUndefined()

  // (b) the manual entry, planted just before this same prune run, survives untouched.
  const manualSurvived = afterSecond.find((e) => e.id === manual.id)
  expect(manualSurvived, 'manual entry survives the prune run').toBeTruthy()
  expect(manualSurvived!.title).toBe('keep me')
  expect(manualSurvived!.body).toBe('manual')
})

// ── (c) file entries are skipped (immutable), not duplicated, not pruned ──

test('(c) a file entry persists unchanged and exactly once across a re-sync (skip path, no dupe, no prune)', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const fileId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const bytes = new TextEncoder().encode('skip test file')
    const file = await api.files.ingestBuffer({
      buffer: bytes.buffer,
      originalName: 'skip-test.txt',
      mimeType: 'text/plain',
      parentId: null
    })
    return file.id
  })
  expect(fileId).toBeTruthy()

  const stats1 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })
  expect(stats1.files, 'first ingest sees the file').toBeGreaterThanOrEqual(1)
  expect(stats1.created, 'file entry is newly created on first ingest').toBeGreaterThan(0)

  const afterFirst: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  const fileEntries1 = afterFirst.filter((e) => e.body.includes('skip test file'))
  expect(fileEntries1.length, 'exactly one entry for the file after first ingest').toBe(1)

  // Re-sync: file is immutable and already indexed, so it must be SKIPPED
  // (not re-parsed, not duplicated) AND must survive the same run's prune
  // pass (it is still a live object, so it must not be removed).
  const stats2 = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.brain.ingestWorkspace()
  })
  expect(stats2.files, 'second ingest still counts the file as seen').toBeGreaterThanOrEqual(1)
  expect(stats2.removed, 'the live file must not be pruned').toBe(0)

  const afterSecond: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  const fileEntries2 = afterSecond.filter((e) => e.body.includes('skip test file'))
  expect(fileEntries2.length, 'still exactly one entry for the file after re-sync (no dupe)').toBe(1)
  expect(fileEntries2[0].id, 'same row, not a new insert').toBe(fileEntries1[0].id)
  expect(fileEntries2[0].body, 'body unchanged by the skip path').toContain('skip test file')
})

// ── (d) opening the Brain Map auto-syncs the workspace, no manual command ──

test('(d) opening the Brain Map view auto-syncs the workspace into the brain with no manual ingestWorkspace() call', async () => {
  test.setTimeout(60_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Plant a fixture WITHOUT ever calling ingestWorkspace() directly — the
  // only path that should pick this up is opening the Brain Map.
  const setup = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Auto Sync Desk' })
    const widget = await api.widgets.create({
      taskId: desk.id,
      kind: 'note',
      content: 'auto sync epsilon',
      x: 100,
      y: 100
    })
    return { deskId: desk.id, widgetId: widget.id }
  })
  expect(setup.widgetId).toBeTruthy()

  // Confirm the fixture is NOT yet in the brain (no ingest has run this session).
  const before: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  expect(
    before.find((e) => e.body.includes('auto sync epsilon')),
    'fixture must not be in the brain before the map is ever opened'
  ).toBeUndefined()

  // Navigate via real UI: the segment switcher's "Brain" area button ->
  // segment shell home -> "Brain Map" tile. (The sidebar's old text-matched
  // "PlexiBrain" button used by some older specs no longer resolves to a
  // clickable element in the current UI — a pre-existing drift unrelated to
  // this diff, confirmed by plexiBrain.spec.ts test 1 failing the same way
  // on main. `switch-plexibrain` is the stable, current data-testid for this
  // area switch, exercised successfully elsewhere, e.g. brainIngest.spec.ts's
  // use of the sibling `segment-app-map` / `segment-plexibrain` testids.)
  // This is the FIRST brain-map open of this Electron session, so the
  // module-level 30s debounce cannot have already fired.
  await switchArea(window, 'plexibrain')
  await window.waitForSelector('[data-testid="segment-plexibrain"]', { timeout: 8_000 })

  await window.locator('[data-testid="segment-app-map"]').click()
  await expect(window.locator('[data-testid="brain-map-svg"]')).toBeVisible({ timeout: 5_000 })

  // The auto-sync effect fires ingestWorkspace().then(() => load()) on mount;
  // give it a moment to complete and re-render the graph.
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (window as unknown as { api: typeof window.api }).api
          const entries = await api.knowledge.list()
          return entries.some((e) => e.body.includes('auto sync epsilon'))
        }),
      { timeout: 8_000, message: 'auto sync epsilon must appear in the brain after opening the Brain Map, with no manual ingestWorkspace() call' }
    )
    .toBe(true)

  // And it must actually be reflected in the Brain Map's own rendered graph
  // (not just the store), proving the auto-sync's `.then(() => load())`
  // refreshed the view.
  const afterAutoSync: KnowledgeEntry[] = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.knowledge.list()
  })
  const epsilonEntry = afterAutoSync.find((e) => e.body.includes('auto sync epsilon'))
  expect(epsilonEntry, 'epsilon entry located').toBeTruthy()
  await expect(window.locator(`[data-testid="brain-node-${epsilonEntry!.id}"]`)).toBeVisible({ timeout: 5_000 })
})
