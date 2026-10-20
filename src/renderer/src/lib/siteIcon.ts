import { useEffect, useState } from 'react'

// Icons for links and connected apps, from the linked site itself.
//
// The main process (src/main/siteIcons.ts) asks the linked site for its
// favicon, or its page's declared icon, caches it in userData and hands back a
// data: URL. Nothing goes to a third-party icon service: until 4.3.34 these came
// from Google's favicon service, which saw the hostname of every linked site.
//
// `network: false` is for sites the person did not choose themselves (web
// search results in a chat answer): a cached icon if they linked that site
// before, otherwise null, and the caller draws its neutral glyph.

const memo = new Map<string, Promise<string | null>>()

function key(url: string, network: boolean): string {
  return `${network ? 'n' : 'c'}:${url}`
}

export function fetchSiteIcon(url: string, network = true): Promise<string | null> {
  const k = key(url, network)
  const hit = memo.get(k)
  if (hit) return hit
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    | { siteIcon?: { get: (u: string, n: boolean) => Promise<string | null> } }
    | undefined
  const p = api?.siteIcon
    ? api.siteIcon.get(url, network).catch(() => null)
    : Promise.resolve(null)
  memo.set(k, p)
  // A failure is not memoised for the session: the main process remembers it
  // (for a week), and a later render may find the icon cached by another call.
  void p.then((v) => {
    if (v === null) memo.delete(k)
  })
  return p
}

/**
 * The icon for `url` as a data: URL once it has loaded; null while loading and
 * when the site has none (draw the neutral glyph).
 */
export function useSiteIcon(url: string | null | undefined, network = true): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (!url) return
    let live = true
    void fetchSiteIcon(url, network).then((v) => {
      if (live) setSrc(v)
    })
    return () => {
      live = false
    }
  }, [url, network])
  return src
}

/** Test seam. */
export function __resetSiteIconMemo(): void {
  memo.clear()
}
