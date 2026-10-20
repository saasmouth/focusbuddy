import { describe, expect, it } from 'vitest'
import {
  SHORTCUT_SLOTS,
  describeShortcutTarget,
  migrateQuickLinks,
  normalizeUrl,
  targetKey,
  urlLabel,
  visibleShortcuts,
  type ShortcutLookups
} from '../../src/renderer/src/components/views/homeShortcutTargets'
import { HOME_WIDGET_DEFS } from '../../src/renderer/src/components/views/homeWidgetDefs'
import type { ShortcutTarget, WidgetSize } from '../../src/renderer/src/components/views/homeWidgetDefs'

const EMPTY: ShortcutLookups = {
  node: () => null,
  document: () => null,
  app: () => null
}

const WORLD: ShortcutLookups = {
  node: (id) =>
    id === 'desk1'
      ? { title: 'Payroll desk', archived: false }
      : id === 'deskInRoom'
        ? { title: 'Clock-in desk', archived: false, parentTitle: 'Loop' }
        : id === 'deadDesk'
          ? { title: 'Old desk', archived: true }
          : id === 'room1'
            ? { title: 'Loop room', archived: false }
            : null,
  document: (id) =>
    id === 'doc1'
      ? { title: 'Q3 numbers', docType: 'sheet', archived: false }
      : id === 'deadDoc'
        ? { title: 'Old notes', docType: 'doc', archived: true }
        : null,
  app: (id) => (id === 'app1' ? { title: 'NetSuite' } : null)
}

describe('normalizeUrl', () => {
  it('keeps full http(s) URLs', () => {
    expect(normalizeUrl('https://system.netsuite.com/login')).toBe('https://system.netsuite.com/login')
    expect(normalizeUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1')
  })
  it('adds https to scheme-less domains and preserves the path', () => {
    expect(normalizeUrl('netsuite.com/pages/login')).toBe('https://netsuite.com/pages/login')
    expect(normalizeUrl('www.example.co.uk')).toBe('https://www.example.co.uk/')
  })
  it('gives localhost http and accepts a port', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeUrl('localhost')).toBe('http://localhost/')
  })
  it('rejects text that is not a link', () => {
    expect(normalizeUrl('payroll')).toBeNull()
    expect(normalizeUrl('two words.com')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })
  it('rejects non-web schemes', () => {
    expect(normalizeUrl('ftp://example.com')).toBeNull()
    expect(normalizeUrl('javascript://example.com/alert(1)')).toBeNull()
    expect(normalizeUrl('file:///etc/passwd')).toBeNull()
  })
  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeUrl('  netsuite.com  ')).toBe('https://netsuite.com/')
  })
})

describe('urlLabel', () => {
  it('is the hostname minus www', () => {
    expect(urlLabel('https://www.netsuite.com/login')).toBe('netsuite.com')
    expect(urlLabel('https://app.example.io/x')).toBe('app.example.io')
  })
})

describe('targetKey', () => {
  it('is stable per destination and ignores labels', () => {
    expect(targetKey({ kind: 'desk', nodeId: 'a', label: 'X' })).toBe(targetKey({ kind: 'desk', nodeId: 'a' }))
  })
  it('separates kinds sharing an id', () => {
    const keys = new Set<string>([
      targetKey({ kind: 'desk', nodeId: 'a' }),
      targetKey({ kind: 'room', roomId: 'a' }),
      targetKey({ kind: 'document', documentId: 'a' }),
      targetKey({ kind: 'connected-app', appId: 'a' }),
      targetKey({ kind: 'section', id: 'a' }),
      targetKey({ kind: 'url', url: 'a' }),
      targetKey({ kind: 'person', accountId: 'a' }),
      targetKey({ kind: 'action', action: 'new-meeting' }),
      targetKey({ kind: 'desk-widget', nodeId: 'a', widgetId: 'b' })
    ])
    expect(keys.size).toBe(9)
  })
})

