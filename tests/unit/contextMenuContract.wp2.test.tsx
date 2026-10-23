// WP2's guard for the right-click menu contract (SPEC §9.3–§9.5): every menu
// in navigation, lists, the side menu, the tray, Home cards and Focus rows.
//
// Each surface is MOUNTED and right-clicked, and the items it hands to the
// context-menu kit are captured (the kit is replaced by a recorder), so what is
// asserted is exactly what the app would draw. The groups are exact.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import type { FbNode } from '../../src/shared/types'
import { expectMenuContract, groupsOf } from './_menuContract'

// The recorder: the last items any surface asked the kit to draw.
const drawn: { items: CtxMenuItem[] | null } = { items: null }
vi.mock('../../src/renderer/src/components/CanvasContextMenu', () => ({
  default: ({ items }: { items: CtxMenuItem[] }) => {
    drawn.items = items
    return <div data-testid="recorded-menu" />
  }
}))
// Thumbnails are canvases of their own; a menu does not need them.
vi.mock('../../src/renderer/src/components/DeskMiniature', () => ({ default: () => <div /> }))
vi.mock('../../src/renderer/src/components/RoomThumb', () => ({ default: () => <div /> }))
vi.mock('../../src/renderer/src/components/LazyVisible', () => ({
  default: ({ children }: { children: unknown }) => <>{children as never}</>
}))

import DesksView from '../../src/renderer/src/components/views/DesksView'
import RoomsView from '../../src/renderer/src/components/views/RoomsView'
import DeskGallery from '../../src/renderer/src/components/DeskGallery'
import { useNodeStore } from '../../src/renderer/src/stores/nodes'
import { useOrgStore, PERSONAL_ORG_ID } from '../../src/renderer/src/stores/org'

let host: HTMLDivElement
let root: Root

function node(p: Partial<FbNode> & { id: string; kind: FbNode['kind'] }): FbNode {
  return {
    parentId: null,
    title: p.id,
    status: 'open',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ...p
  } as FbNode
}

function mount(el: JSX.Element): void {
  act(() => root.render(el))
}

/** A real contextmenu event on the element, as a right-click delivers it. */
async function rightClick(selector: string): Promise<CtxMenuItem[]> {
  drawn.items = null
  const el = document.querySelector(selector)
  expect(el, `${selector} is on screen`).toBeTruthy()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, button: 2 }))
  })
  expect(drawn.items, `${selector} opened a menu`).toBeTruthy()
  return drawn.items!
}

/**
 * window.api for mounted surfaces: the calls a menu test cares about are real
 * fakes; anything else the surfaces load on mount answers an empty list, so a
 * page renders its honest empty state instead of throwing.
 */
