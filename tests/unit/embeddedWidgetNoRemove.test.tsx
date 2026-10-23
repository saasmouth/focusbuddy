// A work widget embedded in a document must offer no control that removes it.
//
// renderWidget draws each kind's own component, and those frame themselves: a
// sticky in a document embed came with the desk title bar, and on it the
// "Remove work widget" ×. That × is `remove` on the embed's id — a `wf:` id
// trashes the FILE and every desk instance of it, a desk widget's id deletes it
// from its desk — so one stray click inside a document destroyed work that was
// not the document's. EmbeddedWidgetBody now tells the frame the host owns
// removal (WidgetRemovableContext); the frame drops the tool from its header
// AND from its "…" overflow menu.
//
// The canvas render of the same widget is the control: it must still offer
// remove, or the absence below would prove nothing.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const sticky = {
  id: 'wf:file-1', taskId: '', kind: 'sticky', title: 'Embedded note', content: 'keep me',
  x: 0, y: 0, width: 240, height: 180, zIndex: 1, color: null, status: null, pinned: false,
  pinnedScreenX: null, pinnedScreenY: null, parentSectionId: null, layout: null, sourceAppId: null,
  mode: null, pinnedZone: null, createdAt: 1, updatedAt: 1, archived: false
}

let host: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(() => {
  // Every window.api call resolves empty: the frame and the sticky only read.
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) }
  )
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  host = null
  root = null
})

async function mount(node: JSX.Element): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(node)
  })
  return host
}

/** Open the header's "…" menu, if the header folded any tools into it, and list its items. */
async function overflowLabels(el: HTMLElement): Promise<string[]> {
  const more = el.querySelector<HTMLButtonElement>('[data-testid="widget-overflow-wf:file-1"]')
  if (!more) return []
  await act(async () => {
    more.click()
  })
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent ?? '')
}

function removeTools(el: HTMLElement): Element[] {
  return Array.from(el.querySelectorAll('[data-testid="widget-remove"], [aria-label="Remove work widget"]'))
}

describe('a work widget embedded in a document', () => {
  it('control: on the canvas the same widget offers Remove', async () => {
    const { renderWidget } = await import('../../src/renderer/src/components/widgets/renderWidget')
    const el = await mount(<>{renderWidget(sticky as never)}</>)
    expect(el.querySelector('[data-widget-header]'), 'the frame rendered').not.toBeNull()
    const offered = removeTools(el).length > 0 || (await overflowLabels(el)).some((l) => l.includes('Remove work widget'))
    expect(offered, 'the canvas frame offers Remove').toBe(true)
  })

  it('renders its frame, but no Remove on the header or in the "…" menu', async () => {
    const { default: EmbeddedWidgetBody } = await import(
      '../../src/renderer/src/components/documents/embed/EmbeddedWidgetBody'
    )
    const el = await mount(<EmbeddedWidgetBody widget={sticky as never} />)
    // Not vacuous: the embed really draws the framed widget, header and body.
    expect(el.querySelector('[data-widget-header]'), 'the embed renders the frame').not.toBeNull()
    expect(el.querySelector('[data-widget-id="wf:file-1"]')).not.toBeNull()
    expect(removeTools(el), 'a Remove button inside the embed').toEqual([])
    const folded = await overflowLabels(el)
    expect(folded.filter((l) => l.includes('Remove work widget')), 'a Remove item in the embed\'s "…" menu').toEqual([])
  })
})
