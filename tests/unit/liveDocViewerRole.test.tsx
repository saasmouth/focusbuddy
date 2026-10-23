// A VIEWER of a shared live document gets a read-only app.
//
// Until signal v123 nothing returned a role, so every member — viewers
// included — was handed a full editor and the server took their edits. The
// server now refuses a viewer's Yjs updates; this covers the client half:
// LiveDocEditorView reads myRole and passes readOnly down, says plainly what
// the person can do, and does not offer commenting (a comment anchor is a
// mark in the body, so a viewer's thread would be created with its anchor
// discarded).
//
// The six editors are mocked: this is about what the VIEW decides and passes,
// not about each editor's own guards, which have their own tests
// (designReadOnly, slidesReadOnly, diagramReadOnly).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { canEditLiveDoc, liveDocAccess, type LiveDocFull } from '../../src/renderer/src/lib/docCollabClient'

// ── The decision itself ────────────────────────────────────────────────────
describe('canEditLiveDoc', () => {
  it('refuses a viewer and allows the rest', () => {
    expect(canEditLiveDoc('viewer')).toBe(false)
    expect(canEditLiveDoc('editor')).toBe(true)
    expect(canEditLiveDoc('owner')).toBe(true)
  })

  it('treats an ABSENT role as editor, because an older server sends none', () => {
    // Every member could write before roles existed. Defaulting to viewer
    // would lock the existing population out of their own documents against
    // any server that has not been deployed yet.
    expect(canEditLiveDoc(undefined)).toBe(true)
  })
})

// ── What the view passes down ──────────────────────────────────────────────
const seen: Record<string, Record<string, unknown>> = {}
const spy = (name: string) => (p: Record<string, unknown>) => {
  seen[name] = p
  return null
}
vi.mock('../../src/renderer/src/components/documents/DocEditor', () => ({ default: spy('doc') }))
vi.mock('../../src/renderer/src/components/documents/SlidesEditor', () => ({ default: spy('slides') }))
vi.mock('../../src/renderer/src/components/documents/DesignEditor', () => ({ default: spy('design') }))
vi.mock('../../src/renderer/src/components/documents/SheetEditor', () => ({ default: spy('sheet') }))
vi.mock('../../src/renderer/src/components/documents/DrawStudio', () => ({ default: spy('draw') }))
vi.mock('../../src/renderer/src/components/documents/MapEditor', () => ({ default: spy('map') }))

const meta = (myRole: LiveDocFull['myRole'], docType: LiveDocFull['docType'] = 'design'): LiveDocFull =>
  ({
    id: 'ld1',
    ownerAccountId: 'acc_owner',
    docType,
    title: 'Shared thing',
    version: 3,
    updatedBy: null,
    createdAt: 0,
    updatedAt: 0,
    body: '{}',
    members: [{ accountId: 'acc_me', handle: 'me', role: myRole }],
    ...(myRole ? { myRole } : {})
  }) as LiveDocFull

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  for (const k of Object.keys(seen)) delete seen[k]
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mountWith(m: LiveDocFull): Promise<void> {
  const { useDocCollabStore } = await import('../../src/renderer/src/stores/docCollab')
  act(() => {
    useDocCollabStore.setState({ meta: m, bodyObj: {}, loading: false } as never)
  })
  const { default: LiveDocEditorView } = await import('../../src/renderer/src/components/views/LiveDocEditorView')
  act(() => root.render(<LiveDocEditorView liveDocId={m.id} />))
  await act(async () => {
    await Promise.resolve()
  })
}

describe('liveDocAccess: what the view decides', () => {
  // The view can only render an editor once the Yjs engine has produced a
  // body, so a unit mount cannot reach the props it passes down. The decision
  // is extracted for exactly that reason and tested here; the banner, which a
  // mount CAN see, is asserted below.
  it('a viewer: read-only, but CAN comment', () => {
    // Commenting opened with signal v125, which accepts a viewer's comment and
    // persists its anchor. Read-only did NOT open: both flags come out of the
    // same function, so this asserts the pair rather than the one that changed.
    expect(liveDocAccess({ docType: 'doc', myRole: 'viewer' })).toEqual({ viewerOnly: true, canComment: true })
  })

  it('an editor of a document: writable, and commenting', () => {
    expect(liveDocAccess({ docType: 'doc', myRole: 'editor' })).toEqual({ viewerOnly: false, canComment: true })
  })

  it('an owner of a design: writable, and no comments because only documents have them', () => {
    expect(liveDocAccess({ docType: 'design', myRole: 'owner' })).toEqual({ viewerOnly: false, canComment: false })
  })

  it('an older server with no role: writable, not locked out', () => {
    expect(liveDocAccess({ docType: 'design', myRole: undefined })).toEqual({ viewerOnly: false, canComment: false })
  })

  it('no document at all: nothing claimed either way', () => {
    expect(liveDocAccess(null)).toEqual({ viewerOnly: false, canComment: false })
  })
})

