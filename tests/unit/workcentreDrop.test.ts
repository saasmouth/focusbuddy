// Dragging things onto the Workcentre (owner, 2026-11-03): "allow things to be
// dragged onto the view, and show where things will move if the mouse button is
// released, so it doesn't just go to the bottom all the time".
//
// Everything the free canvas accepts is created by the canvas's own drop
// handler (one code path for what a drop MAKES); the Workcentre decides where
// it LANDS: it previews a tile at the pointer while the thing is held there,
// and claims whatever the drop creates for that cell, instead of the old
// first-free-gap placement that put it at the bottom.

import { describe, expect, it } from 'vitest'
import { ARRIVAL_TAIL_MS, ARRIVAL_WINDOW_MS, armArrivals, claimArrivals, dropCellFor, dropSizeFor } from '../../src/renderer/src/lib/workcentreDrop'
import { FILES_DRAG_MIME } from '../../src/renderer/src/lib/filesDrag'
import { DRAG_MIME, catalogFor } from '../../src/renderer/src/lib/widgetCatalog'
import { WIDGET_FILE_DRAG_MIME, WIDGET_NEW_FILE_DRAG_MIME } from '../../src/renderer/src/lib/widgetFileDrag'
import { DOC_DRAG_TYPE } from '../../src/renderer/src/lib/documentDrag'
import { DOC_DRAG_MIME } from '../../src/renderer/src/lib/docMetaCache'
import { CONNECTED_APP_DRAG_MIME } from '../../src/renderer/src/lib/connectedAppDrag'

describe('dropSizeFor — what a drag will arrive as, judged from its types', () => {
  const file = catalogFor('file')!
  const web = catalogFor('webview')!
  it.each([
    ['Files panel', [FILES_DRAG_MIME, 'text/plain'], { w: file.defaultWidth, h: file.defaultHeight }],
    ['Finder files', ['Files'], { w: file.defaultWidth, h: file.defaultHeight }],
    ['a browser tab or link', ['text/uri-list', 'text/plain'], { w: web.defaultWidth, h: web.defaultHeight }],
    ['a connected app', [CONNECTED_APP_DRAG_MIME, 'text/uri-list', 'text/plain'], { w: web.defaultWidth, h: web.defaultHeight }],
    ['a document', [DOC_DRAG_TYPE], { w: 960, h: 660 }],
    ['a legacy document', [DOC_DRAG_MIME, 'text/plain'], { w: 960, h: 660 }],
    ['a widget file', [WIDGET_FILE_DRAG_MIME, 'text/plain'], { w: 320, h: 240 }],
    ['a new widget file', [WIDGET_NEW_FILE_DRAG_MIME], { w: 320, h: 240 }],
    ['a palette kind', [DRAG_MIME], { w: 320, h: 240 }],
    ['a desk link', ['text/fb-task-link'], { w: catalogFor('task-link')!.defaultWidth, h: catalogFor('task-link')!.defaultHeight }]
  ])('%s', (_name, types, size) => {
    expect(dropSizeFor(types)).toEqual(size)
  })

  it('plain text alone is not previewed (the canvas makes nothing from non-link text)', () => {
    expect(dropSizeFor(['text/plain'])).toBeNull()
    expect(dropSizeFor([])).toBeNull()
  })

  it('the connected-app MIME is the one the side menu drags', async () => {
    const sidebar = await import('node:fs').then((fs) => fs.readFileSync(require.resolve('../../src/renderer/src/components/Sidebar.tsx'), 'utf8'))
    expect(sidebar).toContain("export { CONNECTED_APP_DRAG_MIME } from '../lib/connectedAppDrag'")
  })
})

describe('dropCellFor — the dropped tile sits under the pointer, centred on it', () => {
  it('centres horizontally on the pointer column, top at the pointer row, kept on the grid', () => {
    expect(dropCellFor({ x: 6, y: 3 }, { w: 4, h: 6 }, 12)).toEqual({ x: 4, y: 3 })
    expect(dropCellFor({ x: 0, y: 0 }, { w: 4, h: 6 }, 12)).toEqual({ x: 0, y: 0 })
    expect(dropCellFor({ x: 11, y: 2 }, { w: 4, h: 6 }, 12)).toEqual({ x: 8, y: 2 })
    expect(dropCellFor({ x: 3, y: 1 }, { w: 20, h: 6 }, 12)).toEqual({ x: 0, y: 1 })
  })
})

describe('claimArrivals — what the drop created goes to the drop cell', () => {
  const cell = { x: 2, y: 5 }
  it('claims only objects that did not exist at the drop, in creation order, once', () => {
    let a = armArrivals(cell, ['old1', 'old2'], 1000)
    let r = claimArrivals(a, ['old1', 'old2', 'new1'], 1100)
    expect(r.claimed).toEqual(['new1'])
    a = r.next!
    r = claimArrivals(a, ['old1', 'old2', 'new1', 'new2'], 1200)
    expect(r.claimed).toEqual(['new2'])
    expect(claimArrivals(r.next, ['old1', 'old2', 'new1', 'new2'], 1300).claimed).toEqual([])
  })

  it('stops claiming a short while after the last arrival, and after the window if nothing came', () => {
    const a = armArrivals(cell, [], 0)
    const first = claimArrivals(a, ['n1'], 100)
    expect(first.next!.until).toBe(100 + ARRIVAL_TAIL_MS)
    expect(claimArrivals(first.next, ['n1', 'late'], 100 + ARRIVAL_TAIL_MS + 1)).toEqual({ claimed: [], next: null })
    expect(claimArrivals(armArrivals(cell, [], 0), ['n'], ARRIVAL_WINDOW_MS + 1)).toEqual({ claimed: [], next: null })
  })

  it('nothing armed: nothing claimed', () => {
    expect(claimArrivals(null, ['a'], 0)).toEqual({ claimed: [], next: null })
  })
})
