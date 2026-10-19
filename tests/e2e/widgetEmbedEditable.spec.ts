import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "Can you make widgets available render and edit in other all office apps."
//
// The embed used to be 242 lines of read-only re-implementation that resolved
// DESK widgets only. Two things had to become true: a work widget FILE (which
// has no desk — docs/widget-files.md) must resolve, and what renders must be
// the real component so it can be typed into.
//
// The third thing is a guard, not a feature: `remove` on a `wf:` id trashes
// the FILE and every desk instance of it. An embed inside a document must not
// be able to do that by accident.

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close().catch(() => {}); launched = null })

test('a work widget file resolves and renders in an embed, and edits write to the file', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const made = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const file = await api.widgetFiles.create({ kind: 'sticky', content: 'before' } as never, {} as never)
    return { id: (file as { id: string }).id }
  })
  expect(made.id).toBeTruthy()

  // The embed resolves by the pane id, exactly as a document node would.
  const resolved = await window.evaluate(async (fileId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const f = await api.widgetFiles.get(fileId)
    return { found: !!f, kind: f?.kind ?? null, content: f?.content ?? null }
  }, made.id)
  expect(resolved.found, 'the file did not resolve').toBe(true)
  expect(resolved.kind).toBe('sticky')

  // An edit routed through the pane id must reach the FILE, which is what
  // makes the embed editable rather than a copy.
  await window.evaluate(async (fileId) => {
    const w = (window as unknown as {
      __fbWidgets?: { getState: () => { update: (id: string, p: { content: string }) => Promise<unknown> } }
    }).__fbWidgets
    await w?.getState().update(`wf:${fileId}`, { content: 'after' })
  }, made.id)
  await window.waitForTimeout(600)

  const after = await window.evaluate(async (fileId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgetFiles.get(fileId))?.content ?? null
  }, made.id)
  expect(after, 'the edit did not reach the file').toBe('after')
})

test('the embed offers no control that could trash the file', async () => {
  // THE HAZARD, from docs/widget-files.md and stores/widgets.ts: `remove` on a
  // `wf:` id trashes the FILE and every desk instance of it. A stray close
  // button inside a document would therefore destroy an object that also
  // lives in Files and on other desks.
  //
  // This is pinned in the SOURCE rather than probed in the DOM, because the
  // DOM version passes for the wrong reason whenever the embed happens not to
  // be on screen — which is most of the time. What must stay true is that the
  // embed renders the widget BODY and never the desk chrome that carries the
  // close control.
  const { readFileSync } = await import('node:fs')
  const body = readFileSync('src/renderer/src/components/documents/embed/EmbeddedWidgetBody.tsx', 'utf8')
  const embed = readFileSync('src/renderer/src/components/documents/embed/WidgetEmbed.tsx', 'utf8')
  expect(body, 'the embed renders the desk frame, which carries a close button').not.toContain('WidgetFrame')
  expect(embed, 'the embed renders the desk frame').not.toContain('WidgetFrame')
  for (const src of [body, embed]) {
    expect(src, 'the embed can call widget removal').not.toMatch(/\.remove\(|confirmTrash|trashWidgetFile/)
  }
  // And the renderer it uses draws the body only.
  const render = readFileSync('src/renderer/src/components/widgets/renderWidget.tsx', 'utf8')
  expect(render, 'renderWidget now includes the desk chrome').not.toContain('WidgetFrame')
})
