// The Home dashboard's document card mounts the editor for the document's type.
//
// It used to build its widget kind by hand: sheet → sheet, slides → slides, and
// EVERYTHING else → 'doc'. A drawing, design or diagram pinned to Home opened
// in PlexiiWrite. It now reads the same table OfficeDocWidget does
// (lib/officeDocKinds.ts), so this file asserts, per type, the editor that
// actually mounts through the real card and the real OfficeDocWidget.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@office', () => ({
  DocEditor: () => <div data-testid="doc-editor" />,
  SheetEditor: () => <div data-testid="sheet-editor" />,
  SlidesEditor: () => <div data-testid="slides-editor" />,
  MapEditor: () => <div data-testid="map-editor" />,
  DesignEditor: () => <div data-testid="design-editor" />,
  DrawStudio: () => <div data-testid="draw-studio" />
}))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: unknown }) => <div>{children as never}</div>
}))

import { OfficeDocumentCard } from '../../src/renderer/src/components/views/dashboardEmbeds'
import {
  OFFICE_KIND_TO_DOCTYPE,
  docTypeForOfficeKind,
  officeKindForDocType
} from '../../src/renderer/src/lib/officeDocKinds'

const EDITORS = ['doc-editor', 'sheet-editor', 'slides-editor', 'map-editor', 'design-editor', 'draw-studio']

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let docType = 'doc'

beforeEach(() => {
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: {
      documents: {
        get: vi.fn(async (id: string) => ({
          id,
          docType,
          title: 'Pinned to Home',
          archived: false,
          createdAt: 0,
          updatedAt: 0,
          body: { type: docType }
        })),
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

const mountCard = async (type: string): Promise<void> => {
  docType = type
  await act(async () => {
    root.render(<OfficeDocumentCard documentId="doc-1" documentTitle="Pinned to Home" />)
  })
  // The card loads meta, then OfficeDocWidget loads the body: two async hops.
  await act(async () => {})
}

const mounted = (): string[] => EDITORS.filter((id) => host.querySelector(`[data-testid="${id}"]`))

describe('a Home dashboard document card opens the right editor', () => {
  it.each([
    ['doc', 'doc-editor'],
    ['sheet', 'sheet-editor'],
    ['slides', 'slides-editor'],
    ['map', 'map-editor'],
    ['design', 'design-editor'],
    ['draw', 'draw-studio']
  ])('a %s document mounts %s and nothing else', async (type, editor) => {
    await mountCard(type)
    expect(mounted()).toEqual([editor])
  })

  it('says so for a type no office widget edits, instead of opening it as a doc', async () => {
    await mountCard('widget')
    expect(mounted()).toEqual([])
    expect(host.textContent).toContain("can't be edited here")
    expect(host.textContent).not.toContain('Loading')
  })
})

describe('the shared kind ↔ docType table', () => {
  it('round-trips every office kind', () => {
    for (const kind of Object.keys(OFFICE_KIND_TO_DOCTYPE)) {
      expect(officeKindForDocType(docTypeForOfficeKind(kind)!)).toBe(kind)
    }
  })

  it('has no answer for kinds and types it does not cover', () => {
    expect(docTypeForOfficeKind('note')).toBeNull()
    expect(officeKindForDocType('widget')).toBeNull()
  })
})
