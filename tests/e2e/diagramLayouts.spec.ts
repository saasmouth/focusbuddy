// PlexiiDiagrams automatic layouts, driven from where the controls live on the
// office shell (Home › Layout). Owner test on 4.3.41: "Try Layout › hierarchy,
// tree, mind map, radial, organic and grid. Expected: each rearranges the
// diagram without overlaps."
//
// Each layout runs on a fresh copy of a realistic diagram (an onboarding flow
// of 15 connected shapes dropped messily, plus a swimlane container holding
// three connected children) and must:
//   1. actually move shapes (the saved model changes),
//   2. leave no two shapes overlapping AS DRAWN (on-screen boxes, which is what
//      the person sees; a label can make a shape render bigger than its model),
//   3. put no free shape on top of the container (that would also silently
//      re-parent it into the lane on the next move),
//   4. keep the container's children inside it.
//
// DL-2 is the case the owner most likely hit: the built-in "Approval flow"
// swimlane template. Its shapes sit in their lanes with no parentId (they were
// never dragged, and membership is assigned after a drag), so the layout used
// to treat them as free — carrying them out of their lanes, or doing nothing —
// instead of laying each lane's contents out inside it.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, selectBarTab, type LaunchedApp } from './_helpers'

type Box = { id: string; x: number; y: number; w: number; h: number; shape: string; parent: string | null }

const LAYOUTS: { name: string; menu: string }[] = [
  { name: 'hierarchy', menu: 'Hierarchy, top to bottom' },
  { name: 'tree', menu: 'Tree (org chart)' },
  { name: 'mind map', menu: 'Mind map' },
  { name: 'radial', menu: 'Radial' },
  { name: 'organic', menu: 'Organic' },
  { name: 'grid', menu: 'Grid' }
]

function seedBody(): Record<string, unknown> {
  const n = (id: string, label: string, x: number, y: number, shape = 'process', extra: Record<string, unknown> = {}) => ({ id, label, x, y, shape, color: '#2563eb', ...extra })
  const nodes = [
    n('start', 'Start', 40, 40, 'terminator'),
    n('signup', 'Sign up', 300, 60),
    n('verify', 'Email verified?', 120, 220, 'decision'),
    n('resend', 'Resend link', 420, 260),
    n('profile', 'Complete profile', 60, 420),
    n('plan', 'Pick a plan?', 380, 470, 'decision'),
    n('free', 'Free tier', 120, 640),
    n('trial', 'Start 14-day trial', 520, 600),
    n('pay', 'Take payment', 700, 420),
    n('invoice', 'Invoice', 860, 300, 'document'),
    n('welcome', 'Welcome email', 640, 760),
    n('tour', 'Product tour', 300, 820),
    n('done', 'Activated', 520, 980, 'terminator'),
    n('crm', 'CRM record', 900, 700, 'database'),
    n('notify', 'Notify sales', 980, 520),
    n('lane', 'Back office', 1200, 100, 'lane', { width: 640, height: 300 }),
    n('kyc', 'KYC check', 1240, 170, 'process', { parentId: 'lane' }),
    n('approve', 'Approved?', 1460, 170, 'decision', { parentId: 'lane' }),
    n('archive', 'Archive', 1680, 180, 'process', { parentId: 'lane' })
  ]
  const e = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t })
  const edges = [
    e('start', 'signup'), e('signup', 'verify'), e('verify', 'resend'), e('resend', 'verify'), e('verify', 'profile'), e('profile', 'plan'),
    e('plan', 'free'), e('plan', 'trial'), e('trial', 'pay'), e('pay', 'invoice'), e('invoice', 'crm'), e('free', 'welcome'), e('pay', 'welcome'),
    e('welcome', 'tour'), e('tour', 'done'), e('pay', 'notify'), e('notify', 'kyc'), e('kyc', 'approve'), e('approve', 'archive')
  ]
  return { version: 1, nodes, edges }
}

