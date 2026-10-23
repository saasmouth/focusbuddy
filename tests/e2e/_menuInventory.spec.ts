// AUDIT TOOL, not a guard: record every office app's menu-bar items and
// right-click menus as a person sees them, into one JSON file, for the §9
// menu-contract audit matrix. Run with MENU_INVENTORY_OUT=<path>.
import { test, type Page, type ElectronApplication } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, type LaunchedApp } from './_helpers'

type Entry = { kind: 'item'; label: string; shortcut: string; disabled: boolean; hint?: string } | { kind: 'sep' } | { kind: 'submenu'; label: string; items: Entry[] }
interface AppSpec {
  name: string
  docType: string
  body?: unknown
  menubar: string // data-testid of the MenuBarShell
  itemPrefix: string // per-menu trigger testid prefix
  surface: string // selector to right-click as "empty surface"
  object?: { sel: string; prep?: 'selectText' | 'click' }
}

const APPS: AppSpec[] = [
  { name: 'Write', docType: 'doc', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world here' }] }] }, menubar: 'doc-menubar', itemPrefix: 'doc-menu', surface: '.ProseMirror', object: { sel: '.ProseMirror p', prep: 'selectText' } },
  { name: 'Cells', docType: 'sheet', menubar: 'sheet-menubar', itemPrefix: 'sheet-menubar', surface: '[data-testid="cell-1-1"]', object: { sel: '[data-testid="col-header-1"]' } },
  { name: 'Deck', docType: 'slides', body: { slides: [{ id: 's1', notes: '', elements: [{ id: 'e1', type: 'text', x: 300, y: 250, w: 400, h: 100, paragraphs: [{ runs: [{ text: 'Hello slide' }] }] }] }] }, menubar: 'slides-menubar', itemPrefix: 'slides-menubar', surface: '[data-testid="slide-canvas"]', object: { sel: '[data-testid="slide-element"]', prep: 'click' } },
  { name: 'Diagrams', docType: 'map', body: { version: 1, nodes: [{ id: 'a', x: 200, y: 160, label: 'Node A', shape: 'rect', color: '#336699', width: 160, height: 80 }], edges: [] }, menubar: 'draw-menubar', itemPrefix: 'draw-menubar', surface: '.react-flow__pane', object: { sel: '.react-flow__node', prep: 'click' } },
  { name: 'Design', docType: 'design', menubar: 'design-menubar', itemPrefix: 'design-menubar', surface: '[data-testid="design-editor"]' },
  { name: 'Draw', docType: 'draw', menubar: 'draw-studio-menubar', itemPrefix: 'draw-studio-menubar', surface: '[data-testid="draw-stage"]' }
]

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// One in-page pass per open menu: items, separators, and each submenu (opened by
// dispatching the hover its row listens for, then read). Label = the label span's
// own first text node (not the icon ligature or the hint line).
async function readList(list: import('@playwright/test').Locator): Promise<Entry[]> {
  return list.evaluate(async (root) => {
    const lab = (b: Element): string => {
      const sp = b.querySelector('span.flex-1') as HTMLElement | null
      return ((sp?.firstChild?.textContent ?? sp?.textContent ?? '') as string).trim()
    }
    const sc = (b: Element): string => ((b.querySelector('span.fb-tabular') as HTMLElement | null)?.textContent ?? '').trim()
    const hint = (b: Element): string | undefined => ((b.querySelector('span.flex-1 > span') as HTMLElement | null)?.textContent ?? undefined) || undefined
    const out: unknown[] = []
    for (const k of Array.from(root.children)) {
      if (k.tagName === 'DIV' && k.classList.contains('border-t')) { out.push({ kind: 'sep' }); continue }
      if (k.tagName === 'BUTTON') { out.push({ kind: 'item', label: lab(k), shortcut: sc(k), disabled: (k as HTMLButtonElement).disabled, hint: hint(k) }); continue }
      if (k.tagName === 'DIV') {
        const head = k.querySelector(':scope > button')
        k.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 60))
        const panel = k.querySelector(':scope > div.fb-glass-panel')
        const items = panel ? Array.from(panel.querySelectorAll(':scope > button')).map((b) => ({ kind: 'item', label: lab(b), shortcut: sc(b), disabled: (b as HTMLButtonElement).disabled, hint: hint(b) })) : []
        k.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
        out.push({ kind: 'submenu', label: head ? lab(head) : '', items })
      }
    }
    return out
  }) as Promise<Entry[]>
}

