import { expect, type Page } from '@playwright/test'
import { chooseCloudAiSource, switchArea } from './_helpers'

// Shared PlexiiDraw e2e helpers, lifted from drawStudio.spec.ts so every Draw
// spec drives the studio the same way (ARCHITECTURE §8.2). Specs launch with
// launchApp() -- a throwaway mkdtemp profile -- and never a real one.

/**
 * Keep app-level notices that are not about Draw from swallowing clicks.
 *
 * The local-AI "needs a one-time download" status card is fixed over the top
 * centre of the window, which is exactly where the Draw menus drop down, and it
 * has no dismiss control. On a throwaway test profile it appears whenever the
 * app first asks local AI anything. When it blocks an action it is hidden for
 * the rest of the run (display only; nothing is clicked or changed).
 */
export async function keepNoticesOutOfTheWay(window: Page): Promise<void> {
  // On a fresh profile the one-time "local AI is built in" card (local-ai-intro,
  // bottom centre) swallows clicks on the canvas: dismiss it the way the app's
  // own close button does, and close it if it appears later anyway.
  await chooseCloudAiSource(window)
  await window.addLocatorHandler(
    window.locator('[data-testid="local-ai-intro"]'),
    async () => {
      await window.locator('[data-testid="local-ai-intro-dismiss"]').click({ timeout: 4_000 }).catch(() => undefined)
    },
    { noWaitAfter: true }
  )
  await window.addLocatorHandler(
    window.locator('[data-testid="local-ai-missing"]'),
    async (card) => {
      await card.evaluate((el) => ((el as HTMLElement).style.display = 'none'))
    },
    { noWaitAfter: true }
  )
}

/** Open a fresh artwork from the PlexiiOffice area. */
export async function openDrawStudio(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-app-draw"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-draw"]').click()
  await expect(window.locator('[data-testid="draw-studio"]')).toBeVisible({ timeout: 10_000 })
}

/** Store a drawing with exactly this body (no editor involved) and return its id. */
export async function seedDrawDoc(window: Page, body: unknown, title = 'Seeded artwork'): Promise<string> {
  return window.evaluate(
    async ({ b, t }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const doc = await api.documents.create({ docType: 'draw', title: t, body: b as never })
      return doc.id
    },
    { b: body, t: title }
  )
}

/** Open a stored document in the editor view. */
export async function openDocument(window: Page, id: string): Promise<void> {
  await window.evaluate((docId) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    w.__fbView?.getState().goDocument(docId)
  }, id)
  await expect(window.locator('[data-testid="draw-studio"]')).toBeVisible({ timeout: 10_000 })
}

/** The document exactly as the main process has it stored: body JSON text and timestamp. */
export async function readStored(window: Page, id: string): Promise<{ body: string; updatedAt: number; raw: unknown }> {
  return window.evaluate(async (docId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const doc = await api.documents.get(docId)
    return { body: JSON.stringify(doc?.body ?? null), updatedAt: doc?.updatedAt ?? 0, raw: doc?.body ?? null }
  }, id)
}

/** Wait out the editor's debounced save (600 ms) with margin. */
export async function waitForSave(window: Page): Promise<void> {
  await window.waitForTimeout(1_200)
}

/** Drag on the artboard in stage (screen) coordinates, which is how every tool is used. */
export async function dragOnStage(window: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const stage = window.locator('[data-testid="draw-stage"]')
  const box = await stage.boundingBox()
  if (!box) throw new Error('the artboard stage was not laid out')
  // The stage is fitted to the window, so offsets are clamped into it;
  // otherwise a drag meant for the canvas lands on the chrome outside it.
  const cx = (v: number): number => box.x + Math.max(2, Math.min(box.width - 2, v))
  const cy = (v: number): number => box.y + Math.max(2, Math.min(box.height - 2, v))
  await window.mouse.move(cx(from.x), cy(from.y))
  await window.mouse.down()
  // Intermediate moves matter: a single jump can be coalesced away.
  await window.mouse.move(cx((from.x + to.x) / 2), cy((from.y + to.y) / 2))
  await window.mouse.move(cx(to.x), cy(to.y))
  await window.mouse.up()
}

/** Screen position of an ARTBOARD point, from the stage's on-screen box and the artboard width. */
export async function stagePoint(window: Page, artboardWidth: number, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await window.locator('[data-testid="draw-stage"]').boundingBox()
  if (!box) throw new Error('the artboard stage was not laid out')
  const k = box.width / artboardWidth
  return { x: box.x + p.x * k, y: box.y + p.y * k }
}

/** Run a menu item by its menu id and visible label (e.g. 'edit', 'Select all'). */
export async function runMenu(window: Page, menuId: string, label: string): Promise<void> {
  await window.locator(`[data-testid="draw-studio-menubar-${menuId}"]`).click()
  // Items carry an icon ligature in their text, so match on the label text.
  await window.locator(`[data-testid="draw-studio-menubar-${menuId}-list"] button`).filter({ hasText: label }).first().click()
}

/** A minimal stored v1 body with one vector layer holding `objects`. */
export function v1Body(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    width: 800,
    height: 600,
    background: { type: 'solid', color: '#ffffff' },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    ...extra
  }
}

/** A closed rectangle path object. */
export function rectObject(id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'path',
    shapeKind: 'rect',
    path: { subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] },
    fill: { type: 'solid', color: '#6d5dfc' },
    ...extra
  }
}

/**
 * A stored drawing read the same way whatever format it was saved in. Since
 * 4.3.39-local.8 drawings save as v2 (artboards, an asset store) once edited;
 * specs written against v1 bodies read the size and pictures through this:
 * `width`/`height` are the first artboard's, and every image object and paint
 * layer gets a `src` with its picture's data URL.
 */
export function storedView<T = Record<string, unknown>>(raw: unknown): T & { width: number; height: number; schemaVersion: number } {
  const r = raw as {
    schemaVersion?: number
    width?: number
    height?: number
    artboards?: Array<{ w: number; h: number }>
    assets?: Record<string, { dataUrl: string }>
    layers?: Array<Record<string, unknown>>
  }
  if (!r.artboards) return { ...(r as object), schemaVersion: r.schemaVersion ?? 1 } as T & { width: number; height: number; schemaVersion: number }
  const assets = r.assets ?? {}
  const withSrc = (n: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...n }
    if (n.type === 'image' && typeof n.assetId === 'string' && assets[n.assetId]) out.src = assets[n.assetId].dataUrl
    if (Array.isArray(n.children)) out.children = (n.children as Array<Record<string, unknown>>).map(withSrc)
    return out
  }
  const layers = (r.layers ?? []).map((l) => {
    const out: Record<string, unknown> = { ...l }
    if (l.kind === 'raster' && typeof l.assetId === 'string' && assets[l.assetId]) out.src = assets[l.assetId].dataUrl
    if (Array.isArray(l.objects)) out.objects = (l.objects as Array<Record<string, unknown>>).map(withSrc)
    return out
  })
  return { ...(r as object), layers, width: r.artboards[0].w, height: r.artboards[0].h, schemaVersion: r.schemaVersion ?? 2 } as T & { width: number; height: number; schemaVersion: number }
}
