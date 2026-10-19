import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Verifies the "wires do nothing" fix (plexi-4.0):
//   (a) a mirror wire into an office Document (kind 'doc') writes the source
//       text into the document BODY (Tiptap), not the widget's own content —
//       the write that was previously silently dropped by
//       coerceToWidgetContent having no case for 'doc'.
//   (b) a mirror wire into a target that can't hold text (a timer) now ends
//       in a LOUD, visible error instead of doing nothing.
//   (c) a mirror wire FROM a pdf source now ends in a LOUD, visible error
//       instead of silently feeding the target a URL. Updated for the PDF
//       text-extraction feature (plexi-4.0): a PDF's text IS now readable
//       (via the main-side extractor), but only through a Transform wire —
//       a Mirror would just copy the raw file reference, so it steers the
//       user to Transform instead of the old "can't read a PDF" message
//       (removed; extractFileText/pdf-parse supersede it — see fileText.ts
//       and tests/e2e/fileTextExtraction.spec.ts for the extraction itself).
//
// All driven with MIRROR wires (deterministic copy, no AI key needed), via
// window.api + the exposed __fbWidgets store handle — same seam
// wireTrustLayer.spec.ts uses so notifyWireSource actually fires.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openTask(window: Page, taskTitleRe: RegExp): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: taskTitleRe }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(300)
}

// Edits a widget's content through the store's `update` (the same path a real
// UI edit goes through), so notifyWireSource actually fires. See
// wireTrustLayer.spec.ts for why the raw IPC call would skip the engine.
async function editContentViaStore(window: Page, widgetId: string, content: string): Promise<void> {
  await window.evaluate(
    async ({ id, content: c }: { id: string; content: string }) => {
      const w = window as unknown as {
        __fbWidgets?: { getState: () => { update: (id: string, patch: { content: string }) => Promise<unknown> } }
      }
      await w.__fbWidgets?.getState().update(id, { content: c })
    },
    { id: widgetId, content }
  )
}

async function linkOf(
  window: Page,
  taskId: string,
  linkId: string
): Promise<{ lastRunAt: number | null; lastError: string | null } | undefined> {
  return window.evaluate(
    async ({ tid, lid }: { tid: string; lid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const links = await api.widgetLinks.listByTask(tid)
      const l = links.find((x) => x.id === lid)
      return l ? { lastRunAt: l.lastRunAt ?? null, lastError: l.lastError ?? null } : undefined
    },
    { tid: taskId, lid: linkId }
  )
}

// ── (a) mirror wire into an office Document target writes the doc BODY ─────

test('(a) a mirror wire into a Document target writes the source text into the document body', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Doc delivery wire' })
    const note = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 220,
      height: 180
    })
    const doc = await api.documents.create({ docType: 'doc', title: 'Wired doc' })
    const docWidget = await api.widgets.create({
      taskId: task.id,
      kind: 'doc',
      title: 'Doc',
      content: doc.id,
      x: 520,
      y: 160,
      width: 320,
      height: 240
    })
    const link = await api.widgetLinks.create(note.id, docWidget.id, task.id, 'mirror')
    return { taskId: task.id, noteId: note.id, docId: doc.id, docWidgetId: docWidget.id, linkId: link!.id }
  })

  await openTask(window, /Doc delivery wire/)

  await editContentViaStore(window, seeded.noteId, 'Hello from the note')

  await expect
    .poll(
      async () =>
        window.evaluate(async (docId: string) => {
          const api = (window as unknown as { api: typeof window.api }).api
          const doc = await api.documents.get(docId)
          return JSON.stringify(doc?.body ?? null)
        }, seeded.docId),
      { timeout: 6_000, intervals: [200, 300, 500] }
    )
    .toContain('Hello from the note')

  // The widget's own content must still be the (unchanged) doc id — the fix
  // writes into the doc body, not the widget's content field.
  const widgetContent = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(tid)
      return ws.find((w) => w.id === wid)?.content
    },
    { tid: seeded.taskId, wid: seeded.docWidgetId }
  )
  expect(widgetContent).toBe(seeded.docId)

  // The wire itself reports a clean run, not an error.
  const link = await linkOf(window, seeded.taskId, seeded.linkId)
  expect(link?.lastError, 'no error on a successful doc write').toBeFalsy()
  expect(link?.lastRunAt, 'a run was recorded').not.toBeNull()
})

// ── (b) mirror wire into an untargetable widget (timer) errors loudly ──────