describe('visibleShortcuts', () => {
  const sizes: WidgetSize[] = ['sm', 'md', 'lg', 'stack']
  it('shows everything when it fits beside the add tile', () => {
    for (const size of sizes) {
      const room = SHORTCUT_SLOTS[size] - 1
      expect(visibleShortcuts(room, size)).toEqual({ shown: room, overflow: 0 })
      expect(visibleShortcuts(0, size)).toEqual({ shown: 0, overflow: 0 })
    }
  })
  it('turns the last slot into a spillover on overflow, never hiding silently', () => {
    for (const size of sizes) {
      const room = SHORTCUT_SLOTS[size] - 1
      const { shown, overflow } = visibleShortcuts(room + 3, size)
      expect(shown).toBe(room - 1)
      expect(overflow).toBe(4)
      // Everything is accounted for: visible tiles + the +N spillover.
      expect(shown + overflow).toBe(room + 3)
    }
  })
})

describe('describeShortcutTarget', () => {
  it('labels URLs from the label, else the hostname', () => {
    expect(describeShortcutTarget({ kind: 'url', url: 'https://x.netsuite.com/a', label: 'NetSuite' }, EMPTY).label).toBe('NetSuite')
    expect(describeShortcutTarget({ kind: 'url', url: 'https://x.netsuite.com/a' }, EMPTY).label).toBe('x.netsuite.com')
  })
  it('keeps the domain visible on renamed links and captions context', () => {
    expect(describeShortcutTarget({ kind: 'url', url: 'https://x.netsuite.com/a', label: 'NetSuite' }, EMPTY).caption).toBe('x.netsuite.com')
    expect(describeShortcutTarget({ kind: 'url', url: 'https://x.netsuite.com/a' }, EMPTY).caption).toBe('Website')
    expect(describeShortcutTarget({ kind: 'desk', nodeId: 'deskInRoom' }, WORLD).caption).toBe('Desk · Loop')
    expect(describeShortcutTarget({ kind: 'document', documentId: 'doc1', detail: 'Flamelit' }, WORLD).caption).toBe('Spreadsheet · Flamelit')
    expect(describeShortcutTarget({ kind: 'document', documentId: 'doc1' }, WORLD).caption).toBe('Spreadsheet')
  })
  it('resolves live desks, rooms, documents, and apps from the stores', () => {
    const desk = describeShortcutTarget({ kind: 'desk', nodeId: 'desk1' }, WORLD)
    expect(desk).toMatchObject({ label: 'Payroll desk', caption: 'Desk', alive: true })
    const room = describeShortcutTarget({ kind: 'room', roomId: 'room1' }, WORLD)
    expect(room).toMatchObject({ label: 'Loop room', caption: 'Room', alive: true })
    const doc = describeShortcutTarget({ kind: 'document', documentId: 'doc1' }, WORLD)
    expect(doc).toMatchObject({ label: 'Q3 numbers', caption: 'Spreadsheet', icon: 'table_chart', alive: true })
    const app = describeShortcutTarget({ kind: 'connected-app', appId: 'app1' }, WORLD)
    expect(app).toMatchObject({ label: 'NetSuite', caption: 'App', alive: true })
  })
  it('marks archived and missing subjects dead but keeps them legible', () => {
    expect(describeShortcutTarget({ kind: 'desk', nodeId: 'deadDesk' }, WORLD)).toMatchObject({ label: 'Old desk', alive: false })
    expect(describeShortcutTarget({ kind: 'document', documentId: 'deadDoc' }, WORLD).alive).toBe(false)
    // Missing entirely: the label snapshot from add time survives.
    expect(describeShortcutTarget({ kind: 'desk', nodeId: 'nope', label: 'Payroll desk' }, WORLD)).toMatchObject({
      label: 'Payroll desk',
      alive: false
    })
    expect(describeShortcutTarget({ kind: 'desk', nodeId: 'nope' }, WORLD).label).toBe('Missing desk')
  })
  it('describes action and person targets as always alive', () => {
    expect(describeShortcutTarget({ kind: 'action', action: 'new-meeting' }, EMPTY)).toMatchObject({
      label: 'New meeting',
      caption: 'Action',
      icon: 'plexii:meet',
      alive: true
    })
    expect(describeShortcutTarget({ kind: 'action', action: 'transcribe' }, EMPTY)).toMatchObject({
      label: 'Transcribe',
      icon: 'plexii:mic',
      alive: true
    })
    expect(describeShortcutTarget({ kind: 'person', accountId: 'x', handle: 'sam', label: 'Sam R' }, EMPTY)).toMatchObject({
      label: 'Sam R',
      caption: 'Message',
      alive: true
    })
    expect(describeShortcutTarget({ kind: 'person', accountId: 'x', handle: 'sam' }, EMPTY).label).toBe('sam')
  })
  it('describes desk-widget targets with liveness following the desk', () => {
    const live = describeShortcutTarget({ kind: 'desk-widget', nodeId: 'desk1', widgetId: 'w1', label: 'Notes' }, WORLD)
    expect(live).toMatchObject({ label: 'Notes', caption: 'On Payroll desk', alive: true })
    expect(describeShortcutTarget({ kind: 'desk-widget', nodeId: 'deadDesk', widgetId: 'w1' }, WORLD).alive).toBe(false)
    expect(describeShortcutTarget({ kind: 'desk-widget', nodeId: 'nope', widgetId: 'w1' }, WORLD).alive).toBe(false)
  })
  it('resolves known sections and flags unknown ids', () => {
    expect(describeShortcutTarget({ kind: 'section', id: 'vault' }, EMPTY)).toMatchObject({ label: 'PlexiiVault', alive: true })
    expect(describeShortcutTarget({ kind: 'section', id: 'bogus' }, EMPTY).alive).toBe(false)
  })
})