async function openSeeded(window: Page, title: string): Promise<string> {
  const id = await window.evaluate(
    async ({ t, body }) => {
      const w = window as unknown as {
        api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
        __fbView?: { getState: () => { goDocument: (id: string) => void } }
      }
      const d = await w.api.documents.create({ docType: 'map', title: t, body })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    },
    { t: title, body: seedBody() }
  )
  await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
  await expect(window.locator('.react-flow__node')).toHaveCount(19, { timeout: 8_000 })
  return id
}

async function savedPositions(window: Page, id: string): Promise<Record<string, { x: number; y: number }>> {
  return window.evaluate(async (docId: string) => {
    const api = (window as unknown as { api: { documents: { get: (id: string) => Promise<{ body: unknown } | null> } } }).api
    const body = ((await api.documents.get(docId))?.body ?? {}) as { nodes?: { id: string; x: number; y: number }[] }
    return Object.fromEntries((body.nodes ?? []).map((n) => [n.id, { x: n.x, y: n.y }]))
  }, id)
}

/** On-screen boxes of every shape, in one frame. */
async function drawnBoxes(window: Page): Promise<Box[]> {
  return window.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).map((el) => {
      const r = el.getBoundingClientRect()
      const inner = el.querySelector<HTMLElement>('[data-shape]')
      return {
        id: el.dataset.id ?? '',
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        shape: inner?.dataset.shape ?? el.dataset.shape ?? '',
        parent: inner?.dataset.parent ?? null
      }
    })
  )
}

const overlap = (a: Box, b: Box, slack = 1): boolean => a.x + slack < b.x + b.w && b.x + slack < a.x + a.w && a.y + slack < b.y + b.h && b.y + slack < a.y + a.h
const inside = (a: Box, c: Box, slack = 2): boolean => a.x >= c.x - slack && a.y >= c.y - slack && a.x + a.w <= c.x + c.w + slack && a.y + a.h <= c.y + c.h + slack

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('DL-1 — every automatic layout, from Home › Layout, moves the shapes and leaves none overlapping', async () => {
  test.setTimeout(150_000)
  launched = await launchApp()
  const { window } = launched
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  await chooseCloudAiSource(window)

  const CHILDREN = new Set(['kyc', 'approve', 'archive'])
  for (const layout of LAYOUTS) {
    const id = await openSeeded(window, `Layouts — ${layout.name}`)
    // Let the first save land so "before" is the stored diagram.
    await expect.poll(async () => Object.keys(await savedPositions(window, id)).length, { timeout: 8_000 }).toBe(19)
    const before = await savedPositions(window, id)

    // Home › Layout › <layout>. Nothing selected, so the whole page is laid out.
    await window.locator('[data-testid="diagram-canvas"]').click({ position: { x: 8, y: 8 } })
    await window.locator('[data-testid="map-arrange"]').click()
    await window.getByRole('menuitem', { name: layout.menu, exact: true }).click()

    // 1. It moved shapes (in the saved model), and the container stayed where it was.
    let after: Record<string, { x: number; y: number }> = {}
    await expect
      .poll(
        async () => {
          after = await savedPositions(window, id)
          return Object.keys(before).filter((k) => !CHILDREN.has(k) && k !== 'lane' && (Math.abs(before[k]!.x - after[k]!.x) > 1 || Math.abs(before[k]!.y - after[k]!.y) > 1)).length
        },
        { message: `${layout.name}: the layout moved the free shapes`, timeout: 8_000 }
      )
      .toBeGreaterThanOrEqual(12)

    // Let the fit animation settle, then read the drawn boxes in one frame.
    await window.waitForTimeout(500)
    const boxes = await drawnBoxes(window)
    const lane = boxes.find((b) => b.id === 'lane')!
    const shapes = boxes.filter((b) => b.id !== 'lane')

    // 2. No two shapes overlap as drawn.
    const pairs: string[] = []
    for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) if (overlap(shapes[i]!, shapes[j]!)) pairs.push(`${shapes[i]!.id}/${shapes[j]!.id}`)
    expect(pairs, `${layout.name}: shapes overlapping on screen`).toEqual([])

    // 3. No free shape sits on the container. 4. Its children are still inside it.
    const onLane = shapes.filter((b) => !CHILDREN.has(b.id) && overlap(b, lane)).map((b) => b.id)
    expect(onLane, `${layout.name}: free shapes on top of the swimlane`).toEqual([])
    const strays = shapes.filter((b) => CHILDREN.has(b.id) && !inside(b, lane)).map((b) => b.id)
    expect(strays, `${layout.name}: swimlane children outside their lane`).toEqual([])
  }
  expect(errors).toEqual([])
})

