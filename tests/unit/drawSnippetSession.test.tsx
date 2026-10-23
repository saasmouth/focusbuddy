// PlexiiDraw editing a saved snippet ("Open original",
// components/snippets/SnippetEditSessionView.tsx): with `session` set, every
// command that acts on a DOCUMENT is disabled with a reason -- in the File
// menu, on its key and through ctx.run -- and none of them reaches
// window.api.documents or the documents store. Save, Export and editing stay
// on. Without `session`, nothing changes.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default',
  fontFamilyValue: (v: string) => v,
  GOOGLE_FONTS: []
}))
vi.mock('../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/renderer/src/components/documents/draw/raster')
  >()),
  loadIntoCanvas: vi.fn(async () => {})
}))
vi.mock('../../src/renderer/src/lib/startMeeting', () => ({ launchMeeting: vi.fn(async () => {}) }))

import DrawStudio from '../../src/renderer/src/components/documents/DrawStudio'
import { drawCommands } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { commandById } from '../../src/renderer/src/components/documents/draw/commands/registry'
import {
  SNIPPET_SESSION_REASON,
  documentBlockedReason
} from '../../src/renderer/src/components/documents/draw/editor/session'
import type { DrawSession } from '../../src/renderer/src/components/documents/draw/editor/types'
import { documentTitle } from '../../src/renderer/src/components/documents/draw/commands/file.commands'
import { buildMenu } from '../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { launchMeeting } from '../../src/renderer/src/lib/startMeeting'
import { useDocumentsStore } from '../../src/renderer/src/stores/documents'
import { useViewStore } from '../../src/renderer/src/stores/view'
import { drawBodyFromSnippet } from '../../src/shared/draw/snippetBody'
import { blank, harness, rect } from './drawTools/harness'

/** Every command that acts on a document. A session turns each of these off. */
const DOCUMENT_COMMANDS = [
  'file.new',
  'file.openSvg',
  'file.copy',
  'file.rename',
  'file.history',
  'file.trash',
  'document.meeting',
  ...drawCommands()
    .map((c) => c.id)
    .filter((id) => id.startsWith('file.newPreset.'))
]

/** What stays on in a session: the host's Save, export, placing art, and editing. */
const SESSION_SAFE = [
  'file.save',
  'file.exportPng',
  'file.exportSvg',
  'file.exportPdf',
  'file.place',
  'file.importSvg',
  'edit.selectAll',
  'object.group',
  'edit.saveAsSnippet'
]

let apiCalls: string[]
let savedApi: unknown

/** window.api where every method, at any depth, records its call and resolves to a stub document. */
function recordingApi(path: string[] = []): unknown {
  const fn = (...args: unknown[]): Promise<unknown> => {
    void args
    apiCalls.push(path.join('.'))
    return Promise.resolve({ id: 'doc-new' })
  }
  return new Proxy(fn, {
    get: (_t, prop) =>
      typeof prop === 'string' && prop !== 'then' ? recordingApi([...path, prop]) : undefined
  })
}

/** The documents store and view store, spied: nothing in a session may reach them. */
function spyStores(): { touched: () => string[] } {
  const docs = useDocumentsStore.getState()
  const view = useViewStore.getState()
  const touched: string[] = []
  const wrap = <T extends object>(
    store: { setState: (p: Partial<T>) => void },
    obj: T,
    keys: Array<keyof T>,
    label: string
  ): void => {
    const patch: Partial<T> = {}
    for (const k of keys) {
      if (typeof obj[k] !== 'function') continue
      ;(patch as Record<string, unknown>)[k as string] = vi.fn(async () => {
        touched.push(`${label}.${String(k)}`)
        return { id: 'doc-new' }
      })
    }
    store.setState(patch)
  }
  wrap(useDocumentsStore as never, docs, ['createBlank', 'rename', 'remove'] as never, 'documents')
  wrap(useViewStore as never, view, ['goDocument', 'goDocuments'] as never, 'view')
  // An active document to act on, as when a drawing was open before the session.
  useDocumentsStore.setState({
    active: { id: 'doc-1', title: 'Some drawing', docType: 'draw', body: {} } as never
  })
  return { touched: () => touched.slice() }
}