describe('migrateQuickLinks', () => {
  it('converts a quick-links instance into a Shortcuts box with section targets', () => {
    const out = migrateQuickLinks({
      key: 'quick-links:abc',
      widget: 'quick-links' as const,
      config: { routes: ['calendar', 'vault'] },
      size: 'sm' as const
    })
    expect(out.widget).toBe('shortcuts')
    expect(out.key).toBe('quick-links:abc')
    expect(out.size).toBe('sm')
    expect(out.config).toEqual({
      title: 'Quick links',
      targets: [
        { kind: 'section', id: 'calendar', label: 'Calendar' },
        { kind: 'section', id: 'vault', label: 'PlexiiVault' }
      ]
    })
  })
  it('drops unknown route ids and tolerates missing config', () => {
    const out = migrateQuickLinks({ widget: 'quick-links' as const, config: { routes: ['vault', 'bogus'] } })
    expect(out.config?.targets).toHaveLength(1)
    const bare = migrateQuickLinks({ widget: 'quick-links' as const })
    expect(bare.config).toEqual({ title: 'Quick links', targets: [] })
  })
  it('is idempotent and leaves every other widget untouched', () => {
    const once = migrateQuickLinks({ widget: 'quick-links' as const, config: { routes: ['tasks'] } })
    expect(migrateQuickLinks(once)).toEqual(once)
    const other = { widget: 'agenda' as const, config: { deskId: 'x' } }
    expect(migrateQuickLinks(other)).toBe(other)
  })
})

describe('registry', () => {
  it('retires quick-links from the gallery but keeps it loadable', () => {
    const def = HOME_WIDGET_DEFS.find((d) => d.id === 'quick-links')
    expect(def?.retired).toBe(true)
  })

  it('declares the shortcuts widget as multi-instance at every size', () => {
    const def = HOME_WIDGET_DEFS.find((d) => d.id === 'shortcuts')
    expect(def).toBeTruthy()
    expect(def?.multi).toBe(true)
    expect(def?.config).toBeUndefined()
    expect(def?.sizes).toEqual(['sm', 'md', 'lg', 'stack'])
  })
  it('keeps ShortcutTarget assignable into widget config', () => {
    const t: ShortcutTarget = { kind: 'url', url: 'https://example.com/', label: 'Example' }
    expect(targetKey(t)).toBe('url:https://example.com/')
  })
})
