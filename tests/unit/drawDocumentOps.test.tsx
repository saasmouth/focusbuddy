// PlexiiDraw's document commands act on the drawing the HOST shows, by id --
// never on the documents store's `active` document.
//
// The bug (public 4.3.33 through 4.3.40): file.commands.ts and
// document.commands.ts read useDocumentsStore.getState().active. A desk widget
// (OfficeDocWidget) holds its drawing in local state and never puts it in the
// store, so in a Draw desk widget, with anything opened in Documents earlier,
// File › Move to trash binned THAT document, Make a copy copied it, Rename
// renamed it (the store's rename(title) has no id), Version history opened its
// history, and Document › Meeting invited people to it -- or to id ''.
//
// Every case here therefore runs with a DIFFERENT drawing active in the store
// (B) while the studio shows A, and asserts on what reached window.api: a fake
// that records every call. The store itself is the real one (only its network
// and CRDT side channels are stubbed), so a command that went back to `active`
// or to the id-less rename would show up as a call against B.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'

const h = vi.hoisted(() => ({
  confirm: true as boolean,
  prompt: 'Renamed on the desk' as string | null,
  confirms: [] as Array<{ title: string }>,
  prompts: [] as Array<{ title: string; initial?: string }>,
  history: [] as string[]
}))

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
  ...(await importOriginal<typeof import('../../src/renderer/src/components/documents/draw/raster')>()),
  loadIntoCanvas: vi.fn(async () => {})
}))
vi.mock('../../src/renderer/src/components/plexi/PromptDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/plexi/PromptDialog')>()),
  confirmDialog: async (o: { title: string }) => {
    h.confirms.push(o)
    return h.confirm
  },
  promptText: async (o: { title: string; initial?: string }) => {
    h.prompts.push(o)
    return h.prompt
  }
}))
vi.mock('../../src/renderer/src/lib/startMeeting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/lib/startMeeting')>()),
  launchMeeting: vi.fn(async () => null)
}))
vi.mock('../../src/renderer/src/components/documents/DocHistoryPanel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/documents/DocHistoryPanel')>()),
  openDocHistory: (id: string) => void h.history.push(id)
}))
// The store's side channels (cloud mirror, CRDT, sync nudge, Undo toast): not
// what is under test, and they reach for services a unit test does not have.
vi.mock('../../src/renderer/src/lib/cloudDocsSync', () => ({
  pullCloudDocs: vi.fn(async () => {}),
  pushCloudDoc: vi.fn(async () => ({})),
  pushCloudDelete: vi.fn(async () => {})
}))
vi.mock('../../src/renderer/src/lib/syncNudge', () => ({ nudgeSync: vi.fn() }))
vi.mock('../../src/renderer/src/lib/crdtBridge', () => ({
  crdtEmitDocumentCreate: vi.fn(),
  crdtEmitDocumentDelete: vi.fn(),
  crdtEmitDocumentAttrs: vi.fn()
}))
vi.mock('../../src/renderer/src/stores/actionHistory', () => ({ recordActionWithToast: vi.fn() }))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: unknown }) => <div>{children as never}</div>
}))

