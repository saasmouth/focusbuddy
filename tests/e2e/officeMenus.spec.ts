import { test, expect, type Page, type Locator } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, placeDesign, type LaunchedApp } from './_helpers'

// GUARD, by real clicks, for the office menu contract (SPEC §9; 4.3.41 owner
// ask: "menus in office apps, right-click context menus system wide … should
// share functionality and layout for familiarity across the system").
//
// For each office app this opens the menu bar the way a person does, reads Edit
// and Help as rendered, and checks the shared items are there with the same
// label, in the same order, with the same hint; that ⌘/ opens the app's own
// shortcuts (not the global sheet) and ⌘F its Find and replace; and that a
// right-click on an object opens the kit's menu in the shared shape.
// tests/unit/officeMenuBarContract + officeContextMenus check the definitions;
// this checks the built app shows and binds them.

const EDIT_ORDER = ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste in place', 'Duplicate', 'Delete', 'Select all', 'Find…', 'Find and replace…', 'Save selection as snippet…']
const HINT: Record<string, string> = {
  Undo: '⌘Z',
  Redo: '⇧⌘Z',
  Cut: '⌘X',
  Copy: '⌘C',
  Paste: '⌘V',
  Duplicate: '⌘D',
  Delete: '⌫',
  'Select all': '⌘A',
  'Find…': '⌘F',
  'Find and replace…': '⇧⌘H',
  'Bring to front': '⇧⌘]',
  'Send to back': '⇧⌘['
}

interface App {
  name: string
  docType: string
  body?: unknown
  bar: string
  item: string
  /** Edit rows this app does not offer, for the reason in SPEC §9.6. */
  noEdit?: string[]
  /** Find opens this panel (Write and Diagrams have their own). */
  find: string
  /** Right-click target and the menu it must open; omitted where the target is text (native menu). */
  object?: { sel: string; prep?: (w: Page) => Promise<void>; menu: string; must: string[] }
}

const APPS: App[] = [
  { name: 'Write', docType: 'doc', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] }, bar: 'doc-menubar', item: 'doc-menu', noEdit: ['Delete', 'Duplicate'], find: 'doc-find-replace' },
  {
    name: 'Cells',
    docType: 'sheet',
    bar: 'sheet-menubar',
    item: 'sheet-menubar',
    noEdit: ['Duplicate'],
    find: 'sheet-find',
    object: { sel: '[data-testid="cell-1-1"]', menu: 'sheet-cell-menu', must: ['Cut', 'Copy', 'Paste', 'Save selection as snippet…', 'More actions', 'Delete'] }
  },
  {
    name: 'Deck',
    docType: 'slides',
    body: { slides: [{ id: 's1', notes: '', elements: [{ id: 'e1', type: 'text', x: 300, y: 250, w: 400, h: 100, paragraphs: [{ runs: [{ text: 'Hello slide' }] }] }] }] },
    bar: 'slides-menubar',
    item: 'slides-menubar',
    find: 'slides-find',
    object: { sel: '.react-draggable:has([data-testid="slide-element"])', menu: 'slides-context-menu', must: ['Cut', 'Copy', 'Paste', 'Duplicate', 'Bring to front', 'Send to back', 'Save selection as snippet…', 'More actions', 'Delete'] }
  },
  {
    name: 'Diagrams',
    docType: 'map',
    body: { version: 1, nodes: [{ id: 'a', x: 200, y: 160, label: 'Node A', shape: 'rect', color: '#336699', width: 160, height: 80 }], edges: [] },
    bar: 'draw-menubar',
    item: 'draw-menubar',
    find: 'diagram-find-panel',
    object: { sel: '.react-flow__node', menu: 'diagram-context-menu', must: ['Edit text', 'Cut', 'Copy', 'Paste', 'Duplicate', 'Bring to front', 'Send to back', 'Save selection as snippet…', 'More actions', 'Delete'] }
  },
  {
    name: 'Design',
    docType: 'design',
    bar: 'design-menubar',
    item: 'design-menubar',
    noEdit: ['Find…', 'Find and replace…'],
    find: '',
    object: {
      sel: '.react-draggable:has([data-testid="slide-element"])',
      prep: async (w) => {
        await placeDesign(w, 'rect', { fx: 0.5, fy: 0.5 })
      },
      menu: 'design-context-menu',
      must: ['Cut', 'Copy', 'Paste', 'Duplicate', 'Bring to front', 'Send to back', 'Save selection as snippet…', 'More actions', 'Delete']
    }
  }
]

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

