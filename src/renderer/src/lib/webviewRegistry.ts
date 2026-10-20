interface Entry {
  widgetId: string
  el: HTMLElement
}

const byContentsId = new Map<number, Entry>()

// Main builds the right-click menu natively (webContextMenu.ts); it needs to
// know which webviews are browser work widgets on a desk, so the desk's own
// actions are offered there and nowhere else.
function tellMain(webContentsId: number, surface: 'desk' | null): void {
  try {
    void (window as unknown as { api?: { webMenu?: { setSurface: (id: number, s: 'desk' | null) => Promise<unknown> } } }).api?.webMenu?.setSurface(webContentsId, surface)
  } catch {
    /* no preload (tests): main falls back to the browser menu */
  }
}

export function registerWebview(webContentsId: number, widgetId: string, el: HTMLElement): void {
  byContentsId.set(webContentsId, { widgetId, el })
  tellMain(webContentsId, 'desk')
}

export function unregisterWebviewByContentsId(webContentsId: number): void {
  if (byContentsId.delete(webContentsId)) tellMain(webContentsId, null)
}

export function unregisterWebviewByWidgetId(widgetId: string): void {
  for (const [id, entry] of byContentsId) {
    if (entry.widgetId === widgetId) {
      byContentsId.delete(id)
      tellMain(id, null)
    }
  }
}

export function lookupWebview(webContentsId: number): Entry | null {
  return byContentsId.get(webContentsId) ?? null
}

function elByWidgetId(widgetId: string): HTMLElement | null {
  for (const entry of byContentsId.values()) {
    if (entry.widgetId === widgetId) return entry.el
  }
  return null
}

// The webContents id of a mounted browser widget, so the main process can DRIVE
// it (read / navigate / search) when an agent is wired to it.
export function getWebContentsId(widgetId: string): number | null {
  for (const [cid, entry] of byContentsId) {
    if (entry.widgetId === widgetId) return cid
  }
  return null
}

// Extract the LIVE, rendered, authenticated text of a mounted browser widget by
// running document.body.innerText inside its <webview>. This is what lets a desk
// agent (or a transform wire) actually read a page the user is logged into —
// far better than a blind, unauthenticated server-side fetch of the URL. Returns
// null when the webview isn't mounted / ready, so callers can fall back to the
// fetch path.
export async function extractWebviewText(widgetId: string): Promise<string | null> {
  const el = elByWidgetId(widgetId)
  if (!el) return null
  try {
    const text = await (
      el as unknown as { executeJavaScript: (s: string) => Promise<unknown> }
    ).executeJavaScript('document.body ? document.body.innerText : ""')
    return typeof text === 'string' && text.trim() ? text.slice(0, 12000) : null
  } catch {
    return null
  }
}