const documentWrites = (): string[] => apiCalls.filter((c) => c.startsWith('documents.'))

let restoreDocs: ReturnType<typeof useDocumentsStore.getState>
let restoreView: ReturnType<typeof useViewStore.getState>

beforeEach(() => {
  apiCalls = []
  savedApi = (window as unknown as { api?: unknown }).api
  ;(window as unknown as { api: unknown }).api = recordingApi()
  restoreDocs = useDocumentsStore.getState()
  restoreView = useViewStore.getState()
  vi.mocked(launchMeeting).mockClear()
})
afterEach(() => {
  ;(window as unknown as { api: unknown }).api = savedApi
  useDocumentsStore.setState(restoreDocs, true)
  useViewStore.setState(restoreView, true)
})

function sessionHarness(session?: DrawSession) {
  const h = harness(blank([rect('a', 10, 10, 40, 40)]))
  if (session) h.ed.ctx.host.session = () => session
  return h
}

/** Let async command bodies (dialogs, store calls) run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('in a snippet session, document commands are off', () => {
  it.each(DOCUMENT_COMMANDS)('%s is disabled with the reason and refuses to run', async (id) => {
    const stores = spyStores()
    const h = sessionHarness({ kind: 'snippet' })
    const c = commandById(id)!
    expect(c).toBeDefined()
    expect(c.enabled!(h.ed.ctx)).toBe(false)
    expect(c.disabledReason!(h.ed.ctx)).toBe(SNIPPET_SESSION_REASON)
    // Even run directly (a bar button, the assistant, a future palette), it refuses and says why.
    h.run(id)
    await settle()
    expect(h.state().status).toBe(SNIPPET_SESSION_REASON)
    expect(documentWrites()).toEqual([])
    expect(stores.touched()).toEqual([])
    expect(launchMeeting).not.toHaveBeenCalled()
    // And it changed nothing in the drawing.
    expect(h.state().past).toHaveLength(0)
  })

  it("names what is on screen: the studio's own title in a session, never the store's active document", () => {
    spyStores() // the active document is "Some drawing"
    const h = sessionHarness({ kind: 'snippet' })
    h.ed.ctx.host.title = () => 'Pricing badge'
    expect(documentTitle(h.ed.ctx)).toBe('Pricing badge')
    h.ed.ctx.host.title = () => ''
    expect(documentTitle(h.ed.ctx)).toBe('Untitled snippet')
    // A drawing still names its document, as before.
    expect(documentTitle(sessionHarness().ed.ctx)).toBe('Some drawing')
  })

  it('the default reason says what is going on', () => {
    expect(SNIPPET_SESSION_REASON).toBe(
      'Not available while editing a snippet: this edits the snippet, not a document.'
    )
  })

  it("the host's own reason is used when it gives one", () => {
    const h = sessionHarness({ kind: 'snippet', reason: 'Save or close the snippet first.' })
    expect(documentBlockedReason(h.ed.ctx)).toBe('Save or close the snippet first.')
    expect(commandById('file.copy')!.disabledReason!(h.ed.ctx)).toBe(
      'Save or close the snippet first.'
    )
  })

  it.each(SESSION_SAFE)('%s is not touched by the session', (id) => {
    const h = sessionHarness({ kind: 'snippet' })
    const c = commandById(id)!
    expect(c).toBeDefined()
    const reason = c.disabledReason?.(h.ed.ctx) ?? null
    expect(reason).not.toBe(SNIPPET_SESSION_REASON)
  })

  it('Save is on in a session that saves on request; Export is on', () => {
    const h = sessionHarness({ kind: 'snippet' })
    h.ed.ctx.host.saveRequest = () => () => {}
    expect(commandById('file.save')!.enabled!(h.ed.ctx)).toBe(true)
    for (const id of ['file.exportPng', 'file.exportSvg', 'file.exportPdf'])
      expect(commandById(id)!.enabled!(h.ed.ctx)).toBe(true)
  })

  it('⌥⌘S (Make a copy), ⌘N, ⌥⌘N and ⌘O do nothing to documents; each says why', async () => {
    const stores = spyStores()
    const h = sessionHarness({ kind: 'snippet' })
    for (const [k, code, mods] of [
      ['ß', 'KeyS', { meta: true, alt: true }],
      ['n', 'KeyN', { meta: true }],
      ['˜', 'KeyN', { meta: true, alt: true }],
      ['o', 'KeyO', { meta: true }]
    ] as const) {
      h.ed.ctx.status(null)
      const r = h.key(k, { ...mods, code })
      await settle()
      // The key is claimed (no browser default) and explained, never silent.
      expect(r.prevented).toBe(true)
      expect(h.state().status).toBe(SNIPPET_SESSION_REASON)
    }
    expect(documentWrites()).toEqual([])
    expect(stores.touched()).toEqual([])
  })

  it('every command that names the documents store or a new document is one a session turns off', () => {
    // A tripwire for the next command someone adds: a run that reaches the
    // documents store (or opens a new drawing) without documentCommand fails here.
    const h = sessionHarness({ kind: 'snippet' })
    const reaches =
      /useDocumentsStore|api\.documents|goDocument|createBlank|openNewDrawing|openSvg\(|launchMeeting/
    const offenders = drawCommands()
      .filter((c) => reaches.test(String(c.run)))
      .filter(
        (c) =>
          !(
            c.enabled &&
            !c.enabled(h.ed.ctx) &&
            c.disabledReason?.(h.ed.ctx) === SNIPPET_SESSION_REASON
          )
      )
      .map((c) => c.id)
    expect(offenders).toEqual([])
    // And the list above is exactly what the session turns off.
    const off = drawCommands()
      .filter((c) => c.disabledReason?.(h.ed.ctx) === SNIPPET_SESSION_REASON)
      .map((c) => c.id)
      .sort()
    expect(off).toEqual([...DOCUMENT_COMMANDS].sort())
  })
})

describe('without a session, nothing changes', () => {
  it.each(DOCUMENT_COMMANDS)('%s is enabled, with no reason', (id) => {
    const h = sessionHarness()
    const c = commandById(id)!
    expect(c.enabled!(h.ed.ctx)).toBe(true)
    expect(c.disabledReason!(h.ed.ctx)).toBeNull()
  })

  it('Make a copy still copies the active document (⌥⌘S)', async () => {
    const stores = spyStores()
    const h = sessionHarness()
    h.key('ß', { meta: true, alt: true, code: 'KeyS' })
    await settle()
    expect(documentWrites()).toEqual(['documents.create'])
    expect(stores.touched()).toEqual(['view.goDocument'])
  })

  it('the File menu is the same as before, every item where it was', () => {
    const plain = sessionHarness()
    const items = buildMenu(plain.ed.ctx, 'file').map((i) =>
      i.kind === 'item'
        ? `${i.label}${i.disabled ? ' (off)' : ''}`
        : i.kind === 'submenu'
          ? `${i.label} ›`
          : '—'
    )
    expect(items).toMatchInlineSnapshot(`
      [
        "New artwork",
        "Open SVG…",
        "Save (off)",
        "Make a copy",
        "—",
        "New from preset ›",
        "Place…",
        "Place as template…",
        "Import SVG…",
        "Replace image… (off)",
        "—",
        "Export PNG…",
        "Export SVG…",
        "Export PDF…",
        "—",
        "Rename",
        "Version history",
        "Move to trash",
      ]
    `)
  })
})

// ── The mounted studio, with the real menu bar ───────────────────────────────

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

describe('the mounted studio in a session', () => {
  beforeEach(() => {
    ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {}
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  async function mount(session?: DrawSession, onSaveRequest?: () => void): Promise<void> {
    const content = drawBodyFromSnippet({
      kind: 'draw',
      objects: [rect('r', 0, 0, 40, 40)],
      assets: {},
      swatches: []
    })
    await act(async () => {
      root.render(
        <DrawStudio
          content={content}
          title="Saved snippet"
          onChange={vi.fn()}
          onSaveRequest={onSaveRequest}
          session={session}
        />
      )
    })
  }

  async function key(k: string, init: KeyboardEventInit): Promise<KeyboardEvent> {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
    await act(async () => {
      window.dispatchEvent(e)
    })
    await act(settle)
    return e
  }

  /** The File menu as the person sees it: each item, whether it is off, and the reason under it. */
  async function fileMenu(): Promise<string[]> {
    await act(async () => {
      ;(host.querySelector('[data-testid="draw-studio-menubar-file"]') as HTMLElement).click()
    })
    const list = document.querySelector('[data-testid="draw-studio-menubar-file-list"]')
    expect(list).not.toBeNull()
    const rows = [...list!.children].map((el) => {
      if (el.tagName !== 'BUTTON')
        return el.querySelector('button') ? `${el.textContent?.trim()} ›` : '—'
      const b = el as HTMLButtonElement
      // The label is the second span's own text; the reason under it is also the button's title.
      const label = b.querySelectorAll('span')[1]?.firstChild?.textContent?.trim() ?? ''
      return `${label}${b.disabled ? ` (off${b.title ? `: ${b.title}` : ''})` : ''}`
    })
    await act(async () => {
      ;(host.querySelector('[data-testid="draw-studio-menubar-file"]') as HTMLElement).click()
    })
    return rows
  }

  it('the File menu shows the document commands off, with the reason; Save and Export on', async () => {
    await mount({ kind: 'snippet' }, vi.fn())
    expect(await fileMenu()).toMatchInlineSnapshot(`
      [
        "New artwork (off: Not available while editing a snippet: this edits the snippet, not a document.)",
        "Open SVG… (off: Not available while editing a snippet: this edits the snippet, not a document.)",
        "Save",
        "Make a copy (off: Not available while editing a snippet: this edits the snippet, not a document.)",
        "—",
        "New from preset ›",
        "Place…",
        "Place as template…",
        "Import SVG…",
        "Replace image… (off)",
        "—",
        "Export PNG…",
        "Export SVG…",
        "Export PDF…",
        "—",
        "Rename (off: Not available while editing a snippet: this edits the snippet, not a document.)",
        "Version history (off: Not available while editing a snippet: this edits the snippet, not a document.)",
        "Move to trash (off: Not available while editing a snippet: this edits the snippet, not a document.)",
      ]
    `)
  })

  it('⌥⌘S does not call documents.create (or any documents write); ⌘S still asks the host to save', async () => {
    const stores = spyStores()
    const onSaveRequest = vi.fn()
    await mount({ kind: 'snippet' }, onSaveRequest)
    const copy = await key('ß', { metaKey: true, altKey: true, code: 'KeyS' })
    expect(copy.defaultPrevented).toBe(true)
    await key('n', { metaKey: true, code: 'KeyN' })
    await key('o', { metaKey: true, code: 'KeyO' })
    expect(documentWrites()).toEqual([])
    expect(stores.touched()).toEqual([])
    // The status line says why (on the last of them, ⌘O).
    expect(host.querySelector('[data-testid="draw-status"]')?.getAttribute('title')).toBe(
      SNIPPET_SESSION_REASON
    )
    const save = await key('s', { metaKey: true, code: 'KeyS' })
    expect(save.defaultPrevented).toBe(true)
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
    expect(documentWrites()).toEqual([])
  })

  it('without a session, the same studio keeps Make a copy on in its File menu', async () => {
    await mount()
    const rows = await fileMenu()
    expect(rows.find((r) => r.startsWith('Make a copy'))).toBe('Make a copy')
    expect(rows.some((r) => r.includes('Not available while editing a snippet'))).toBe(false)
  })
})