test('DL-2 — on the Approval flow (swimlane) template, every layout lays each lane\'s shapes out INSIDE their lane', async () => {
  test.setTimeout(150_000)
  launched = await launchApp()
  const { window } = launched
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  await chooseCloudAiSource(window)

  for (const layout of LAYOUTS) {
    const id = await window.evaluate(async (t: string) => {
      const w = window as unknown as {
        api: { documents: { create: (o: Record<string, unknown>) => Promise<{ id: string }> } }
        __fbView?: { getState: () => { goDocument: (id: string) => void } }
      }
      const d = await w.api.documents.create({ docType: 'map', title: t })
      w.__fbView?.getState().goDocument(d.id)
      return d.id
    }, `Swimlane layout — ${layout.name}`)
    await expect(window.locator('[data-testid="diagram-editor"]')).toBeVisible({ timeout: 12_000 })
    // Insert › Template › Approval flow (replaces the starter content).
    await selectBarTab(window, 'diagram-toolbar', 'insert')
    await window.locator('[data-testid="diagram-templates"]').click()
    await window.locator('[data-testid="diagram-template-swimlane"]').click()
    await expect(window.locator('.react-flow__node')).toHaveCount(9, { timeout: 8_000 })
    await expect.poll(async () => Object.keys(await savedPositions(window, id)).length, { timeout: 8_000 }).toBe(9)
    const before = await savedPositions(window, id)

    // Which lane each shape starts in, read from the drawn boxes.
    await window.waitForTimeout(400)
    const start = await drawnBoxes(window)
    const lanesAt = start.filter((b) => ['lane1', 'lane2', 'lane3'].includes(b.id))
    const home: Record<string, string> = {}
    for (const b of start.filter((x) => !x.id.startsWith('lane'))) home[b.id] = lanesAt.find((l) => inside(b, l))?.id ?? '?'
    expect(Object.values(home), 'the template puts every shape in a lane').not.toContain('?')

    await selectBarTab(window, 'diagram-toolbar', 'home')
    await window.locator('[data-testid="diagram-canvas"]').click({ position: { x: 8, y: 8 } })
    await window.locator('[data-testid="map-arrange"]').click()
    await window.getByRole('menuitem', { name: layout.menu, exact: true }).click()

    await expect
      .poll(
        async () => {
          const after = await savedPositions(window, id)
          return Object.keys(home).filter((k) => Math.abs(before[k]!.x - after[k]!.x) > 1 || Math.abs(before[k]!.y - after[k]!.y) > 1).length
        },
        { message: `${layout.name}: the layout moved the shapes`, timeout: 8_000 }
      )
      .toBeGreaterThan(0)
    await window.waitForTimeout(500)
    const boxes = await drawnBoxes(window)
    const get = (bid: string): Box => boxes.find((b) => b.id === bid)!
    const lanes = ['lane1', 'lane2', 'lane3'].map(get)
    const shapes = boxes.filter((b) => !b.id.startsWith('lane'))
    for (const [sid, lane] of Object.entries(home)) expect(inside(get(sid), get(lane)), `${layout.name}: ${sid} stayed in ${lane}`).toBe(true)
    for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) expect(overlap(lanes[i]!, lanes[j]!), `${layout.name}: lanes overlap`).toBe(false)
    const pairs: string[] = []
    for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) if (overlap(shapes[i]!, shapes[j]!)) pairs.push(`${shapes[i]!.id}/${shapes[j]!.id}`)
    expect(pairs, `${layout.name}: shapes overlapping on screen`).toEqual([])
    for (const [sid, lane] of Object.entries(home)) for (const l of lanes) if (l.id !== lane) expect(overlap(get(sid), l), `${layout.name}: ${sid} on ${l.id}`).toBe(false)
  }
  expect(errors).toEqual([])
})