describe('LiveDocEditorView says what the person may do', () => {
  it('a VIEWER sees the honest banner, not "everyone can edit"', async () => {
    await mountWith(meta('viewer'))
    expect(host.querySelector('[data-testid="livedoc-viewer"]')?.textContent).toMatch(/can view this document/i)
    expect(host.querySelector('[data-testid="livedoc-live"]'), 'not the "everyone can edit" line').toBeNull()
  })

  it('an EDITOR sees the live line', async () => {
    await mountWith(meta('editor'))
    expect(host.querySelector('[data-testid="livedoc-live"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="livedoc-viewer"]')).toBeNull()
  })

  it('an OLDER SERVER (no myRole) is treated as an editor, not locked out', async () => {
    await mountWith(meta(undefined))
    expect(host.querySelector('[data-testid="livedoc-live"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="livedoc-viewer"]')).toBeNull()
  })
})

describe('opening comments did not open editing', () => {
  // liveDocAccess returns viewerOnly and canComment from ONE function, so the
  // flip that let viewers comment was a single character away from letting them
  // edit. These assert the halves separately, because an `.toEqual` on the pair
  // reads as one fact and this is two.

  it('a viewer is still read-only in every document type', () => {
    for (const docType of ['doc', 'sheet', 'slides', 'map', 'design', 'draw'] as const) {
      expect(liveDocAccess({ docType, myRole: 'viewer' }).viewerOnly).toBe(true)
    }
  })

  it('an editor and an owner are still not read-only', () => {
    expect(liveDocAccess({ docType: 'doc', myRole: 'editor' }).viewerOnly).toBe(false)
    expect(liveDocAccess({ docType: 'doc', myRole: 'owner' }).viewerOnly).toBe(false)
  })

  it('commenting is still document-only, for a viewer as much as anyone', () => {
    // The flip removed the ROLE condition, not the docType one. A viewer of a
    // shared spreadsheet gets no comment button, same as its owner.
    expect(liveDocAccess({ docType: 'sheet', myRole: 'viewer' }).canComment).toBe(false)
    expect(liveDocAccess({ docType: 'design', myRole: 'viewer' }).canComment).toBe(false)
    expect(liveDocAccess({ docType: 'doc', myRole: 'viewer' }).canComment).toBe(true)
  })

  it('an unknown role is treated as NOT a viewer, which the flip now extends to commenting', () => {
    // Recording what is true rather than what I first assumed. canEditLiveDoc
    // is `role !== 'viewer'`, so an absent role counts as editable — a
    // deliberate "only a viewer is restricted" rule, asserted above for the
    // design case since before any of this.
    //
    // My flip therefore also gives an unknown role canComment, which I checked
    // rather than waved through: the server is the real gate either way (it
    // refuses a viewer's document write and allows any member's comment), so a
    // client that guesses wrong here produces a refused action, not an
    // unauthorised one. The permissive default is pre-existing and raised with
    // f0 rather than changed from here — altering canEditLiveDoc would change
    // EDITING permissions, which is well outside opening comments.
    const a = liveDocAccess({ docType: 'doc', myRole: undefined })
    expect(a.viewerOnly).toBe(false)
    expect(a.canComment).toBe(true)
  })

  // f0's answer to the above, and the one behaviour it DID change.
  //
  // The permissive default for an ABSENT role stays: it is the client's half of
  // the server's effectiveRole, where every member could write before roles
  // existed, so treating absent as 'viewer' would lock that population out of
  // their own documents. Guessing permissively costs a refused action; guessing
  // restrictively hides editing from people the server would allow, silently.
  //
  // An UNKNOWN role is the opposite case and used to be wrong. `role !==
  // 'viewer'` let a role nobody has thought about EDIT, while the server's
  // yjsCanWrite is an allowlist and refuses it — so the two disagreed, and the
  // client was the permissive one. canEditLiveDoc is now an allowlist too.
  it('an ABSENT role may edit, but an UNKNOWN role may not — matching the server', () => {
    expect(canEditLiveDoc(undefined), 'the pre-roles population keeps working').toBe(true)
    expect(canEditLiveDoc('owner')).toBe(true)
    expect(canEditLiveDoc('editor')).toBe(true)
    expect(canEditLiveDoc('viewer')).toBe(false)
    // Not in the union, so only data from a server can produce it — which is
    // exactly where an unrecognised role would come from.
    expect(canEditLiveDoc('commenter' as never), 'fails closed, as yjsCanWrite does').toBe(false)
    expect(canEditLiveDoc('' as never)).toBe(false)
    // And it reaches the surface that matters: an unknown role is read-only.
    expect(liveDocAccess({ docType: 'doc', myRole: 'commenter' as never }).viewerOnly).toBe(true)
  })
})
