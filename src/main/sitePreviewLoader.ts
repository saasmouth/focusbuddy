// The clean, hidden visit itself -- see sitePreview.ts for what it is for.
// Apart from sitePreview.ts so it can be driven on its own (no database), as
// scripts/verify-site-pictures.mjs does against pages with known headers.
//
// Two looks, in one hidden window. First the site is framed exactly as the share
// page frames it; if the browser displays it, it can be shown live and the
// picture is of that. If it refuses, the site is visited on its own for the
// picture.
//
// The window is hidden, its session is in memory only and new for every visit
// (no cookies, storage, cache or browser extensions -- extensions load only into
// the app's named browser partitions), so nothing of the sender's accounts can
// appear in a picture. It cannot download, open windows, ask for permissions or
// play sound, and it is destroyed after one picture.
import { BrowserWindow, session } from 'electron'
import { cleanWebviewUserAgent } from './userAgent'
import { framedVerdict, type PageLoader, type PageShot } from './sitePreviewCore'
import { EMBED_REFERRER_POLICY, EMBED_SANDBOX, MAX_SITE_PICTURE_BYTES, SITE_PICTURE_WIDTH } from '@shared/sitePresentation'

/** Longest a page gets to load. Ad-heavy pages often never finish; the picture is taken anyway. */
const LOAD_TIMEOUT_MS = 15_000
/** After load, time for late layout (fonts, client rendering, consent banners settling). */
const SETTLE_MS = 2_500
/** Longest the framed page's title may take to read. */
const TITLE_TIMEOUT_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Encode under the size a link can afford, stepping quality down for a busy page. */
function encode(img: Electron.NativeImage): { jpeg: Uint8Array; width: number; height: number } | null {
  if (img.isEmpty()) return null
  const size = img.getSize()
  const scaled = size.width > SITE_PICTURE_WIDTH ? img.resize({ width: SITE_PICTURE_WIDTH, quality: 'good' }) : img
  const out = scaled.getSize()
  for (const q of [72, 62, 52, 42]) {
    const jpeg = scaled.toJPEG(q)
    if (jpeg.byteLength <= MAX_SITE_PICTURE_BYTES) return { jpeg: new Uint8Array(jpeg), width: out.width, height: out.height }
  }
  return null
}

const attr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * A page that frames `url` exactly as the share page does: full size, the same
 * sandbox, the same referrer policy (EmbeddedSiteWidget).
 */
