// PlexiDesign on the office shell: NO FEATURE DISAPPEARS (SPEC §5 rule 1, and
// the §5a checklist item 3). Every testid the retired right-hand inspector and
// the old toolbar carried must still exist in the new shell, on the tab that
// owns it, rendered for the selection that makes it apply.
//
// This is the test that would have caught the two things the e2e suite could
// not: `design-bleed-input`, which vanished with the old export dropdown while
// design.bleed stayed in the model and designPrintSize kept reading it, and a
// control reachable only on a tab nothing ever selects. The e2e specs each
// drive the controls they know about; only an exhaustive table notices one
// that nobody drives any more.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/components/Tooltip', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

import { ContextBar } from '../../src/renderer/src/components/office/shell'
import { DESIGN_TABS, type DesignCtx } from '../../src/renderer/src/components/documents/design/ribbon'
import { normalizeDesignBody } from '../../src/shared/design'
import type { SlideElement } from '../../src/shared/types'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

/** Every command is a no-op: this test is about what is REACHABLE. */
const cmd = new Proxy({}, { get: () => () => undefined }) as unknown as DesignCtx['cmd']

const text = (id: string): SlideElement =>
  ({
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 200,
    h: 60,
    z: 1,
    paragraphs: [{ runs: [{ text: 'A line', fontSize: 24, color: '#1c1917' }] }]
  }) as unknown as SlideElement
const shape = (id: string): SlideElement =>
  ({ id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 100, z: 1, fill: '#2563eb' }) as unknown as SlideElement
const image = (id: string): SlideElement =>
  ({ id, type: 'image', src: 'data:,', x: 0, y: 0, w: 100, h: 100, z: 1 }) as unknown as SlideElement

type Sel = 'none' | 'text' | 'twoText' | 'shape' | 'image'
const SELECTIONS: Record<Sel, SlideElement[]> = {
  none: [],
  text: [text('t1')],
  twoText: [text('t1'), text('t2')],
  shape: [shape('s1')],
  image: [image('i1')]
}

function ctxFor(sel: Sel): DesignCtx {
  const selected = SELECTIONS[sel]
  const design = normalizeDesignBody({ width: 794, height: 1123, elements: selected, bleed: 3 })
  return {
    design,
    selected,
    first: selected[0] ?? null,
    fonts: ['Inter', 'Georgia'],
    palette: ['#2563eb', '#1c1917'],
    cmd,
    startFrom: <button data-testid="design-start-btn">A4</button>,
    guidesVisible: true,
    facing: false,
    bleed: design.bleed ?? 0,
    layers: [{ id: 'base', name: 'Layer 1' }]
  }
}

function renderTab(tab: string, sel: Sel): void {
  act(() =>
    root.render(
      <ContextBar<DesignCtx>
        testid="design-toolbar"
        tabs={DESIGN_TABS}
        ctx={ctxFor(sel)}
        activeTab={tab}
        onTabChange={() => {}}
        menuBar={null}
      />
    )
  )
}
const has = (id: string): boolean => !!document.querySelector(`[data-testid="${id}"]`)

// Retired-inspector / old-toolbar testid → [tab, the selection that makes it
// apply]. Taken from the editor as it stood before the conversion
// (53d0a579^..), not from memory: `git show <base>:DesignEditor.tsx | grep -o
// 'data-testid="design-[a-z0-9-]*"'` lists all 44, of which these are the ones
// that became tab controls. The rest are shell chrome (undo, redo, status, the
// page rail), ShellPanel content (AI, stock, variations) or on-canvas text
// editing, and they keep their own specs.
const MAPPING: Array<[string, string, Sel]> = [
  // Home is selection-aware: what you can change about the selection is there.
  ['design-opacity', 'home', 'shape'],
  ['design-rotation', 'home', 'shape'],
  ['design-duplicate', 'home', 'shape'],
  ['design-delete-element', 'home', 'shape'],
  // Text properties: on Home for text, and again on the contextual Text tab.
  ['design-font-family', 'home', 'text'],
  ['design-font-size', 'home', 'text'],
  ['design-bold', 'home', 'text'],
  // The Text tab repeats these controls but deliberately WITHOUT the testids
  // (TextControls takes `ids`): two live elements carrying one id is the
  // duplicate-id trap (§8), so Home owns the ids and the Text tab is the same
  // controls for the eye. Asserting them there would be asserting a bug.
  // Arrange: position, order, grouping, layers, text wrap.
  ['design-arrange', 'arrange', 'shape'],
  ['design-group', 'arrange', 'twoText'],
  ['design-element-layer', 'arrange', 'shape'],
  ['design-wrap-controls', 'arrange', 'shape'],
  ['design-wrap-offset', 'arrange', 'shape'],
  // Threading and the story editor, on the contextual Text tab.
  ['design-open-story', 'text', 'text'],
  ['design-link-frames', 'text', 'twoText'],
  ['design-unlink', 'text', 'text'],
  ['design-thread-controls', 'text', 'text'],
  ['design-story-columns', 'text', 'text'],
  ['design-story-style', 'text', 'text'],
  // Image: alt text and background removal.
  ['design-alt', 'image', 'image'],
  ['design-remove-bg', 'image', 'image'],
  // Page setup. Bleed is here rather than in the export menu it used to hide
  // in: it is a property of the page, and designPrintSize reads design.bleed.
  ['design-bleed-input', 'layout', 'none'],
  ['design-aids-toggle', 'layout', 'none'],
  ['design-layout-btn', 'layout', 'none'],
  // Review: the print export and the accessibility check. design-export-print
  // is an ITEM inside the Export BarMenu, which renders its items only while
  // open, so what the tab must offer is the menu itself; designPrintExport
  // drives the item through it.
  ['design-export-btn', 'review', 'none'],
  ['design-a11y-check', 'review', 'none']
]

describe('PlexiDesign: every retired control is reachable on the shell', () => {
  for (const [id, tab, sel] of MAPPING) {
    it(`${id} is on the ${tab} tab (selection: ${sel})`, () => {
      renderTab(tab, sel)
      expect(has(id), `${id} was not rendered on the ${tab} tab with a ${sel} selection`).toBe(true)
    })
  }

  it('with nothing selected, Home offers the page background, as the canvas inspector did', () => {
    renderTab('home', 'none')
    expect(has('design-bg-color')).toBe(true)
  })

  it('the contextual tabs appear only when they apply (D3: and never select themselves)', () => {
    const tabIds = (sel: Sel): string[] => {
      renderTab('home', sel)
      return [...document.querySelectorAll('[data-testid^="design-toolbar-tab-"]')].map(
        (n) => n.getAttribute('data-testid')!.replace('design-toolbar-tab-', '')
      )
    }
    expect(tabIds('none')).not.toContain('text')
    expect(tabIds('none')).not.toContain('image')
    expect(tabIds('text')).toContain('text')
    expect(tabIds('image')).toContain('image')
    // Home stays active: a contextual tab that appears must not steal the row.
    renderTab('home', 'text')
    expect(document.querySelector('[data-testid="design-toolbar-tab-home"]')?.getAttribute('aria-selected')).toBe('true')
  })
})
