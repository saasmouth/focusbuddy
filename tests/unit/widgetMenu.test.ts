import { describe, it, expect, beforeEach } from 'vitest'
import { SEGMENT_APPS } from '../../src/renderer/src/lib/segmentApps'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'
import {
  DEFAULT_MAIN_WIDGETS,
  clickActionFor,
  kindsRepresentedByApps,
  moveWidgetKind,
  parseWidgetMenuPrefs,
  prefsFromSplit,
  splitWidgetMenu,
  tileWidgetKind,
  widgetMenuEntries
} from '../../src/renderer/src/lib/widgetMenu'
import {
  __reloadWidgetMenuPrefsForTests,
  getWidgetMenuPrefs,
  setWidgetMenuPrefs
} from '../../src/renderer/src/lib/widgetMenuPrefs'

// The side menu's Widgets section (4.3.32): "add a new section to the side
// menu for widgets that are not already represented in apps. Make it so users
// can move lesser used widgets to an accordion section called 'Other widgets'".

describe('which kinds the Widgets section lists', () => {
  const listed = new Set(widgetMenuEntries().map((e) => e.kind))

  it('leaves out every kind an app under Apps already is', () => {
    // The owner's list: docs, sheets, slides, diagrams/flowchart, design,
    // draw/artwork, files/drive, browser/connected apps…
    for (const k of ['doc', 'sheet', 'slides', 'diagram', 'map', 'design', 'draw', 'drive', 'file', 'webview', 'local-app-launcher', 'inbox', 'calendar', 'chat-thread', 'email']) {
      expect(listed.has(k as never), `${k} is an app, not a widget here`).toBe(false)
    }
  })

  it('keeps the widgets that are not apps', () => {
    for (const k of ['sticky', 'note', 'table', 'task-list', 'mindmap', 'timer', 'chart', 'calculator', 'card', 'field']) {
      expect(listed.has(k as never), `${k} belongs in Widgets`).toBe(true)
    }
  })

  it('never lists a retired kind the picker hides', () => {
    for (const e of widgetMenuEntries()) expect(e.hideFromPicker, e.kind).not.toBe(true)
  })

  it('is DERIVED from the Apps registry, not a hand list', () => {
    // Remove the Docs app from the registry and its kind comes back to Widgets.
    const withoutDocs = SEGMENT_APPS.office.filter((a) => a.key !== 'docs')
    const entries = widgetMenuEntries(WIDGET_CATALOG, kindsRepresentedByApps(withoutDocs))
    expect(entries.some((e) => e.kind === 'doc')).toBe(true)
    // And an app given a kind takes it out.
    const withSticky = [...SEGMENT_APPS.office, { key: 'stickies', widgetKinds: ['sticky' as const] }]
    expect(widgetMenuEntries(WIDGET_CATALOG, kindsRepresentedByApps(withSticky)).some((e) => e.kind === 'sticky')).toBe(false)
  })

  it('every kind an app represents is a real kind', () => {
    // A typo in the registry would hide nothing and drag nothing.
    const known = new Set(WIDGET_CATALOG.map((e) => e.kind as string).concat(['meeting-record', 'mail-thread']))
    for (const k of kindsRepresentedByApps()) expect(known.has(k), k).toBe(true)
  })

  it('an app tile drags as its first catalogue kind, and Meet/Sign/Vault do not drag', () => {
    const byKey = (k: string) => SEGMENT_APPS.office.find((a) => a.key === k)!
    expect(tileWidgetKind(byKey('docs'))).toBe('doc')
    expect(tileWidgetKind(byKey('files'))).toBe('drive')
    expect(tileWidgetKind(byKey('meet'))).toBeUndefined()
    expect(tileWidgetKind(byKey('sign'))).toBeUndefined()
    expect(tileWidgetKind(byKey('vault'))).toBeUndefined()
  })
})