type Row = { label: string; shortcut: string } | 'sep'
async function rows(list: Locator): Promise<Row[]> {
  return list.evaluate((root) =>
    Array.from(root.children).flatMap((k): Row[] => {
      if (k.tagName === 'DIV' && k.classList.contains('border-t')) return ['sep']
      const b = k.tagName === 'BUTTON' ? k : k.querySelector(':scope > button')
      if (!b) return []
      const sp = b.querySelector('span.flex-1') as HTMLElement | null
      return [{ label: ((sp?.firstChild?.textContent ?? '') as string).trim(), shortcut: ((b.querySelector('span.fb-tabular') as HTMLElement | null)?.textContent ?? '').trim() }]
    })
  )
}
async function openMenu(w: Page, app: App, id: string): Promise<Row[]> {
  await w.locator(`[data-testid="${app.item}-${id}"]`).click()
  const list = w.locator(`[data-testid="${app.item}-${id}-list"]`)
  await expect(list).toBeVisible()
  const out = await rows(list)
  await w.keyboard.press('Escape')
  await expect(list).toBeHidden()
  return out
}

async function open(app: App): Promise<Page> {
  launched = await launchApp()
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = await w.evaluate(
    async (a) => ((await (window as unknown as { api: typeof window.api }).api.documents.create({ docType: a.docType, title: `Menus ${a.name}`, ...(a.body ? { body: a.body } : {}) } as never)) as { id: string }).id,
    { docType: app.docType, name: app.name, body: app.body }
  )
  await w.reload()
  await waitForReady(w)
  await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  await expect(w.locator(`[data-testid="${app.bar}"]`)).toBeVisible({ timeout: 15_000 })
  return w
}