async function crawlMenubar(page: Page, app: AppSpec): Promise<Record<string, Entry[]>> {
  const bar = page.locator(`[data-testid="${app.menubar}"]`).first()
  if (!(await bar.count())) return { _missing: [] }
  const ids = await bar.locator(`[data-testid^="${app.itemPrefix}-"]`).evaluateAll((els, prefix) =>
    els.map((e) => (e as HTMLElement).dataset.testid!).filter((t) => !t.endsWith('-list') && t.startsWith(prefix + '-')), app.itemPrefix)
  const menus: Record<string, Entry[]> = {}
  for (const id of [...new Set(ids)]) {
    const trigger = page.locator(`[data-testid="${id}"]`).first()
    if (!(await trigger.isVisible().catch(() => false))) continue
    const title = ((await trigger.textContent()) ?? id).trim()
    await trigger.click()
    const list = page.locator(`[data-testid="${id}-list"]`)
    await list.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
    menus[title] = (await list.count()) ? await readList(list) : []
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5).catch(() => undefined)
    await page.waitForTimeout(100)
  }
  return menus
}

async function rightClick(page: Page, electron: ElectronApplication, sel: string, prep?: 'selectText' | 'click'): Promise<unknown> {
  const el = page.locator(sel).first()
  if (!(await el.count())) return { _missing: sel }
  await el.scrollIntoViewIfNeeded().catch(() => undefined)
  if (prep === 'click') await el.click({ timeout: 3000 }).catch(() => undefined)
  if (prep === 'selectText')
    await el.evaluate((n) => {
      const r = document.createRange()
      r.selectNodeContents(n)
      const s = getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })
  await electron.evaluate(() => ((globalThis as unknown as { __plexiiLastWebMenu?: unknown }).__plexiiLastWebMenu = null))
  const box = (await el.boundingBox())!
  await page.mouse.click(box.x + Math.min(box.width / 2, 60), box.y + Math.min(box.height / 2, 30), { button: 'right' })
  await page.waitForTimeout(500)
  // Any visible context-menu container: the kit's role="menu", and the office
  // apps' own menus, which do not all carry a role (itself an inconsistency).
  const dom = page.locator('[role="menu"], [data-testid*="context-menu"], [data-testid*="ctx-menu"], [data-canvas-ctx-menu], [data-testid="sheet-col-menu"], [data-testid="sheet-row-menu"]').filter({ visible: true }).last()
  if (await dom.count()) {
    const items = await dom.evaluate((m) =>
      Array.from(m.querySelectorAll('[role="menuitem"], button, [role="separator"], hr, .border-t')).map((e) => {
        const el = e as HTMLElement
        if (el.getAttribute('role') === 'separator' || el.tagName === 'HR' || (el.classList.contains('border-t') && !el.textContent?.trim())) return { kind: 'sep' }
        return { kind: 'item', text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' }
      })
    )
    await page.keyboard.press('Escape')
    return { source: 'dom', items }
  }
  const native = await electron.evaluate(() => (globalThis as unknown as { __plexiiLastWebMenu?: { surface: string; flat: unknown } }).__plexiiLastWebMenu ?? null)
  if (native) return { source: 'native', surface: native.surface, items: native.flat }
  return { source: 'none' }
}

for (const app of APPS) {
  test(`menu inventory: ${app.name}`, async () => {
    test.skip(!process.env.MENU_INVENTORY_OUT, 'audit tool: set MENU_INVENTORY_OUT=<path prefix> to run')
    test.setTimeout(180_000)
    launched = await launchApp({ env: { PLEXI_WEB_MENU_HOOK: '1' } })
    const { window, app: electron } = launched
    await waitForReady(window)
    await chooseCloudAiSource(window)
    await suppressFeatureSpotlights(window)
    const id = await window.evaluate(async (a) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const d = (await api.documents.create({ docType: a.docType, title: `Inventory ${a.name}`, ...(a.body ? { body: a.body } : {}) } as never)) as { id: string }
      return d.id
    }, { docType: app.docType, name: app.name, body: app.body })
    await window.reload()
    await waitForReady(window)
    await window.evaluate((i) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
    await window.waitForTimeout(2500)
    const menubar = await crawlMenubar(window, app)
    const surface = await rightClick(window, electron, app.surface)
    const object = app.object ? await rightClick(window, electron, app.object.sel, app.object.prep) : { _noTarget: true }
    writeFileSync(`${process.env.MENU_INVENTORY_OUT ?? 'menu-inventory'}.${app.name}.json`, JSON.stringify({ menubar, rightClick: { surface, object } }, null, 2))
  })
}
