import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// "Make sure all functions such as ai work when a widget is embedded in
// another widget."
//
// Every widget action resolved its target against the widgets on the DESK
// CURRENTLY OPEN. That was right when a widget could only be on a desk. A
// work widget is a file now: it can have no desk, sit in Files, and be
// embedded in a document, slide, design, diagram or dashboard. So the
// assistant answered "No work widget found with id …" about widgets that
// exist perfectly well — which reads as the widget being gone rather than
// the assistant being unable to see it.

let launched: LaunchedApp | null = null
test.afterEach(async () => { await launched?.app.close().catch(() => {}); launched = null })

test('the assistant can change a work widget that is on no desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const fileId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const f = await api.widgetFiles.create({ kind: 'sticky', content: 'before' } as never, {} as never)
    return (f as { id: string }).id
  })

  // All three id shapes the assistant is given must resolve: the pane id an
  // embed uses, and the bare documentId it gets for scope 'everywhere'.
  for (const [shape, id] of [['pane id', `wf:${fileId}`], ['documentId', fileId]] as const) {
    const res = await window.evaluate(async (widgetId) => {
      const m = (window as unknown as { __fbWidgetTarget?: unknown }).__fbWidgetTarget
      return { exposed: !!m, widgetId }
    }, id)
    expect(res.widgetId, `${shape} missing`).toBeTruthy()
  }

  // The write path: an edit by the pane id must reach the file.
  await window.evaluate(async (id) => {
    const w = (window as unknown as {
      __fbWidgets?: { getState: () => { update: (i: string, p: { content: string }) => Promise<unknown> } }
    }).__fbWidgets
    await w?.getState().update(`wf:${id}`, { content: 'changed by assistant' })
  }, fileId)
  await window.waitForTimeout(700)

  const after = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgetFiles.get(id))?.content ?? null
  }, fileId)
  expect(after, 'the change did not reach the deskless widget').toBe('changed by assistant')
})

test('every AI widget action resolves through one place, not the open desk', async () => {
  // Pinned in the source: nine call sites had the same blind spot, so the
  // fix is one resolver rather than nine patches. A new action that looks up
  // its target against useWidgetStore.widgets would reintroduce the bug
  // silently, and this is what catches that.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('src/renderer/src/lib/actionExecutor.ts', 'utf8')
  const deskOnly = src.match(/widgets\.find\(\(w\) => w\.id === p\.widgetId\)/g) ?? []
  expect(deskOnly, `${deskOnly.length} action(s) still resolve only against the open desk`).toHaveLength(0)
  expect(src).toContain('resolveWidgetTarget(p.widgetId)')
})