function framingPage(url: string): string {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;overflow:hidden">' +
    `<iframe src="${attr(url)}" sandbox="${EMBED_SANDBOX}" referrerpolicy="${EMBED_REFERRER_POLICY}" ` +
    'style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>'
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Load, but give up waiting after LOAD_TIMEOUT_MS. Resolves with why it did not finish, if it did not. */
async function loadWithin(wc: Electron.WebContents, url: string, stop?: Promise<void>): Promise<string | undefined> {
  try {
    await Promise.race([
      wc.loadURL(url),
      sleep(LOAD_TIMEOUT_MS).then(() => {
        throw new Error('timed out')
      }),
      ...(stop ? [stop] : [])
    ])
    return undefined
  } catch (e) {
    // A client-side redirect aborts the first load (ERR_ABORTED) and a page
    // full of ads may never finish: both are still worth a picture. Only a
    // load that produced no response at all is a failure, judged by the caller.
    return (e as Error).message.replace(/^.*?(ERR_[A-Z_]+).*$/s, '$1')
  }
}

let visits = 0

type Answer = { status: number; headers: Record<string, string | string[]>; url: string }

export const electronPageLoader: PageLoader = {
  async shoot(url, viewport, embedderOrigin = ''): Promise<PageShot> {
    // No "persist:" prefix: an in-memory session, new for this visit.
    const partition = `share-picture-${process.pid}-${Date.now()}-${++visits}`
    const ses = session.fromPartition(partition, { cache: false })
    ses.setUserAgent(cleanWebviewUserAgent(ses.getUserAgent()))
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (e) => e.preventDefault())

    // The framed document's own chain of addresses (its redirects included), so
    // the frames inside it -- ads, trackers -- are told apart from it.
    const chain = new Set<string>([url])
    let framed: Answer | null = null
    let main: Answer | null = null
    const referrer = embedderOrigin ? `${embedderOrigin.replace(/\/+$/, '')}/` : ''
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      // The share page sends its origin as the referrer (strict-origin); a page
      // framed from a data: URL would send none. Some sites refuse frames by
      // referrer, so the test sends what a visitor's browser would.
      if (details.resourceType === 'subFrame' && referrer && chain.has(details.url)) {
        cb({ requestHeaders: { ...details.requestHeaders, Referer: referrer } })
        return
      }
      cb({})
    })
    ses.webRequest.onBeforeRedirect((details) => {
      if (details.resourceType === 'subFrame' && chain.has(details.url)) chain.add(details.redirectURL)
    })
    ses.webRequest.onHeadersReceived((details, cb) => {
      const answer = { status: details.statusCode, headers: details.responseHeaders ?? {}, url: details.url }
      if (details.resourceType === 'subFrame' && chain.has(details.url)) framed = answer
      else if (details.resourceType === 'mainFrame' && /^https?:/i.test(details.url)) main = answer
      cb({})
    })

    const win = new BrowserWindow({
      show: false,
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      skipTaskbar: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        autoplayPolicy: 'user-gesture-required'
      }
    })
    const wc = win.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const webOnly = (e: Electron.Event, target: string): void => {
      if (!/^(https?|data):/i.test(target)) e.preventDefault()
    }
    wc.on('will-navigate', webOnly)
    wc.on('will-redirect', webOnly)

    // The browser says so in the console when it refuses to display a frame.
    let refused = false
    let onRefused: () => void = () => undefined
    const refusal = new Promise<void>((r) => (onRefused = r))
    wc.on('console-message', (...args: unknown[]) => {
      const first = args[0] as { message?: string } | undefined
      const message = String(first?.message ?? args[2] ?? '')
      if (/Refused to display .* in a frame|violates the following Content Security Policy directive: "frame-ancestors/i.test(message)) {
        refused = true
        onRefused()
      }
    })

    try {
      // 1. Framed, as the share page will frame it. A refusal ends the wait.
      const framedError = await loadWithin(wc, framingPage(url), refusal)
      if (!refused) await Promise.race([sleep(SETTLE_MS), refusal])
      const f = framed as Answer | null
      const frame = { status: f ? f.status : null, headers: f ? f.headers : {}, refused }
      if (!win.isDestroyed() && framedVerdict(frame, embedderOrigin) === 'allowed') {
        // It shows. The picture is what a visitor will see live.
        const child = wc.mainFrame.frames[0]
        const title = child
          ? await Promise.race([child.executeJavaScript('document.title').then(String).catch(() => ''), sleep(TITLE_TIMEOUT_MS).then(() => '')])
          : ''
        const picture = encode(await wc.capturePage())
        return {
          status: frame.status,
          headers: frame.headers,
          finalUrl: child?.url || f?.url || url,
          title,
          jpeg: picture?.jpeg ?? null,
          width: picture?.width ?? 0,
          height: picture?.height ?? 0,
          error: f ? undefined : framedError ?? 'no response',
          frame
        }
      }

      // 2. Refused: an ordinary visit, for the picture.
      const error = await loadWithin(wc, url)
      await sleep(SETTLE_MS)
      const got = main as Answer | null
      const picture = !win.isDestroyed() && got ? encode(await wc.capturePage()) : null
      return {
        status: got ? got.status : null,
        headers: got ? got.headers : {},
        finalUrl: wc.getURL() || got?.url || url,
        title: wc.getTitle() || '',
        jpeg: picture?.jpeg ?? null,
        width: picture?.width ?? 0,
        height: picture?.height ?? 0,
        error: got ? undefined : error ?? 'no response',
        frame
      }
    } finally {
      if (!win.isDestroyed()) win.destroy()
      void ses.clearStorageData().catch(() => undefined)
      void ses.clearCache().catch(() => undefined)
    }
  }
}