function fakeApi(known: Record<string, Record<string, unknown>>): unknown {
  const any = (): unknown =>
    new Proxy(async () => [], {
      get: (_t, p) => (p === 'then' ? undefined : any())
    })
  return new Proxy(known, {
    get: (t, p: string) =>
      p in t ? new Proxy(t[p]!, { get: (o, q: string) => (q in o ? o[q] : q === 'then' ? undefined : any()) }) : any()
  })
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = fakeApi({
    widgets: { listByTask: vi.fn(async () => []), get: vi.fn(async () => null) },
    workItems: { list: vi.fn(async () => []) }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useOrgStore.setState({ activeOrgId: PERSONAL_ORG_ID, orgs: [{ id: PERSONAL_ORG_ID, name: 'Personal', personal: true }] as never })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  localStorage.clear()
})

// E-1 (owner ruling): Open first, Add to Focus… second.
const DESK = ['Open', 'Add to Focus…', 'Rename', 'Share…']
const ASK = ['Ask PlexiiAssist']
const LIFECYCLE = ['Archive', 'Move to Trash']

describe('desks and rooms: one menu everywhere (M-i, M-j)', () => {
  const desk = node({ id: 'd1', kind: 'task', title: 'launch plan' })
  const room = node({ id: 'r1', kind: 'folder', title: 'clients' })

  beforeEach(() => {
    useNodeStore.setState({ nodes: [desk, room], loaded: true })
  })

  it('All Desks: a desk', async () => {
    mount(<DesksView />)
    const items = await rightClick('[data-testid="index-card-d1"]')
    expectMenuContract(items, { groups: [DESK, ASK, LIFECYCLE] })
  })

  it('All Rooms: a room (kind rows fold under More actions ▸ to keep the ceiling)', async () => {
    mount(<RoomsView />)
    const items = await rightClick('[data-testid="index-card-r1"]')
    expectMenuContract(items, { groups: [DESK, ASK, ['More actions'], LIFECYCLE] })
    const more = items.find((i) => i.label === 'More actions')!
    expect(more.children!.map((c) => c.label)).toEqual(['Make this a plan', 'Chat about this room'])
  })

  it('the desk gallery: a desk and a room', async () => {
    mount(<DeskGallery />)
    expectMenuContract(await rightClick('[data-testid="desk-card-d1"]'), { groups: [DESK, ASK, LIFECYCLE] })
    expectMenuContract(await rightClick('[data-testid="desk-card-r1"]'), { groups: [DESK, ASK, ['More actions'], LIFECYCLE] })
  })

  it('a desk reads the same in the index, the desks view (list mode) and the gallery', async () => {
    mount(<DesksView />)
    const index = await rightClick('[data-testid="index-card-d1"]')
    act(() => root.unmount())
    root = createRoot(host)
    localStorage.setItem('desks-index.mode', 'list')
    mount(<DesksView />)
    const list = await rightClick('[data-testid="index-row-d1"]')
    act(() => root.unmount())
    root = createRoot(host)
    mount(<DeskGallery />)
    const gallery = await rightClick('[data-testid="desk-card-d1"]')
    expect(groupsOf(list)).toEqual(groupsOf(index))
    expect(groupsOf(gallery)).toEqual(groupsOf(index))
    expect(gallery.map((i) => [i.label, !!i.danger, !!i.disabled])).toEqual(index.map((i) => [i.label, !!i.danger, !!i.disabled]))
  })

  it('a room reads the same in the rooms index and the gallery', async () => {
    mount(<RoomsView />)
    const index = await rightClick('[data-testid="index-card-r1"]')
    act(() => root.unmount())
    root = createRoot(host)
    mount(<DeskGallery />)
    const gallery = await rightClick('[data-testid="desk-card-r1"]')
    expect(groupsOf(gallery)).toEqual(groupsOf(index))
  })

  it('with a team org, Share with team or group… is its own row after Share…, worded as in Files', async () => {
    useOrgStore.setState({
      activeOrgId: PERSONAL_ORG_ID,
      orgs: [
        { id: PERSONAL_ORG_ID, name: 'Personal', personal: true },
        { id: 'o1', name: 'acme', personal: false }
      ] as never
    })
    mount(<DesksView />)
    const items = await rightClick('[data-testid="index-card-d1"]')
    expectMenuContract(items, { groups: [[...DESK, 'Share with team or group…'], ASK, LIFECYCLE] })
  })

  it('a shared desk (E-2 order): Leave share, Archive for me, and Move to Trash disabled with the reason (§9.5)', async () => {
    useNodeStore.setState({ nodes: [{ ...desk, sharedRootId: 'x', sharedFromHandle: 'sam' } as FbNode], loaded: true })
    mount(<DeskGallery />)
    const items = await rightClick('[data-testid="desk-card-d1"]')
    expectMenuContract(items, { groups: [DESK, ASK, ['Leave share', 'Archive for me', 'Move to Trash']] })
    const trash = items.find((i) => i.label === 'Move to Trash')!
    expect(trash.disabled).toBe(true)
    expect(trash.hint).toBe('Shared by @sam: leave or archive instead')
  })

  it('an archived desk: Unarchive is an object row, not a destructive one', async () => {
    localStorage.setItem('desks-index.archived', '1')
    useNodeStore.setState({ nodes: [{ ...desk, archived: true }], loaded: true })
    mount(<DesksView />)
    const items = await rightClick('[data-testid="index-card-d1"]')
    expectMenuContract(items, { groups: [['Open', 'Add to Focus…', 'Rename', 'Unarchive', 'Share…'], ASK, ['Move to Trash']] })
  })

  it('Add to Focus… marks the desk through the capture seam (CR-09), pointing at it', async () => {
    mount(<DesksView />)
    const items = await rightClick('[data-testid="index-card-d1"]')
    const seen: unknown[] = []
    const on = (e: Event): void => void seen.push((e as CustomEvent).detail)
    window.addEventListener('fb:command-new-work-item', on)
    items.find((i) => i.label === 'Add to Focus…')!.onClick!()
    window.removeEventListener('fb:command-new-work-item', on)
    expect(seen).toEqual([
      {
        captureText: 'Attend to launch plan',
        source: { sourceType: 'desk', sourceRef: 'd1', intentClass: 'to_do', deskId: 'd1', deskTitle: 'launch plan' }
      }
    ])
  })
})

import AreaAccordion from '../../src/renderer/src/components/nav/AreaAccordion'
import OpenTray from '../../src/renderer/src/components/OpenTray'
import { useViewStore } from '../../src/renderer/src/stores/view'
import { useConnectedAppsStore } from '../../src/renderer/src/stores/connectedApps'
import { useOpenTrayStore } from '../../src/renderer/src/stores/openTray'
import { useDocumentsStore } from '../../src/renderer/src/stores/documents'

describe('the side menu: every row kind (M-k, AUDIT §1.3)', () => {
  const desk = node({ id: 'd1', kind: 'task', title: 'launch plan' })
  beforeEach(() => {
    useNodeStore.setState({ nodes: [desk], loaded: true, activeTaskId: null } as never)
    useViewStore.setState({ view: { kind: 'home' } } as never)
    useConnectedAppsStore.setState({
      apps: [{ id: 'ca1', orgId: PERSONAL_ORG_ID, title: 'slack', url: 'https://slack.com', icon: 'apps', color: null }] as never,
      loaded: true
    } as never)
  })

  it('a place row (Home, Focus, Rooms…) opens what a click opens', async () => {
    mount(<AreaAccordion />)
    for (const id of ['nav-plexidesk-home', 'nav-desk-attention', 'nav-desk-rooms']) {
      expectMenuContract(await rightClick(`[data-testid="${id}"]`), { groups: [['Open']] })
    }
  })

  it('a PlexiiApps tile with a work widget to become: Open, Add to this desk (disabled with the reason off a desk)', async () => {
    mount(<AreaAccordion />)
    const items = await rightClick('[data-testid="office-sideapp-docs"]')
    expectMenuContract(items, { groups: [['Open', 'Add to this desk']] })
    expect(items[1]).toMatchObject({ disabled: true, hint: 'Open a desk first' })
  })

  it('the same tile on a desk: Add to this desk is live', async () => {
    useNodeStore.setState({ activeTaskId: 'd1' } as never)
    useViewStore.setState({ view: { kind: 'task', taskId: 'd1' } } as never)
    mount(<AreaAccordion />)
    const items = await rightClick('[data-testid="office-sideapp-docs"]')
    expectMenuContract(items, { groups: [['Open', 'Add to this desk']] })
    expect(items[1].disabled).toBeFalsy()
  })

  it('the Files tool tile: its three places to open, then Add to this desk', async () => {
    mount(<AreaAccordion />)
    expectMenuContract(await rightClick('[data-testid="office-comms-app-files"]'), {
      groups: [['Open beside', 'Open floating', 'Open full screen', 'Add to this desk']]
    })
  })

  it('a tool tile with no work widget: Open', async () => {
    mount(<AreaAccordion />)
    expectMenuContract(await rightClick('[data-testid="office-comms-app-vault"]'), { groups: [['Open']] })
  })

  it('a connected app tile: Open', async () => {
    mount(<AreaAccordion />)
    expectMenuContract(await rightClick('[data-testid="nav-connected-app-ca1"]'), { groups: [['Open']] })
  })

  it('a work widget tile: Add to this desk (with the reason off a desk), New … work widget, Move to …', async () => {
    mount(<AreaAccordion />)
    const items = await rightClick('[data-testid="sidemenu-widget-sticky"]')
    // "Other work widgets" is the section's name as the side menu shows it.
    expectMenuContract(items, {
      groups: [['Add to this desk', 'New sticky work widget', 'Move to Other work widgets']],
      allowCase: ['Move to Other work widgets']
    })
    expect(items[0]).toMatchObject({ disabled: true, hint: 'Open a desk first' })
  })

  it('a People row: Open', async () => {
    mount(<AreaAccordion />)
    const row = document.querySelector('[data-testid^="nav-plexipeople-"]')
    expect(row).toBeTruthy()
    expectMenuContract(await rightClick(`[data-testid="${row!.getAttribute('data-testid')}"]`), { groups: [['Open']] })
  })
})

describe('the open tray: a tab (M-l, E-9)', () => {
  const desk = node({ id: 'd1', kind: 'task', title: 'launch plan' })
  const other = node({ id: 'd2', kind: 'task', title: 'somewhere else' })
  beforeEach(() => {
    useNodeStore.setState({ nodes: [desk, other], loaded: true } as never)
    useViewStore.setState({ view: { kind: 'home' } } as never)
    useDocumentsStore.setState({ list: [{ id: 'doc1', docType: 'doc', title: 'notes', updatedAt: 1, createdAt: 1 }] } as never)
  })

  it('a desk tab: Pin tab | Close tab · Close other tabs · Close all tabs', async () => {
    useOpenTrayStore.setState({
      entries: [
        { key: 'task:d1', view: { kind: 'task', taskId: 'd1' }, at: 2 },
        { key: 'task:d2', view: { kind: 'task', taskId: 'd2' }, at: 1 }
      ]
    } as never)
    mount(<OpenTray />)
    const items = await rightClick('[data-testid="tray-item-task:d1"]')
    expectMenuContract(items, { groups: [['Pin tab'], ['Close tab', 'Close other tabs', 'Close all tabs']] })
    expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual(['Close tab', 'Close other tabs', 'Close all tabs'])
  })

  it('a pinned document tab: Unpin tab · Send to desk ▸ (every desk by name); Close other tabs off when none can close', async () => {
    useOpenTrayStore.setState({
      entries: [{ key: 'document:doc1', view: { kind: 'office', doc: 'doc1' }, at: 1, pinned: true }]
    } as never)
    mount(<OpenTray />)
    const items = await rightClick('[data-testid="tray-item-document:doc1"]')
    expectMenuContract(items, {
      groups: [['Unpin tab', 'Send to desk'], ['Close tab', 'Close other tabs', 'Close all tabs']]
    })
    expect(items.find((i) => i.label === 'Send to desk')!.children!.map((c) => c.label)).toEqual(['launch plan', 'somewhere else'])
    expect(items.find((i) => i.label === 'Close other tabs')).toMatchObject({ disabled: true, hint: 'No other unpinned tabs to close' })
  })
})

import Sidebar from '../../src/renderer/src/components/Sidebar'

describe('the side menu as the app draws it: the desk list rows (Sidebar NavRow)', () => {
  beforeEach(() => {
    useNodeStore.setState({ nodes: [], loaded: true, activeTaskId: null } as never)
    useViewStore.setState({ view: { kind: 'home' } } as never)
  })

  it('Home, Focus, Rooms: Open', async () => {
    mount(<Sidebar />)
    const rows = [...document.querySelectorAll('[data-testid="desk-sidebar"] button.fb-nav-row')] as HTMLElement[]
    const byText = (t: string): HTMLElement => rows.find((r) => r.textContent?.trim() === t)!
    for (const label of ['Home', 'Focus', 'Rooms']) {
      const el = byText(label)
      expect(el, `${label} row`).toBeTruthy()
      el.setAttribute('data-probe', label)
      expectMenuContract(await rightClick(`[data-probe="${label}"]`), { groups: [['Open']] })
    }
  })
})

// Home and Focus: the cards' and blocks' own bodies are stubbed (their content
// is not the menu, and several mount whole apps). The dashboard slots, the
// Focus page's rows and the Attention widget's rows are real.
const stubs = vi.hoisted(() => ({
  components: async (load: () => Promise<Record<string, unknown>>) => {
    const m = await load()
    return Object.fromEntries(
      Object.entries(m).map(([k, v]) => [k, typeof v === 'function' && (k === 'default' || /^[A-Z]/.test(k)) ? () => null : v])
    )
  }
}))
vi.mock('../../src/renderer/src/components/views/dashboardEmbeds', (o) => stubs.components(o as never))
vi.mock('../../src/renderer/src/components/views/homeWidgets', (o) => stubs.components(o as never))
vi.mock('../../src/renderer/src/components/views/attentionWidgets', (o) => stubs.components(o as never))
vi.mock('../../src/renderer/src/components/attention/attentionBlocks', (o) => stubs.components(o as never))
vi.mock('../../src/renderer/src/components/views/MailView', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/MessagesView', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/CalendarView', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/FilesView', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/VaultView', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/PeopleHomeView', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/StandupHome', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/views/StartOrAskPlexi', () => ({ default: () => null }))

import HomeDashboard from '../../src/renderer/src/components/views/HomeDashboard'
import { HOME_WIDGET_DEFS } from '../../src/renderer/src/components/views/homeWidgetDefs'
import AttentionView from '../../src/renderer/src/components/views/AttentionView'
import { WidgetItemRow } from '../../src/renderer/src/components/attention/WidgetItemRow'
import { useWorkItemStore } from '../../src/renderer/src/stores/workItems'

const SIZE_NAMES: Record<string, string> = { icon: 'Icon', sm: 'Small', md: 'Medium', lg: 'Large', stack: 'Stack' }

describe('Home dashboard cards: every card kind', () => {
  const desk = node({ id: 'd1', kind: 'task', title: 'launch plan' })
  const room = node({ id: 'r1', kind: 'folder', title: 'clients' })
  // A real target for every card that points at one.
  const CONFIG: Record<string, Record<string, string>> = {
    'pinned-desk': { deskId: 'd1' },
    'room-portal': { roomId: 'r1' },
    'desk-widget': { deskId: 'd1', widgetId: 'w1' },
    'office-document': { documentId: 'doc1' },
    'work-widget': { widgetFileId: 'f1' },
    'connected-app': { appId: 'ca1' },
    'app-browser': { url: 'https://example.com' },
    'pinned-conversation': { conversationId: 'c1' }
  }
  // What each kind opens, chooses and asks about, stated per kind (not derived
  // from the code under test). Every other kind is a summary card: Size and
  // Remove only.
  const OPENS = new Set(['pinned-desk', 'room-portal', 'desk-widget', 'office-document', 'work-widget', 'connected-app', 'app-mail', 'app-chat', 'app-calendar', 'app-files', 'app-vault'])
  const CHOOSES = new Set(['pinned-desk', 'room-portal', 'desk-widget', 'office-document', 'work-widget', 'app-browser', 'pinned-conversation'])
  const ASKS = new Set(['pinned-desk', 'room-portal'])

  beforeEach(() => {
    useNodeStore.setState({ nodes: [desk, room], loaded: true } as never)
    useViewStore.setState({ view: { kind: 'home' } } as never)
    // The dashboard refreshes the node list on mount.
    ;(window as unknown as { api: unknown }).api = fakeApi({ nodes: { list: async () => [desk, room] } })
  })

  it('each kind: Open · Choose another… · Size ▸ | Ask PlexiiAssist | Remove from Home, as it applies', async () => {
    const defs = HOME_WIDGET_DEFS.filter((d) => d.surfaces?.includes?.('home') ?? true)
    localStorage.setItem(
      'home.layout.v3',
      JSON.stringify({
        widgets: defs.map((d) => ({ key: `k-${d.id}`, widget: d.id, size: d.defaultSize, config: CONFIG[d.id] }))
      })
    )
    mount(<HomeDashboard />)
    let checked = 0
    for (const placed of defs) {
      const slot = document.querySelector(`[data-widget-key="k-${placed.id}"]`)
      if (!slot) continue
      // A retired kind is migrated on load (quick-links became Shortcuts): the
      // menu belongs to what the slot holds now.
      const d = HOME_WIDGET_DEFS.find((x) => x.id === slot.getAttribute('data-widget'))!
      const items = await rightClick(`[data-widget-key="k-${placed.id}"]`)
      const object = [
        ...(OPENS.has(d.id) ? ['Open'] : []),
        ...(CHOOSES.has(d.id) ? ['Choose another…'] : []),
        ...(d.sizes.length > 1 ? ['Size'] : [])
      ]
      const groups = [object, ASKS.has(d.id) ? ['Ask PlexiiAssist'] : [], ['Remove from Home']].filter((g) => g.length)
      expect(items[items.length - 1], `${d.id}: removal is last and destructive`).toMatchObject({ label: 'Remove from Home', danger: true })
      // A card that can only be removed has a one-row menu; the shared helper
      // wants a separator before the first danger row even when nothing comes
      // before it (reported to 2e), so that one shape is checked undecorated.
      // "Home" is a named place, like Focus (PROPER in the helper lacks it; reported).
      expectMenuContract(items.length === 1 ? [{ ...items[0], danger: false }] : items, { groups, allowCase: ['Remove from Home'] }, d.id)
      const size = items.find((i) => i.label === 'Size')
      if (size) {
        expect(size.children!.map((c) => c.label), `${d.id} sizes`).toEqual(d.sizes.map((s) => SIZE_NAMES[s]))
        const on = size.children!.filter((c) => c.checked).map((c) => c.label)
        expect(on, `${d.id}: exactly the current size is checked`).toHaveLength(1)
        if (d.id === placed.id) expect(on).toEqual([SIZE_NAMES[d.defaultSize]])
      }
      checked++
    }
    // Every kind offered on Home was placed and right-clicked.
    expect(checked).toBe(defs.length)
  })

  it('on another dashboard the removal says so', async () => {
    localStorage.setItem('home.layout.v3.office', JSON.stringify({ widgets: [{ key: 'k1', widget: 'app-mail', size: 'lg' }] }))
    mount(<HomeDashboard surface="office" />)
    const items = await rightClick('[data-widget-key="k1"]')
    expect(items[items.length - 1]).toMatchObject({ label: 'Remove from this dashboard', danger: true })
  })
})

describe('Focus rows', () => {
  const desk = node({ id: 'd1', kind: 'task', title: 'launch plan' })
  const item = node({
    id: 'i1',
    kind: 'work_item' as FbNode['kind'],
    parentId: 'd1',
    title: 'call the printer',
    intentClass: 'to_do',
    workItemState: 'open',
    sourceUrl: 'https://example.com/ticket/1'
  } as never)

  beforeEach(() => {
    useNodeStore.setState({ nodes: [desk], loaded: true } as never)
    useWorkItemStore.setState({ items: [item], loaded: true } as never)
    ;(window as unknown as { api: unknown }).api = fakeApi({ workItems: { list: async () => [item] } })
  })

  it('the Focus page row: Open · Open desk · Open source page · Snooze until tomorrow | Copy | Ask PlexiiAssist | Archive', async () => {
    mount(<AttentionView />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const items = await rightClick('[data-item-row][data-item-id="i1"]')
    expectMenuContract(items, {
      groups: [['Open', 'Open desk', 'Open source page', 'Snooze until tomorrow'], ['Copy'], ['Ask PlexiiAssist'], ['Archive']]
    })
  })

  it('the Attention work widget row: the same doors it has (no Copy there)', async () => {
    mount(<WidgetItemRow i={item} nowMs={Date.now()} />)
    const items = await rightClick('[data-testid="widget-item-i1"]')
    expectMenuContract(items, {
      groups: [['Open', 'Open desk', 'Open source page', 'Snooze until tomorrow'], ['Ask PlexiiAssist'], ['Archive']]
    })
  })

  it('a closed item keeps only its doors', async () => {
    const done = { ...item, workItemState: 'completed' } as FbNode
    mount(<WidgetItemRow i={done} nowMs={Date.now()} />)
    const items = await rightClick('[data-testid="widget-item-i1"]')
    expectMenuContract(items, { groups: [['Open', 'Open desk', 'Open source page']] })
  })
})