describe('the main list and Other widgets', () => {
  it('opens with about eight in the main list and everything else under Other', () => {
    const split = splitWidgetMenu(null)
    expect(split.main.map((e) => e.kind)).toEqual(DEFAULT_MAIN_WIDGETS)
    expect(split.main.length).toBe(8)
    expect(split.main.length + split.other.length).toBe(widgetMenuEntries().length)
  })

  it('moves a kind to Other widgets and back, keeping the rest in place', () => {
    const moved = moveWidgetKind(null, 'sticky', 'other')
    expect(moved.main).not.toContain('sticky')
    expect(moved.other[moved.other.length - 1]).toBe('sticky')
    const back = moveWidgetKind(moved, 'sticky', 'main')
    expect(back.main).toContain('sticky')
    expect(back.other).not.toContain('sticky')
  })

  it('reorders within a list by dropping before another kind', () => {
    const p = moveWidgetKind(null, 'timer', 'main', 'sticky')
    expect(p.main[0]).toBe('timer')
    expect(p.main[1]).toBe('sticky')
  })

  it('a kind new in a later release lands in Other, never in an arranged main list', () => {
    const saved = { main: ['sticky', 'table'], other: ['note'] }
    const split = splitWidgetMenu(saved)
    expect(split.main.map((e) => e.kind)).toEqual(['sticky', 'table'])
    expect(split.other[0].kind).toBe('note')
    // Every other offered kind was "new" to these prefs and is in Other.
    expect(split.other.length).toBe(widgetMenuEntries().length - 2)
  })

  it('a saved kind this build no longer offers is dropped, not shown', () => {
    const split = splitWidgetMenu({ main: ['sticky', 'doc', 'no-such-kind'], other: [] })
    expect(split.main.map((e) => e.kind)).toEqual(['sticky'])
  })

  it('round-trips through prefs exactly', () => {
    const split = splitWidgetMenu(moveWidgetKind(null, 'chart', 'other'))
    expect(splitWidgetMenu(prefsFromSplit(split))).toEqual(split)
  })

  it('reads stored prefs defensively', () => {
    expect(parseWidgetMenuPrefs('not json')).toBeNull()
    expect(parseWidgetMenuPrefs({ main: 'x' })).toBeNull()
    expect(parseWidgetMenuPrefs('{"main":["sticky",3],"other":[]}')).toEqual({ main: ['sticky'], other: [] })
  })
})

describe('the arrangement persists', () => {
  beforeEach(() => {
    localStorage.clear()
    __reloadWidgetMenuPrefsForTests()
  })

  it('survives a reload (localStorage), stamped so the newer device copy wins', () => {
    expect(getWidgetMenuPrefs()).toBeNull()
    setWidgetMenuPrefs(moveWidgetKind(null, 'sticky', 'other'))
    const raw = JSON.parse(localStorage.getItem('fb.nav.widgets')!)
    expect(typeof raw.updatedAt).toBe('number')
    __reloadWidgetMenuPrefsForTests() // a fresh renderer reading storage
    expect(getWidgetMenuPrefs()!.other).toContain('sticky')
  })

  it('a corrupt stored value falls back to the defaults, never an empty menu', () => {
    localStorage.setItem('fb.nav.widgets', '{oops')
    __reloadWidgetMenuPrefsForTests()
    expect(getWidgetMenuPrefs()).toBeNull()
    expect(splitWidgetMenu(getWidgetMenuPrefs()).main.length).toBe(8)
  })
})

describe('what a click does', () => {
  it('a kind that can be a file becomes one, desk or no desk', () => {
    expect(clickActionFor('table', false)).toBe('create-file')
    expect(clickActionFor('table', true)).toBe('create-file')
  })
  it('a desk-only kind goes onto the open desk, or asks for one', () => {
    expect(clickActionFor('section', true)).toBe('add-to-desk')
    expect(clickActionFor('section', false)).toBe('needs-desk')
  })
})
