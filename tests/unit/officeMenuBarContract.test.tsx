// GUARD for the office menu-bar contract (SPEC §9.2, §9.4, §9.6).
//
// The owner's rule for 4.3.41: the office apps' menus "should share
// functionality and layout for familiarity across the system". This walks the
// menus each app really builds and asserts that every shared action an app
// offers reads, hints and sits exactly as the contract says, and that an app
// does not quietly drop one. An app that genuinely cannot support an action is
// listed in EXCEPTIONS with its reason; the same list is SPEC §9.6.
//
// The menus are captured where every bar hands them over (menuBarKit's
// MenuBarShell), so this sees the definitions the person sees, not a copy.
// PlexiiDraw's bar is built from its command registry and checked here through
// the same builder (buildMenu); PlexiiDiagrams builds its items inside
// DiagramChrome (React Flow), so tests/e2e/officeMenus.spec.ts walks it, and
// these, by real clicks.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuDef, MenuItem } from '../../src/renderer/src/components/documents/editor/menuBarKit'
import { MENU, type MenuActionId } from '../../src/shared/menus/lexicon'
import { shortcutLabel, type ShortcutKeys } from '../../src/shared/menus/shortcuts'
import { RETIRED_LABELS } from './_menuContract'
import { buildMenu } from '../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import { blank, harness, withDocument } from './drawTools/harness'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

const captured: Record<string, MenuDef[]> = {}
vi.mock('../../src/renderer/src/components/documents/editor/menuBarKit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/renderer/src/components/documents/editor/menuBarKit')>()
  return {
    ...real,
    MenuBarShell: ({ menus, testid }: { menus: MenuDef[]; testid: string }) => {
      captured[testid] = menus
      return null
    }
  }
})

import DocMenuBar from '../../src/renderer/src/components/documents/editor/DocMenuBar'
import SheetMenuBar from '../../src/renderer/src/components/documents/editor/SheetMenuBar'
import SlidesMenuBar from '../../src/renderer/src/components/documents/editor/SlidesMenuBar'
import DesignMenuBar from '../../src/renderer/src/components/documents/editor/DesignMenuBar'

// Anything an app reads off its actions, its editor or its ops: callable, and
// chainable (editor.chain().focus().toggleBold()…), so a bar builds every item.
// The few values that decide WHETHER an item is live are set explicitly below.
const anything = (): unknown => {
  const fn: unknown = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : fn),
    apply: () => fn
  })
  return fn
}
const actions = (fixed: Record<string, unknown>): never =>
  new Proxy(fixed, { get: (t, k) => (k in t ? t[k as string] : anything()) }) as never
const ops = (): never => actions({ id: 'doc-1' })
const live = { title: 'Doc', hasSelection: true, canPaste: true, canUndo: true, canRedo: true, slideOps: true, activePage: 0, activeFormat: undefined }

const APPS: Record<string, { testid: string; render: () => JSX.Element }> = {
  Write: {
    testid: 'doc-menubar',
    render: () => (
      <DocMenuBar
        {...(actions({ title: 'Doc', pageView: false }) as object)}
        editor={actions({ state: { selection: { empty: false } } })}
        title="Doc"
        pageView={false}
        documentOps={ops()}
      />
    )
  },
  Cells: { testid: 'sheet-menubar', render: () => <SheetMenuBar actions={actions({ ...live, documentOps: ops() })} /> },
  Deck: { testid: 'slides-menubar', render: () => <SlidesMenuBar actions={actions({ ...live, documentOps: ops() })} /> },
  Design: { testid: 'design-menubar', render: () => <DesignMenuBar actions={actions(live)} documentOps={ops()} /> }
}

// §9.2 — the shared Edit actions, in contract order.
const EDIT_ORDER: MenuActionId[] = ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteInPlace', 'duplicate', 'delete', 'selectAll', 'find', 'findAndReplace', 'saveAsSnippet']
// Every office app offers these; anything else in EDIT_ORDER is offered where it applies.
const REQUIRED_EDIT: MenuActionId[] = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'saveAsSnippet']