import OfficeDocWidget from '../../src/renderer/src/components/widgets/OfficeDocWidget'
import { commandById, drawCommands } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { documentTitle } from '../../src/renderer/src/components/documents/draw/commands/file.commands'
import { NO_DOCUMENT_REASON } from '../../src/renderer/src/components/documents/draw/editor/session'
import { setImportHost } from '../../src/renderer/src/components/documents/draw/commands/import.commands'
import { createDocumentOps, type DocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'
import { launchMeeting } from '../../src/renderer/src/lib/startMeeting'
import { useDocumentsStore } from '../../src/renderer/src/stores/documents'
import { useMessagingStore } from '../../src/renderer/src/stores/messaging'
import { useViewStore } from '../../src/renderer/src/stores/view'
import { blank, harness, rect } from './drawTools/harness'

// A: the drawing on screen (in the widget). B: what Documents last had open.
const A = { id: 'draw-A', docType: 'draw', title: 'Desk sketch', body: blank([rect('a-rect', 10, 10, 40, 40)]) }
const B = { id: 'draw-B', docType: 'draw', title: 'Open in Documents', body: blank([rect('B-ONLY', 0, 0, 5, 5)]) }

/** Every window.api call, as `path(args)`. */
let calls: Array<{ path: string; args: unknown[] }>
const callsTo = (path: string) => calls.filter((c) => c.path === path)
const anyCallNames = (id: string) => calls.filter((c) => JSON.stringify(c.args).includes(id))

function fakeApi(): unknown {
  const docs = new Map<string, Record<string, unknown>>([
    [A.id, { ...A }],
    [B.id, { ...B }]
  ])
  let n = 0
  const documents: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    get: async (id) => docs.get(id as string) ?? null,
    list: async () => [...docs.values()].map(({ body: _b, ...m }) => m),
    listTrashed: async () => [],
    create: async (input) => {
      const d = { id: `draw-new-${++n}`, ...(input as object) }
      docs.set(d.id, d)
      return d
    },
    update: async (id, patch) => {
      const d = { ...docs.get(id as string), ...(patch as object) }
      docs.set(id as string, d)
      return d
    },
    delete: async () => undefined,
    restore: async () => undefined
  }
  const record = (path: string, fn: (...a: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
    calls.push({ path, args })
    return fn(...args)
  }
  const wrapped: Record<string, unknown> = {}
  for (const [k, fn] of Object.entries(documents)) wrapped[k] = record(`documents.${k}`, fn)
  // Anything else the app reaches for records and resolves to nothing.
  const other = (path: string): unknown =>
    new Proxy(record(path, async () => undefined), {
      get: (_t, p) => (typeof p === 'string' && p !== 'then' ? other(`${path}.${p}`) : undefined)
    })
  return new Proxy({ documents: wrapped } as Record<string, unknown>, {
    get: (t, p) => (typeof p === 'string' ? (t[p] ?? other(p)) : undefined)
  })
}

let savedApi: unknown
let restoreDocs: ReturnType<typeof useDocumentsStore.getState>
let restoreView: ReturnType<typeof useViewStore.getState>
let restoreMessaging: ReturnType<typeof useMessagingStore.getState>
const goDocument = vi.fn()
const goDocuments = vi.fn()

beforeEach(() => {
  calls = []
  h.confirm = true
  h.prompt = 'Renamed on the desk'
  h.confirms = []
  h.prompts = []
  h.history = []
  vi.mocked(launchMeeting).mockClear()
  goDocument.mockClear()
  goDocuments.mockClear()
  savedApi = (window as unknown as { api?: unknown }).api
  ;(window as unknown as { api: unknown }).api = fakeApi()
  restoreDocs = useDocumentsStore.getState()
  restoreView = useViewStore.getState()
  restoreMessaging = useMessagingStore.getState()
  // THE PRECONDITION: B is the documents store's active document.
  useDocumentsStore.setState({ active: { ...B } as never })
  useViewStore.setState({ goDocument, goDocuments } as never)
  useMessagingStore.setState({ archiveObjectChannel: vi.fn(async () => {}) } as never)
})
afterEach(() => {
  ;(window as unknown as { api: unknown }).api = savedApi
  useDocumentsStore.setState(restoreDocs, true)
  useViewStore.setState(restoreView, true)
  useMessagingStore.setState(restoreMessaging, true)
  setImportHost(null)
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

/** B is untouched: no call names it, and it is still the store's active document. */
function expectBUntouched(): void {
  expect(anyCallNames(B.id), 'no window.api call names B').toEqual([])
  expect(useDocumentsStore.getState().active?.id).toBe(B.id)
  expect(useDocumentsStore.getState().active?.title).toBe(B.title)
}

// ── Headless: each command, through the host's real DocumentOps ─────────────

function boundToA(): { ops: DocumentOps; onOpen: ReturnType<typeof vi.fn>; onTrashed: ReturnType<typeof vi.fn>; onRenamed: ReturnType<typeof vi.fn> } {
  const onOpen = vi.fn()
  const onTrashed = vi.fn()
  const onRenamed = vi.fn()
  const ops = createDocumentOps({ id: A.id, docType: 'draw', title: () => A.title, onOpen, onTrashed, onRenamed })
  return { ops, onOpen, onTrashed, onRenamed }
}

function studioShowingA() {
  const hs = harness(A.body)
  const bound = boundToA()
  hs.ed.ctx.host.docOps = () => bound.ops
  hs.ed.ctx.host.title = () => A.title
  return { hs, ...bound }
}

describe('each Draw document command acts on the host-bound drawing (A), with B active in the store', () => {
  it('Move to trash trashes A, by id, after a confirm that names A', async () => {
    const { hs, onTrashed } = studioShowingA()
    hs.run('file.trash')
    await settle()
    expect(h.confirms.map((c) => c.title)).toEqual([`Move "${A.title}" to trash?`])
    expect(callsTo('documents.delete').map((c) => c.args)).toEqual([[A.id]])
    expect(onTrashed).toHaveBeenCalledTimes(1)
    expectBUntouched()
  })

  it('a cancelled Move to trash trashes nothing', async () => {
    const { hs, onTrashed } = studioShowingA()
    h.confirm = false
    hs.run('file.trash')
    await settle()
    expect(callsTo('documents.delete')).toEqual([])
    expect(onTrashed).not.toHaveBeenCalled()
  })

  it('Rename renames A by id through window.api.documents (never the store’s id-less rename)', async () => {
    const { hs, onRenamed } = studioShowingA()
    const idless = vi.spyOn(useDocumentsStore.getState(), 'rename')
    hs.run('file.rename')
    await settle()
    expect(h.prompts).toEqual([expect.objectContaining({ title: 'Rename artwork', initial: A.title })])
    expect(callsTo('documents.update').map((c) => c.args)).toEqual([[A.id, { title: 'Renamed on the desk' }]])
    expect(onRenamed).toHaveBeenCalledWith('Renamed on the desk')
    expect(idless).not.toHaveBeenCalled()
    expectBUntouched()
  })

  it('Version history opens A’s history', async () => {
    const { hs } = studioShowingA()
    hs.run('file.history')
    await settle()
    expect(h.history).toEqual([A.id])
    expectBUntouched()
  })

  it('Make a copy (⌥⌘S) copies A as it is on screen -- including an edit not yet saved -- and opens the copy', async () => {
    const { hs, onOpen } = studioShowingA()
    // An edit the host has not persisted yet (it saves on a debounce).
    hs.ed.ctx.history.commit({ ...hs.doc(), layers: hs.doc().layers.map((l, i) => (i === 0 && 'objects' in l ? { ...l, objects: [...(l as { objects: unknown[] }).objects, rect('unsaved-edit', 60, 60, 10, 10)] } : l)) } as never, 'Rectangle')
    hs.key('ß', { meta: true, alt: true, code: 'KeyS' })
    await settle()
    const created = callsTo('documents.create')
    expect(created).toHaveLength(1)
    const input = created[0].args[0] as { docType: string; title: string; body: unknown }
    expect(input.docType).toBe('draw')
    expect(input.title).toBe(`Copy of ${A.title}`)
    const body = JSON.stringify(input.body)
    expect(body).toContain('a-rect')
    expect(body, 'what is on screen, not the stored row').toContain('unsaved-edit')
    expect(body, 'never B’s body').not.toContain('B-ONLY')
    expect(onOpen).toHaveBeenCalledWith('draw-new-1')
    expectBUntouched()
  })

  it('Make a copy of a read-only drawing (from a newer PlexiiDraw) copies the stored row, not the partial view', async () => {
    const { hs, onOpen } = studioShowingA()
    hs.ed.ctx.set({ readOnly: true })
    hs.run('file.copy')
    await settle()
    expect(callsTo('documents.get').map((c) => c.args)).toEqual([[A.id]])
    const input = callsTo('documents.create')[0].args[0] as { body: unknown }
    expect(input.body).toEqual(A.body)
    expect(onOpen).toHaveBeenCalledWith('draw-new-1')
    expectBUntouched()
  })

  it('Meeting is about A: its id, the draw kind, its title -- never B, never id ""', async () => {
    const { hs } = studioShowingA()
    hs.run('document.meeting')
    await settle()
    expect(launchMeeting).toHaveBeenCalledTimes(1)
    expect(launchMeeting).toHaveBeenCalledWith({ kind: 'draw', id: A.id, title: A.title })
  })

  it('New artwork (⌘N) creates a blank drawing and opens it where the host says', async () => {
    const { hs, onOpen } = studioShowingA()
    hs.key('n', { meta: true, code: 'KeyN' })
    await settle()
    expect(callsTo('documents.create').map((c) => c.args[0])).toEqual([{ docType: 'draw', title: 'Untitled artwork' }])
    expect(onOpen).toHaveBeenCalledWith('draw-new-1')
    expect(goDocument, 'navigation is the host’s, not the command’s').not.toHaveBeenCalled()
    expectBUntouched()
  })

  it('New from preset creates through the ops with the preset’s title and body', async () => {
    const { hs, onOpen } = studioShowingA()
    const preset = drawCommands().find((c) => c.id.startsWith('file.newPreset.'))!
    hs.run(preset.id)
    await settle()
    const created = callsTo('documents.create')
    expect(created).toHaveLength(1)
    const input = created[0].args[0] as { docType: string; title: string; body: { width: number; height: number } }
    expect(input.docType).toBe('draw')
    // The label is "<title> — <w>×<h>"; the new drawing is that title, at that size.
    expect(preset.label).toBe(`${input.title} — ${input.body.width}×${input.body.height}`)
    expect(onOpen).toHaveBeenCalledWith('draw-new-1')
    expectBUntouched()
  })

  it('Open SVG… (⌘O) creates the new drawing through the ops and opens it where the host says', async () => {
    const { hs, onOpen } = studioShowingA()
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="5" height="5" fill="#00f"/></svg>')
    setImportHost({
      deps: () =>
        ({
          parseXml: (x: string) => new XmlDomParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } } as never).parseFromString(x, 'image/svg+xml'),
          rasterize: async () => '',
          pdfPage: async () => ({ ok: false, error: 'not used' }),
          gunzip: async () => {
            throw new Error('not used')
          }
        }) as never,
      pick: async () => ({ ok: true, files: [{ name: 'logo.svg', bytes: svg }], skipped: [] })
    })
    hs.run('file.openSvg')
    await settle()
    const created = callsTo('documents.create')
    expect(created).toHaveLength(1)
    expect((created[0].args[0] as { title: string; docType: string }).title).toBe('logo')
    expect((created[0].args[0] as { docType: string }).docType).toBe('draw')
    expect(onOpen).toHaveBeenCalledWith('draw-new-1')
    expectBUntouched()
  })

  it('anything that names the drawing names A (the bound title)', () => {
    const { hs } = studioShowingA()
    expect(documentTitle(hs.ed.ctx)).toBe(A.title)
  })
})

