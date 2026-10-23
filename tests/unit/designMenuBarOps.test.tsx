// DesignMenuBar's File menu acts on the document on screen — and on nothing
// when there is no document.
//
// The bug this closes shipped in public 4.3.33: the menu bar read the
// documents store's `active` and ran remove(active.id). A desk widget holds
// its document in local state and never in that store, so File › Move to
// trash trashed whatever Documents last opened, Make a copy copied it, and
// Version history showed its history — silently, on a document the person was
// not looking at.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const actions = {
  title: 'A design',
  undo: vi.fn(),
  redo: vi.fn(),
  exportAs: vi.fn(),
  addShape: vi.fn(),
  addLine: vi.fn(),
  addText: vi.fn(),
  addImageFromFile: vi.fn(),
  addWidget: vi.fn(),
  addPage: vi.fn(),
  insertPageNumber: vi.fn(),
  insertSnippet: vi.fn(),
  removeBgSelected: vi.fn(),
  toggleAids: vi.fn(),
  toggleFacing: vi.fn(),
  aidsVisible: true,
  facing: false,
  masters: [],
  editingMasterId: null,
  editMaster: vi.fn(),
  openLayout: vi.fn(),
  openPreflight: vi.fn(),
  openStyles: vi.fn(),
  openSwatches: vi.fn(),
  brandify: vi.fn(),
  openBrandKit: vi.fn(),
  checkA11y: vi.fn(),
  activePage: 0
} as unknown as Parameters<typeof import('../../src/renderer/src/components/documents/editor/DesignMenuBar').default>[0]['actions']

function ops(): DocumentOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    id: 'doc_on_screen',
    newDocument: async () => void calls.push('new'),
    makeCopy: async () => void calls.push('copy'),
    rename: async () => void calls.push('rename'),
    openHistory: () => calls.push('history'),
    startMeeting: () => calls.push('meeting'),
    moveToTrash: async () => void calls.push('trash')
  }
}

async function mount(documentOps?: DocumentOps): Promise<void> {
  const { default: DesignMenuBar } = await import('../../src/renderer/src/components/documents/editor/DesignMenuBar')
  act(() => root.render(<DesignMenuBar actions={actions} documentOps={documentOps} />))
  await act(async () => {
    await Promise.resolve()
  })
}

// An item's textContent is its ICON NAME followed by its label
// ("downloadDownload"), because the icon renders as a ligature span inside the
// button. So these match by containment, not equality — the first run of this
// file failed on that and the label list it printed is what showed why.
function openMenu(label: string): string[] {
  const trigger = Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label))
  if (!trigger) throw new Error(`no ${label} menu`)
  act(() => trigger.click())
  return Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
}
function clickItem(label: string): void {
  const item = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label))
  if (!item) throw new Error(`no ${label} item`)
  act(() => item.click())
}
const has = (items: string[], label: string): boolean => items.some((t) => t.includes(label))

describe('DesignMenuBar reads no store', () => {
  it('its source imports neither documents store nor view store', async () => {
    // The guard that keeps the fix from being undone by a convenient import.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/renderer/src/components/documents/editor/DesignMenuBar.tsx', 'utf8')
    expect(src).not.toMatch(/useDocumentsStore/)
    expect(src).not.toMatch(/useViewStore/)
  })
})

describe('with a document bound, every item acts on THAT document', () => {
  it('New, Make a copy, Rename, Version history and Move to trash all call the ops', async () => {
    const o = ops()
    await mount(o)
    // Reopened each time: clicking an item CLOSES the menu, so a run of
    // clicks after one open finds nothing — which is how the first version of
    // this test failed, on "no Make a copy item".
    for (const label of ['New design', 'Make a copy', 'Rename', 'Version history', 'Move to Trash']) {
      openMenu('File')
      clickItem(label)
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(o.calls).toEqual(['new', 'copy', 'rename', 'history', 'trash'])
  })

  it('a meeting is about that document too', async () => {
    const o = ops()
    await mount(o)
    openMenu('Insert')
    clickItem('Meeting')
    expect(o.calls).toEqual(['meeting'])
  })
})

describe('with NO document bound, the document items are absent', () => {
  it('File offers Download and nothing that needs a document', async () => {
    await mount(undefined)
    const items = openMenu('File')
    // Absent, not disabled: there is nothing for them to act on, and a greyed
    // Move to trash invites a second look for a reason that does not exist.
    for (const gone of ['New design', 'Make a copy', 'Rename', 'Version history', 'Move to Trash']) {
      expect(has(items, gone), `${gone} must not be offered`).toBe(false)
    }
    expect(has(items, 'Download'), 'Download stays: exporting needs no document row').toBe(true)
  })

  it('and no Meeting, which would invite people to a document that is not there', async () => {
    await mount(undefined)
    const items = openMenu('Insert')
    expect(has(items, 'Meeting')).toBe(false)
  })
})