// SPEC §9.6 exceptions: an app that genuinely cannot support an action, and why.
const EXCEPTIONS: Partial<Record<string, Partial<Record<MenuActionId, string>>>> = {
  Write: {
    delete: 'running text: Backspace deletes characters; there is no selected object to delete',
    duplicate: 'running text: there is no selected object to duplicate'
  },
  Cells: {
    duplicate: 'a range has no "beside itself" to duplicate into; it is copied and pasted to a chosen cell',
    workWidgetFromDesk: 'a cell holds a value; Cells has no surface a live widget can sit on'
  },
  Design: {
    find: 'Design text lives in threaded rich-text stories; searching them needs the story editor (owner f0, SPEC §9.6)',
    findAndReplace: 'Design text lives in threaded rich-text stories; searching them needs the story editor (owner f0, SPEC §9.6)'
  }
}
const exempt = (app: string, id: MenuActionId): boolean => !!EXCEPTIONS[app]?.[id]

const items = (menus: MenuDef[], label: string): MenuItem[] => menus.find((m) => m.label === label)?.build() ?? []
const rows = (list: MenuItem[]): Array<MenuItem & { kind: 'item' }> => list.filter((i): i is MenuItem & { kind: 'item' } => i.kind === 'item')
const flat = (list: MenuItem[]): Array<MenuItem & { kind: 'item' }> =>
  list.flatMap((i) => (i.kind === 'item' ? [i] : i.kind === 'submenu' ? flat(i.items) : []))
const hintOf = (id: MenuActionId): string | undefined => {
  const keys = (MENU[id] as { keys?: ShortcutKeys }).keys
  return keys ? shortcutLabel(keys, 'darwin') : undefined
}
const idOf = (label: string): MenuActionId | undefined =>
  (Object.keys(MENU) as MenuActionId[]).find((k) => MENU[k].label === label)

beforeEach(() => {
  ;(globalThis as unknown as { window: Window }).window = Object.assign(globalThis.window ?? {}, {
    api: { platform: 'darwin', documents: { get: vi.fn(), create: vi.fn() } }
  }) as never
})

let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
})

function build(app: string): MenuDef[] {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(APPS[app].render()))
  const menus = captured[APPS[app].testid]
  expect(menus, `${app}: the bar never reached MenuBarShell`).toBeTruthy()
  return menus
}

