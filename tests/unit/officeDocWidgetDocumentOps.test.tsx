// The bug this file exists for, in the place it actually bit.
//
// An office document widget holds its document in LOCAL state — it loads it
// with window.api.documents.get(widget.content) and never puts it in the
// documents store. The editors' File menus, meanwhile, read the store's
// `active` document and acted on that. So on a desk, with anything previously
// opened in Documents, a widget's File > Move to trash trashed the OTHER
// document, and Make a copy produced a copy titled from the widget and bodied
// from the other file. Silently, in public 4.3.33 through 4.3.40.
//
// Every assertion here is therefore of the same shape: the ops the widget hands
// its editor are bound to the WIDGET's document, while the store's active
// document is something else entirely.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'

const seen: { doc?: DocumentOps; sheet?: DocumentOps; slides?: DocumentOps; map?: DocumentOps; design?: DocumentOps } = {}

vi.mock('@office', () => ({
  DocEditor: ({ documentOps }: { documentOps?: DocumentOps }) => {
    seen.doc = documentOps
    return <div data-testid="doc-editor" />
  },
  SheetEditor: ({ documentOps }: { documentOps?: DocumentOps }) => {
    seen.sheet = documentOps
    return <div data-testid="sheet-editor" />
  },
  SlidesEditor: ({ documentOps }: { documentOps?: DocumentOps }) => {
    seen.slides = documentOps
    return <div data-testid="slides-editor" />
  },
  MapEditor: ({ documentOps }: { documentOps?: DocumentOps }) => {
    seen.map = documentOps
    return <div data-testid="map-editor" />
  },
  DesignEditor: ({ documentOps }: { documentOps?: DocumentOps }) => {
    seen.design = documentOps
    return <div data-testid="design-editor" />
  },
  DrawStudio: () => <div />
}))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: unknown }) => <div>{children as never}</div>
}))
vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
  promptText: vi.fn().mockResolvedValue('Renamed')
}))

import OfficeDocWidget from '../../src/renderer/src/components/widgets/OfficeDocWidget'
import { useDocumentsStore } from '../../src/renderer/src/stores/documents'

// The widget's own document, and the unrelated one the store has open.
const MINE = { id: 'doc-mine', title: 'On the desk', docType: 'doc', body: { type: 'doc' } }
const OTHER = { id: 'doc-other', title: 'Open in Documents', docType: 'doc', body: { type: 'doc' } }

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let remove: ReturnType<typeof vi.fn>
let renameById: ReturnType<typeof vi.fn>
let create: ReturnType<typeof vi.fn>

beforeEach(() => {
  seen.doc = undefined
  seen.sheet = undefined
  remove = vi.fn().mockResolvedValue(undefined)
  renameById = vi.fn().mockResolvedValue(undefined)
  create = vi.fn().mockResolvedValue({ ...MINE, id: 'doc-copy' })
  // THE PRECONDITION. Something else is the store's active document, exactly as
  // it is for anyone who opened a file in Documents before going to their desk.
  useDocumentsStore.setState({
    active: OTHER as never,
    remove: remove as never,
    renameById: renameById as never,
    refresh: (async () => {}) as never
  })
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: {
      documents: {
        get: vi.fn(async (id: string) => (id === MINE.id ? MINE : null)),
        create,
        update: vi.fn()
      }
    }
  }) as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const widget = (kind: string, content: string): unknown => ({
  id: 'w1',
  kind,
  content,
  title: '',
  x: 0,
  y: 0,
  w: 4,
  h: 4
})

const mount = async (kind = 'doc'): Promise<void> => {
  await act(async () => {
    root.render(<OfficeDocWidget widget={widget(kind, MINE.id) as never} inline />)
  })
}

describe('a document widget binds its File menu to its own document', () => {
  it('passes ops at all — without them the items would simply vanish', async () => {
    // The optional prop makes this a silent failure mode rather than a type
    // error: an unwired host loses New, Make a copy, Rename, Version history,
    // Move to trash and Meeting, and nothing complains.
    await mount()
    expect(seen.doc).toBeDefined()
  })

  it('binds them to the widget document, not the store active one', async () => {
    await mount()
    expect(seen.doc!.id).toBe(MINE.id)
    expect(seen.doc!.id).not.toBe(OTHER.id)
  })

  it('trashes its own document — the data-loss bug, asserted at the call', async () => {
    await mount()
    await act(async () => {
      await seen.doc!.moveToTrash()
    })
    expect(remove).toHaveBeenCalledWith(MINE.id)
    expect(remove).not.toHaveBeenCalledWith(OTHER.id)
  })

  it('copies its own body, so the copy is not titled one file and filled with another', async () => {
    await mount()
    await act(async () => {
      await seen.doc!.makeCopy()
    })
    const arg = create.mock.calls[0]![0] as { title: string; body: unknown }
    expect(arg.title).toBe('Copy of On the desk')
    expect(arg.body).toEqual(MINE.body)
  })

  it('renames its own document', async () => {
    await mount()
    await act(async () => {
      await seen.doc!.rename()
    })
    expect(renameById).toHaveBeenCalledWith(MINE.id, 'Renamed')
  })

  it('does the same for a spreadsheet widget', async () => {
    // Cells had the identical pattern in its own menu bar, so it needs its own
    // assertion rather than an assumption that the doc case covers it.
    await mount('sheet')
    expect(seen.sheet).toBeDefined()
    expect(seen.sheet!.id).toBe(MINE.id)
  })

  // Deck, Diagrams and Design had the same menu-bar pattern; each kind gets its
  // own assertion that the widget wires them, bound to its own document.
  it.each([
    ['slides', 'slides'],
    ['map', 'map'],
    ['design', 'design']
  ] as const)('does the same for a %s widget', async (kind, key) => {
    await mount(kind)
    expect(seen[key], `${kind} gets ops`).toBeDefined()
    expect(seen[key]!.id).toBe(MINE.id)
    expect(seen[key]!.id).not.toBe(OTHER.id)
  })
})