test('(b) a mirror wire into a timer ends in a loud, visible error — not a silent no-op', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Timer delivery wire' })
    const note = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 220,
      height: 180
    })
    const timer = await api.widgets.create({
      taskId: task.id,
      kind: 'timer',
      title: 'T',
      content: JSON.stringify({ minutes: 25, running: false }),
      x: 520,
      y: 160,
      width: 220,
      height: 180
    })
    const link = await api.widgetLinks.create(note.id, timer.id, task.id, 'mirror')
    return { taskId: task.id, noteId: note.id, timerId: timer.id, timerContent: timer.content, linkId: link!.id }
  })

  await openTask(window, /Timer delivery wire/)

  await editContentViaStore(window, seeded.noteId, 'Hello timer')

  await expect
    .poll(async () => linkOf(window, seeded.taskId, seeded.linkId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toEqual(expect.objectContaining({ lastError: expect.stringContaining('timer') }))

  const link = await linkOf(window, seeded.taskId, seeded.linkId)
  expect(link?.lastError).toContain("can't receive text from a wire")

  // The timer's own config must be untouched — the old silent-drop behaviour
  // would also have left it untouched, but now we ALSO have a visible error,
  // which is the actual fix under test.
  const timerContent = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(tid)
      return ws.find((w) => w.id === wid)?.content
    },
    { tid: seeded.taskId, wid: seeded.timerId }
  )
  expect(timerContent).toBe(seeded.timerContent)

  // The badge surfaces the error visibly too.
  const badge = window.locator(`[data-testid="wire-badge-${seeded.linkId}"]`)
  await expect(badge).toBeVisible({ timeout: 4_000 })
  await expect(badge).toHaveAttribute('data-wire-fresh', 'error')
})

// ── (c) mirror wire FROM a pdf source errors loudly (steers to Transform) ──

test('(c) a mirror wire from a pdf source ends in a loud error — not a silent no-op feeding a URL', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'PDF source wire' })
    const pdf = await api.widgets.create({
      taskId: task.id,
      kind: 'pdf',
      title: 'P',
      content: 'https://example.com/fake-report.pdf',
      x: 120,
      y: 160,
      width: 220,
      height: 180
    })
    const note = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'N',
      content: '',
      x: 520,
      y: 160,
      width: 220,
      height: 180
    })
    const link = await api.widgetLinks.create(pdf.id, note.id, task.id, 'mirror')
    return { taskId: task.id, pdfId: pdf.id, noteId: note.id, linkId: link!.id }
  })

  await openTask(window, /PDF source wire/)

  // Editing the pdf widget's own content (its "url") is what a real content
  // change on the source looks like, and is what fires notifyWireSource.
  await editContentViaStore(window, seeded.pdfId, 'https://example.com/fake-report-v2.pdf')

  await expect
    .poll(async () => linkOf(window, seeded.taskId, seeded.linkId), { timeout: 6_000, intervals: [200, 300, 500] })
    .toEqual(expect.objectContaining({ lastError: expect.stringContaining('Transform wire') }))

  const link = await linkOf(window, seeded.taskId, seeded.linkId)
  // PDF text IS now readable (see fileTextExtraction.spec.ts) — but only via a
  // Transform wire, which runs it through the main-side extractor. A Mirror
  // would just copy the raw file reference, so it steers here instead.
  expect(link?.lastError).toContain('make this a Transform wire')
  expect(link?.lastError).toContain('PDF')
  expect(link?.lastError).not.toContain("can't read")

  // The note must NOT have been silently filled with the pdf's URL.
  const noteContent = await window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(tid)
      return ws.find((w) => w.id === wid)?.content
    },
    { tid: seeded.taskId, wid: seeded.noteId }
  )
  expect(noteContent).toBe('')
  expect(noteContent).not.toContain('example.com')
})

// ── (d) regression: a normal mirror note->note still copies plainly ────────

test('(d) regression: a plain mirror wire note -> note still copies content', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Regression note mirror' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'A',
      content: 'v0',
      x: 120,
      y: 160,
      width: 220,
      height: 180
    })
    const b = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'B',
      content: '',
      x: 520,
      y: 160,
      width: 220,
      height: 180
    })
    const link = await api.widgetLinks.create(a.id, b.id, task.id, 'mirror')
    return { taskId: task.id, aId: a.id, bId: b.id, linkId: link!.id }
  })

  await openTask(window, /Regression note mirror/)
  await editContentViaStore(window, seeded.aId, 'still works')

  await expect
    .poll(
      async () =>
        window.evaluate(
          async ({ tid, wid }: { tid: string; wid: string }) => {
            const api = (window as unknown as { api: typeof window.api }).api
            const ws = await api.widgets.listByTask(tid)
            return ws.find((w) => w.id === wid)?.content
          },
          { tid: seeded.taskId, wid: seeded.bId }
        ),
      { timeout: 6_000, intervals: [200, 300, 500] }
    )
    .toBe('still works')

  const link = await linkOf(window, seeded.taskId, seeded.linkId)
  expect(link?.lastError).toBeFalsy()
})