describe.each(Object.keys(APPS))('%s menu bar keeps the shared contract', (app) => {
  it('shows each shared action with the shared label and the shared hint, everywhere in the bar', () => {
    const menus = build(app)
    for (const m of menus) {
      for (const it of flat(m.build())) {
        expect(RETIRED_LABELS[it.label], `${app} › ${m.label}: "${it.label}" is retired; use "${RETIRED_LABELS[it.label]}"`).toBeUndefined()
        const id = idOf(it.label)
        // A shortcut hint only where the key is bound, and then the shared one (E-13, E-14).
        if (id) expect(it.shortcut, `${app} › ${m.label} › ${it.label}`).toBe(hintOf(id))
        if (it.shortcut) expect(/⌘⇧|Cmd|Ctrl\+/.test(it.shortcut), `${app}: "${it.label}" hint ${it.shortcut} is not in ⌃⌥⇧⌘ form`).toBe(false)
      }
    }
  })

  it('has the menus in the shared order: File, Edit, …, Help last', () => {
    const labels = build(app).map((m) => m.label)
    expect(labels.slice(0, 2)).toEqual(['File', 'Edit'])
    expect(labels[labels.length - 1]).toBe('Help')
    if (labels.includes('Insert')) expect(labels.indexOf('Insert')).toBeGreaterThan(labels.indexOf('Edit'))
  })

  it('Edit offers every shared action the app supports, in contract order', () => {
    const edit = rows(items(build(app), 'Edit'))
    const present = edit.map((i) => idOf(i.label)).filter((id): id is MenuActionId => !!id && EDIT_ORDER.includes(id))
    expect(present, `${app}: Edit order`).toEqual([...present].sort((a, b) => EDIT_ORDER.indexOf(a) - EDIT_ORDER.indexOf(b)))
    for (const id of REQUIRED_EDIT) if (!exempt(app, id)) expect(present, `${app}: Edit is missing ${MENU[id].label}`).toContain(id)
    for (const id of ['delete', 'duplicate', 'find', 'findAndReplace'] as MenuActionId[])
      if (!exempt(app, id)) expect(present, `${app}: Edit is missing ${MENU[id].label} (or list it in EXCEPTIONS with a reason)`).toContain(id)
  })

  it('File ends with Move to Trash behind a separator', () => {
    const file = items(build(app), 'File')
    const last = file[file.length - 1]
    expect(last?.kind === 'item' && last.label).toBe(MENU.moveToTrash.label)
    expect(file[file.length - 2]?.kind).toBe('sep')
  })

  it('Insert ends with the shared tail: Insert snippet…, Work widget from a desk…, then Meeting', () => {
    const insert = items(build(app), 'Insert')
    const tail = insert.slice(-4).map((i) => (i.kind === 'sep' ? '|' : i.label))
    const want = [MENU.insertSnippet.label, ...(exempt(app, 'workWidgetFromDesk') ? [] : [MENU.workWidgetFromDesk.label]), '|', MENU.meeting.label]
    expect(tail.slice(-want.length), `${app}: Insert tail`).toEqual(want)
    // And what comes before the tail is set apart from it.
    expect(insert[insert.length - want.length - 1]?.kind, `${app}: Insert tail is not behind a separator`).toBe('sep')
  })

  it('Help opens the keyboard shortcuts on ⌘/', () => {
    const help = rows(items(build(app), 'Help'))
    const k = help.find((i) => i.label === MENU.keyboardShortcuts.label)
    expect(k, `${app}: Help has no ${MENU.keyboardShortcuts.label}`).toBeTruthy()
    expect(k!.shortcut).toBe('⌘/')
  })

  it('no menu starts or ends with a separator, or doubles one', () => {
    for (const m of build(app)) {
      const list = m.build()
      expect(list[0]?.kind, `${app} › ${m.label} starts with a separator`).not.toBe('sep')
      expect(list[list.length - 1]?.kind, `${app} › ${m.label} ends with a separator`).not.toBe('sep')
      list.forEach((it, i) => it.kind === 'sep' && expect(list[i + 1]?.kind, `${app} › ${m.label}: doubled separator at ${i}`).not.toBe('sep'))
    }
  })
})

// PlexiiDraw (E-16): Illustrator's layout stays, but the shared rows read as
// they do everywhere else. Its keys are Illustrator's, so a hint here is
// whatever Draw's keymap binds (the registry's own guard checks that).
describe('PlexiiDraw menu bar keeps the shared labels and places', () => {
  const ctx = (): Parameters<typeof buildMenu>[0] => withDocument(harness(blank())).ed.ctx
  const labels = (list: MenuItem[]): string[] => list.map((i) => (i.kind === 'sep' ? '|' : i.label))

  it('File: Download ▸ for the formats, Move to Trash last behind a separator', () => {
    const file = buildMenu(ctx(), 'file')
    const dl = file.find((i) => i.kind === 'submenu' && i.label === 'Download')
    expect(dl, 'File has Download ▸').toBeTruthy()
    expect(labels(file).some((l) => l.startsWith('Export')), 'no Export rows left in File').toBe(false)
    expect(labels(file).slice(-2)).toEqual(['|', MENU.moveToTrash.label])
  })

  it('Help has Keyboard shortcuts (Edit no longer does)', () => {
    const h = ctx()
    expect(labels(buildMenu(h, 'help'))).toContain(MENU.keyboardShortcuts.label)
    expect(labels(buildMenu(h, 'edit')).some((l) => l.startsWith('Keyboard shortcuts'))).toBe(false)
  })

  it('no retired label anywhere in the bar', () => {
    const h = ctx()
    for (const m of ['file', 'edit', 'object', 'layer', 'document', 'view', 'window', 'help'])
      for (const it of flat(buildMenu(h, m))) expect(RETIRED_LABELS[it.label], `Draw › ${m}: "${it.label}" is retired`).toBeUndefined()
  })
})