// ── No host document: disabled with a reason, never a fallback to `active` ──

const DOC_COMMANDS = drawCommands()
  .map((c) => c.id)
  .filter((id) => /^file\.(new|newPreset\..*|openSvg|copy|rename|history|trash)$/.test(id) || id === 'document.meeting')

describe('where no host supplies a document (a live drawing, headless), the commands are off', () => {
  it('the list is every document command', () => {
    expect(DOC_COMMANDS.filter((id) => !id.startsWith('file.newPreset.')).sort()).toEqual(
      ['document.meeting', 'file.copy', 'file.history', 'file.new', 'file.openSvg', 'file.rename', 'file.trash'].sort()
    )
    expect(DOC_COMMANDS.some((id) => id.startsWith('file.newPreset.'))).toBe(true)
  })

  it.each(DOC_COMMANDS)('%s is disabled with a plain reason and refuses to run, touching nothing', async (id) => {
    const hs = harness(A.body)
    const c = commandById(id)!
    expect(c.enabled!(hs.ed.ctx)).toBe(false)
    expect(c.disabledReason!(hs.ed.ctx)).toBe(NO_DOCUMENT_REASON)
    hs.run(id)
    await settle()
    expect(hs.state().status).toBe(NO_DOCUMENT_REASON)
    expect(calls).toEqual([])
    expect(h.confirms).toEqual([])
    expect(h.history).toEqual([])
    expect(launchMeeting).not.toHaveBeenCalled()
    expect(useDocumentsStore.getState().active?.id).toBe(B.id)
  })

  it('the reason reads plainly', () => {
    expect(NO_DOCUMENT_REASON).toBe('Not available here: this drawing is not stored in Documents.')
  })
})