for (const app of APPS) {
  test(`${app.name}: menu bar, keys and right-click keep the shared contract`, async () => {
    test.setTimeout(120_000)
    const w = await open(app)

    // Edit: every shared row the app offers, in order, with the shared hint.
    const edit = (await openMenu(w, app, 'edit')).filter((r): r is { label: string; shortcut: string } => r !== 'sep')
    const shared = edit.filter((r) => EDIT_ORDER.includes(r.label))
    expect(shared.map((r) => r.label), `${app.name} › Edit order`).toEqual(EDIT_ORDER.filter((l) => shared.some((r) => r.label === l)))
    for (const l of ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Duplicate', 'Delete', 'Select all', 'Find…', 'Find and replace…', 'Save selection as snippet…'])
      if (!app.noEdit?.includes(l)) expect(shared.map((r) => r.label), `${app.name} › Edit is missing ${l}`).toContain(l)
    for (const r of shared) if (HINT[r.label]) expect(r.shortcut, `${app.name} › Edit › ${r.label}`).toBe(HINT[r.label])

    // Help: Keyboard shortcuts ⌘/, and ⌘/ opens THIS app's sheet, not the global one.
    const help = await openMenu(w, app, 'help')
    expect(help).toContainEqual({ label: 'Keyboard shortcuts', shortcut: '⌘/' })
    await w.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
    await w.keyboard.press('Meta+/')
    const sheet = app.name === 'Diagrams' ? w.locator('[data-testid="diagram-shortcuts"]') : w.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(sheet, `${app.name}: ⌘/ opens the app's shortcuts`).toBeVisible()
    await expect(w.locator('[data-testid="shortcuts-overlay"]'), `${app.name}: ⌘/ must not open the global sheet`).toHaveCount(0)
    await w.keyboard.press('Escape')
    if (await sheet.isVisible()) await sheet.getByTitle('Close').first().click()
    await expect(sheet).toBeHidden()

    // ⌘F opens Find…, ⇧⌘H Find and replace… (E-14), where the app has them.
    if (app.find) {
      const focusEditor = async (): Promise<void> => {
        if (app.name === 'Write') await w.locator('.ProseMirror').click()
        else await w.locator(`[data-testid="${app.bar}"]`).click({ position: { x: 400, y: 5 } }).catch(() => undefined)
      }
      const panel = w.locator(`[data-testid="${app.find}"]`)
      await focusEditor()
      await w.keyboard.press('Meta+f')
      await expect(panel, `${app.name}: ⌘F opens Find`).toBeVisible()
      await w.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      await focusEditor()
      // With text selected, so a stray Highlight would actually mark it.
      if (app.name === 'Write') await w.keyboard.press('Meta+a')
      await w.keyboard.press('Meta+Shift+h')
      await expect(panel, `${app.name}: ⇧⌘H opens Find and replace`).toBeVisible()
      await expect(panel.getByPlaceholder('Replace with').first(), `${app.name}: with its Replace row`).toBeVisible()
      // And nothing else happened: in Write ⇧⌘H was TipTap Highlight's default,
      // so a Highlight keymap that ran first and returned false would still
      // open the panel while marking the text (ec's review).
      if (app.name === 'Write') await expect(w.locator('.ProseMirror mark'), 'Write: ⇧⌘H applied no highlight').toHaveCount(0)
      await w.keyboard.press('Escape')
    }

    // Right-click on an object: the kit's menu (role=menu) in the shared shape,
    // Delete last in the danger colour.
    if (app.object) {
      await app.object.prep?.(w)
      const target = w.locator(app.object.sel).first()
      await target.click({ button: 'right' })
      const menu = w.locator(`[data-testid="${app.object.menu}"]`)
      await expect(menu).toBeVisible()
      await expect(menu).toHaveAttribute('role', 'menu')
      const labels = await menu.locator(':scope > div > button').evaluateAll((bs) =>
        bs.map((b) => (((b.querySelector('span.flex-1') as HTMLElement | null)?.firstChild?.textContent ?? '') as string).trim())
      )
      const present = labels.filter((l) => app.object!.must.includes(l))
      expect(present, `${app.name}: right-click rows in the shared order`).toEqual(app.object.must)
      expect(labels[labels.length - 1], `${app.name}: Delete is last`).toBe('Delete')
      await expect(menu.locator(':scope > div > button').last()).toHaveClass(/text-red-600/)
      const shortcuts = await menu.locator(':scope > div > button').evaluateAll((bs) =>
        bs.map((b) => [(((b.querySelector('span.flex-1') as HTMLElement | null)?.firstChild?.textContent ?? '') as string).trim(), (b.querySelector('span.font-mono')?.textContent ?? '').trim()])
      )
      for (const [l, k] of shortcuts) if (HINT[l!]) expect(k, `${app.name}: right-click ${l} hint matches the menu bar`).toBe(HINT[l!])
      await w.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    }
  })
}

// The kit's menu is OPAQUE in every theme. Glass (92% fill in dark, 80% in
// atelier) let busy content read through every right-click menu; toBeVisible
// and elementFromPoint both pass on a translucent menu, so only the computed
// fill alpha, taken after the pop-in has finished, catches it (2e wp1b; WH-5).
for (const theme of ['light', 'dark', 'atelier'] as const) {
  test(`the right-click menu is opaque, rows and all, in ${theme}`, async () => {
    test.setTimeout(90_000)
    launched = await launchApp()
    const w = launched.window
    await waitForReady(w)
    await w.evaluate((m: string) => localStorage.setItem('fb.theme.mode', m), theme)
    const app = APPS.find((a) => a.name === 'Deck')!
    await w.reload()
    await waitForReady(w)
    await chooseCloudAiSource(w)
    await suppressFeatureSpotlights(w)
    const id = await w.evaluate(
      async (body) => ((await (window as unknown as { api: typeof window.api }).api.documents.create({ docType: 'slides', title: 'Opaque menu', body } as never)) as { id: string }).id,
      app.body
    )
    await w.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
    // The element's frame: its content node takes no pointer events.
    await w.locator('.react-draggable:has([data-testid="slide-element"])').first().click({ button: 'right' })
    const menu = w.locator('[data-testid="slides-context-menu"]')
    await expect(menu).toBeVisible()
    // And a submenu, which is a panel of its own.
    await menu.locator('[data-testid="ctx-moreActions"]').hover()
    await expect(w.locator('[data-canvas-ctx-menu]')).toHaveCount(2)
    const panels = await w.evaluate(async () => {
      const els = Array.from(document.querySelectorAll('[data-canvas-ctx-menu]')) as HTMLElement[]
      await Promise.all(els.flatMap((el) => el.getAnimations().map((a) => a.finished.catch(() => undefined))))
      return els.map((el) => {
        const bg = getComputedStyle(el).backgroundColor
        const raw = bg.match(/\/\s*([\d.]+%?)\s*\)$/)?.[1] ?? bg.match(/^rgba\([^)]*,\s*([\d.]+)\)$/)?.[1]
        let opacity = 1
        for (let n: HTMLElement | null = el; n; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity)
        return { bg, alpha: raw === undefined ? 1 : raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw), opacity, blur: getComputedStyle(el).backdropFilter }
      })
    })
    for (const p of panels) {
      expect(p.alpha, `fill is fully opaque in ${theme} (computed ${p.bg})`).toBe(1)
      expect(p.opacity, `panel at full opacity after the entrance in ${theme}`).toBe(1)
    }
    await w.screenshot({ path: test.info().outputPath(`ctx-menu-${theme}.png`) })
  })
}
