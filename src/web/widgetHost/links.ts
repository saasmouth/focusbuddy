// Links in the widget host open in the person's browser, through PlexiiLite.
//
// The host is a <webview>: a link that navigated it would replace the widget
// with a web page and lose any edit not yet saved; window.open would ask for a
// window nobody handles; and window.api.files.openExternal (the map's "Open in
// OpenStreetMap") reaches a channel this runtime does not serve, so the button
// would be dead. All three become one message, open-link, which PlexiiLite
// opens outside. Only http(s) and mailto: anything else opens nothing.
import { HOST_TYPES, hostMessage, type HostMessage } from './protocol'

export function openable(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? ''))
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.href : null
  } catch {
    return null
  }
}

export function routeLinks(post: (m: HostMessage) => void, win: Window = window): () => void {
  const open = (raw: unknown): void => {
    const url = openable(raw)
    if (url) post(hostMessage({ type: HOST_TYPES.openLink, url }))
  }
  const realOpen = win.open
  win.open = ((url?: string | URL) => {
    open(url)
    return null
  }) as typeof win.open

  const onClick = (e: MouseEvent): void => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) return
    e.preventDefault()
    open(a.href)
  }
  win.document.addEventListener('click', onClick, true)

  // The api's own ways out, where the desktop opens a URL in the browser.
  const api = (win as unknown as { api?: Record<string, Record<string, unknown>> }).api
  if (api?.files) api.files.openExternal = async (url: unknown) => void open(url)

  return () => {
    win.open = realOpen
    win.document.removeEventListener('click', onClick, true)
  }
}