// ── The real thing: a Draw desk widget's menus, mounted ─────────────────────

describe('a Draw desk widget (OfficeDocWidget + DrawStudio), with B active in the store', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  async function mountWidget(): Promise<void> {
    const widget = { id: 'w-1', taskId: 't-1', kind: 'draw', title: A.title, content: A.id } as never
    await act(async () => {
      root.render(<OfficeDocWidget widget={widget} />)
    })
    await act(settle)
    expect(host.querySelector('[data-testid="draw-studio"]'), 'the widget mounted the studio').not.toBeNull()
  }

  async function menuItem(menu: 'file' | 'document', label: string): Promise<void> {
    await act(async () => {
      ;(host.querySelector(`[data-testid="draw-studio-menubar-${menu}"]`) as HTMLElement).click()
    })
    const list = document.querySelector(`[data-testid="draw-studio-menubar-${menu}-list"]`)!
    const button = [...list.querySelectorAll('button')].find((b) => b.querySelectorAll('span')[1]?.firstChild?.textContent?.trim() === label)
    expect(button, `${label} is in the ${menu} menu`).toBeDefined()
    expect(button!.disabled, `${label} is on`).toBe(false)
    await act(async () => {
      button!.click()
    })
    await act(settle)
  }

  it('File › Move to trash trashes the widget’s drawing and the widget says so; B is untouched', async () => {
    await mountWidget()
    await menuItem('file', 'Move to trash')
    expect(h.confirms.map((c) => c.title), 'the confirm names the widget’s drawing').toEqual([`Move "${A.title}" to trash?`])
    expect(callsTo('documents.delete').map((c) => c.args)).toEqual([[A.id]])
    expect(host.querySelector('[data-testid="office-doc-trashed"]')).not.toBeNull()
    expectBUntouched()
  })

  it('File › Rename renames the widget’s drawing by id, prompting with its title, and the widget follows', async () => {
    await mountWidget()
    await menuItem('file', 'Rename')
    expect(h.prompts[0]).toMatchObject({ initial: A.title })
    expect(callsTo('documents.update').map((c) => c.args)).toEqual([[A.id, { title: 'Renamed on the desk' }]])
    // The next prompt starts from the new title: the widget's bound title followed.
    await menuItem('file', 'Rename')
    expect(h.prompts[1]).toMatchObject({ initial: 'Renamed on the desk' })
    expectBUntouched()
  })

  it('File › Version history opens the widget’s drawing’s history', async () => {
    await mountWidget()
    await menuItem('file', 'Version history')
    expect(h.history).toEqual([A.id])
    expectBUntouched()
  })

  it('File › Make a copy copies the widget’s drawing, titled from it, and opens the copy in Documents', async () => {
    await mountWidget()
    await menuItem('file', 'Make a copy')
    const created = callsTo('documents.create')
    expect(created).toHaveLength(1)
    const input = created[0].args[0] as { title: string; body: unknown }
    expect(input.title).toBe(`Copy of ${A.title}`)
    expect(JSON.stringify(input.body)).toContain('a-rect')
    expect(JSON.stringify(input.body)).not.toContain('B-ONLY')
    expect(goDocument).toHaveBeenCalledWith('draw-new-1')
    expectBUntouched()
  })

  it('Document › Meeting is about the widget’s drawing', async () => {
    await mountWidget()
    await menuItem('document', 'Meeting')
    expect(launchMeeting).toHaveBeenCalledWith({ kind: 'draw', id: A.id, title: A.title })
  })
})

