// Drives the BUILT widget host the way PlexiiLite does: the page is top-level
// (a <webview>), and its embedder talks to it through window 'message' events
// -- PlexiiLite's preload relays them; here the test plays that part with
// window.postMessage in the page. Every host->embedder message is recorded.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

export const FIXTURES = join(__dirname, 'fixtures')
export const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

export interface HostMsg { type: string; protocol?: number; [k: string]: unknown }

const HOST_TO_LITE = ['ready', 'loaded', 'save', 'error', 'flushed', 'open-link'].map((t) => `plexii-widget-host:${t}`)

export async function openHost(page: Page, query = ''): Promise<void> {
  await page.addInitScript((types: string[]) => {
    const out: unknown[] = []
    ;(window as unknown as { __hostOut: unknown[] }).__hostOut = out
    window.addEventListener('message', (e) => {
      const d = e.data as { type?: string } | null
      if (d && typeof d.type === 'string' && types.includes(d.type)) out.push(d)
    })
  }, HOST_TO_LITE)
  await page.goto(`/index.html${query}`)
  await expect.poll(() => messages(page).then((m) => m.map((x) => x.type))).toContain('plexii-widget-host:ready')
}

export const messages = (page: Page): Promise<HostMsg[]> => page.evaluate(() => (window as unknown as { __hostOut: HostMsg[] }).__hostOut)
export const ofType = async (page: Page, t: string): Promise<HostMsg[]> => (await messages(page)).filter((m) => m.type === `plexii-widget-host:${t}`)

export async function load(page: Page, text: string, readOnly?: boolean): Promise<void> {
  await page.evaluate(([t, r]) => window.postMessage({ type: 'plexii-widget-host:load', text: t, ...(r === undefined ? {} : { readOnly: r }) }, '*'), [text, readOnly] as const)
}

export async function loaded(page: Page): Promise<HostMsg> {
  await expect.poll(async () => (await ofType(page, 'loaded')).length + (await ofType(page, 'error')).length).toBeGreaterThan(0)
  const errs = await ofType(page, 'error')
  if (errs.length) throw new Error(`host error: ${JSON.stringify(errs[0])}`)
  return (await ofType(page, 'loaded'))[0]!
}

export async function flush(page: Page): Promise<void> {
  const before = (await ofType(page, 'flushed')).length
  await page.evaluate(() => window.postMessage({ type: 'plexii-widget-host:flush' }, '*'))
  await expect.poll(async () => (await ofType(page, 'flushed')).length).toBe(before + 1)
}

/** The page's widget box, once something is drawn in it. */
export async function drawn(page: Page): Promise<void> {
  await expect(page.locator('#root[data-widget-host="shown"] .plexii-widget-host-box')).toBeVisible()
  await expect.poll(() => page.locator('.plexii-widget-host-box').evaluate((el) => el.querySelectorAll('*').length)).toBeGreaterThan(3)
}

/** Visible AI affordances: Plexii's AI icon, or controls that offer AI or the assistant. */
export async function aiAffordances(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const s = getComputedStyle(el as HTMLElement)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
    }
    const found: string[] = []
    for (const el of document.querySelectorAll('.material-symbols-outlined, [class*="material-symbols"]')) {
      if (/auto_awesome|smart_toy|robot_2|neurology/.test(el.textContent ?? '') && visible(el)) found.push(`icon ${el.textContent} in <${(el.closest('button,[role=button],a') ?? el).tagName.toLowerCase()} aria-label="${(el.closest('button,[role=button],a') as HTMLElement | null)?.getAttribute('aria-label') ?? ''}">`)
    }
    for (const el of document.querySelectorAll('button,[role=button],[role=menuitem],a')) {
      const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`
      if (/\bAI\b|assistant|Ask Plexii|Set up with|Build with|Expand with/i.test(t) && visible(el)) found.push(`control "${t.trim().replace(/\s+/g, ' ').slice(0, 60)}"`)
    }
    return found
  })
}

/** Desk chrome that has no meaning in a file's tile: a title bar, resize handles, the drag handle. */
export async function deskChrome(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = []
    for (const sel of ['[data-widget-header]', '.react-resizable-handle', '[class*="resizeHandle"]', '.widget-drag-handle', '[data-resize-handle]']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width > 0 && r.height > 0) found.push(sel)
      }
    }
    // react-rnd's handles are bare divs with resize cursors at the frame's
    // edges, OUTSIDE the widget body. A splitter inside an editor (the Design
    // app's panels) is the widget's own control, not desk chrome.
    for (const el of document.querySelectorAll('div')) {
      if (el.closest('[data-widget-body]')) continue
      const c = getComputedStyle(el).cursor
      if (/(nw|ne|sw|se|n|s|e|w|ew|ns|nesw|nwse)-resize/.test(c)) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) found.push(`resize cursor (${c})`)
      }
    }
    return [...new Set(found)]
  })
}

/** A sticky's text box, opening it for editing as a click on its text does. */
export async function stickyText(page: Page, shown: string): Promise<import('@playwright/test').Locator> {
  const area = page.locator('.plexii-widget-host-box textarea')
  if (!(await area.count())) await page.locator('.plexii-widget-host-box').getByText(shown, { exact: true }).click()
  await expect(area).toBeVisible()
  return area
}