// ── Tripwire: no Draw command reaches the documents store ───────────────────

const ROOT = join(process.cwd(), 'src/renderer/src/components/documents')
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
  })
}
/** Code only: comments may name what is forbidden (to say why). */
const code = (p: string): string =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const DRAW_FILES = [...filesUnder(join(ROOT, 'draw')), join(ROOT, 'DrawStudio.tsx'), join(ROOT, 'editor/DrawStudioMenuBar.tsx')]
const COMMAND_FILES = [...filesUnder(join(ROOT, 'draw/commands')), join(ROOT, 'draw/editor/session.ts')]

describe('tripwire: Draw acts on documents only through the host’s DocumentOps', () => {
  it('found the files it guards', () => {
    expect(COMMAND_FILES.length).toBeGreaterThan(15)
    expect(COMMAND_FILES.some((f) => f.endsWith('file.commands.ts'))).toBe(true)
  })

  it.each(DRAW_FILES.map((f) => [f.slice(ROOT.length + 1), f]))('%s does not import or call the documents store, or navigate to documents', (_n, f) => {
    const src = code(f)
    expect(src).not.toMatch(/useDocumentsStore/)
    expect(src).not.toMatch(/stores\/documents['"]/)
    expect(src, 'documents are created through DocumentOps').not.toMatch(/api\.documents\b/)
    expect(src, 'where a new document opens is the host’s call').not.toMatch(/goDocuments?\(/)
  })

  it.each(COMMAND_FILES.map((f) => [f.slice(ROOT.length + 1), f]))('%s never reads `.active`, never meets on id ""', (_n, f) => {
    const src = code(f)
    expect(src).not.toMatch(/\.active\b/)
    expect(src).not.toMatch(/launchMeeting|openDocHistory/)
    expect(src).not.toMatch(/id:\s*[^,}]*\?\?\s*''/)
  })
})
