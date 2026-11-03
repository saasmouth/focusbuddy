// A clean visit to a website, for a shared desk: does the site allow being
// framed, and what does it look like to someone who is not signed in?
//
// The visit happens in a hidden window whose session is in memory only and new
// every time (sitePreviewLoader.ts), so nothing of the sender's accounts can
// appear in a picture: a signed-in ChatGPT, a TradingView layout, a mail inbox
// all show as their signed-out front pages.
//
// What to do with what it saw is sitePreviewCore.ts; what a visitor then sees is
// shared/sitePresentation.ts and EmbeddedSiteWidget.
import { nativeImage } from 'electron'
import { electronPageLoader } from './sitePreviewLoader'
import { getDb } from './db/database'
import { deskSubtreeIds, type PresentationInput, type PresentationSiteInput } from './db/deskBundle'
import {
  createSitePreviewer,
  availableShows,
  decideShow,
  hostOf,
  viewportFor,
  type SiteCheck
} from './sitePreviewCore'
import {
  isShareView,
  isSiteChoice,
  isWebsiteWidget,
  officialEmbedFor,
  type SharePresentationRequest,
  type SiteShow
} from '@shared/sitePresentation'
import { toHttpUrl } from '@shared/safeUrl'

export const sitePreviewer = createSitePreviewer(electronPageLoader, { concurrency: 3 })

interface WidgetRow {
  id: string
  kind: string
  content: string | null
  width: number | null
  height: number | null
  title: string | null
}

function widgetRow(id: string): WidgetRow | null {
  const row = (getDb() as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } })
    .prepare('SELECT id, kind, content, width, height, title FROM widgets WHERE id = ? AND trashed_at IS NULL')
    .get(id) as WidgetRow | undefined
  return row ?? null
}

/** The website widgets on a desk and everything filed under it, in reading order. */
export function deskWebsiteWidgets(deskId: string): WidgetRow[] {
  const ids = deskSubtreeIds(deskId)
  if (!ids.length) return []
  const db = getDb() as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } }
  const out: WidgetRow[] = []
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400)
    out.push(
      ...(db
        .prepare(
          `SELECT id, kind, content, width, height, title FROM widgets
           WHERE task_id IN (${slice.map(() => '?').join(', ')}) AND trashed_at IS NULL
           ORDER BY y, x`
        )
        .all(...slice) as WidgetRow[])
    )
  }
  return out.filter((w) => isWebsiteWidget(w))
}

/** The websites a desk's link would carry, for the share sheet to list. */
export function listDeskSites(deskId: string): Array<{ widgetId: string; url: string; host: string; title: string }> {
  return deskWebsiteWidgets(String(deskId ?? '')).map((w) => {
    const url = toHttpUrl((w.content ?? '').trim())!.href
    return { widgetId: w.id, url, host: hostOf(url), title: (w.title ?? '').trim() }
  })
}

/** What the share sheet shows for one site. */
export type SitePreviewResult =
  | {
      ok: true
      widgetId: string
      url: string
      host: string
      /** What this site can be shown as, best first. */
      options: SiteShow[]
      /** What 'auto' comes to. */
      recommended: SiteShow
      provider: string | null
      /** A small JPEG data URL of the picture, for the sheet. */
      thumbnail: string | null
      refusal: string | null
      checkedAt: number
    }
  | { ok: false; widgetId: string; error: string }

function thumbnail(check: SiteCheck): string | null {
  if (!check.picture) return null
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(check.picture.bytes))
    const small = img.resize({ width: 480, quality: 'good' }).toJPEG(70)
    return `data:image/jpeg;base64,${small.toString('base64')}`
  } catch {
    return null
  }
}

/** Visit (or recall) one website widget for the share sheet. */
export async function prepareSitePreview(
  widgetId: string,
  embedderOrigin: string,
  force = false
): Promise<SitePreviewResult> {
  const w = widgetRow(String(widgetId ?? ''))
  if (!w || !isWebsiteWidget(w)) return { ok: false, widgetId, error: 'That work widget is not a website.' }
  const url = toHttpUrl((w.content ?? '').trim())!.href
  const check = await sitePreviewer.check(url, viewportFor(w.width, w.height), String(embedderOrigin ?? ''), { force })
  return {
    ok: true,
    widgetId: w.id,
    url,
    host: check.host,
    options: availableShows(check),
    recommended: decideShow('auto', check),
    provider: check.embed?.provider ?? null,
    thumbnail: thumbnail(check),
    refusal: check.refusal,
    checkedAt: check.checkedAt
  }
}

/** A site that went out as a link card although the sender's choice allowed more, and why. */
export interface SiteNote {
  widgetId: string
  host: string
  why: string
}

const MAX_COLUMNS_JSON = 64 * 1024

/**
 * Turn the share sheet's choices into what buildDeskBundle packs.
 *
 * A site whose official embed answers the choice needs no visit. Every other
 * site that may show more than a link card is checked -- from the cache when the
 * sheet already previewed it, which is the normal case, otherwise visited now.
 */
export async function resolvePresentation(
  deskId: string,
  req: SharePresentationRequest | null | undefined
): Promise<{ input: PresentationInput; notes: SiteNote[] }> {
  const r = req && typeof req === 'object' ? req : {}
  const input: PresentationInput = {}
  if (isShareView(r.view)) input.view = r.view
  if (input.view && r.lockView === true) input.lockView = true
  if (r.columns && typeof r.columns === 'object' && !Array.isArray(r.columns)) {
    try {
      if (JSON.stringify(r.columns).length <= MAX_COLUMNS_JSON) input.columns = r.columns
    } catch {
      /* dropped */
    }
  }
  if (typeof r.layoutUserId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(r.layoutUserId)) {
    input.layoutUserId = r.layoutUserId
  }
  const origin = typeof r.embedderOrigin === 'string' ? r.embedderOrigin : ''
  const choices = r.sites && typeof r.sites === 'object' ? r.sites : {}
  const notes: SiteNote[] = []
  const sites: Record<string, PresentationSiteInput> = {}
  await Promise.all(
    deskWebsiteWidgets(deskId).map(async (w) => {
      const url = toHttpUrl((w.content ?? '').trim())!.href
      const raw = (choices as Record<string, unknown>)[w.id]
      const choice = isSiteChoice(raw) ? raw : 'auto'
      if (choice === 'link') {
        sites[w.id] = { url, show: 'link' }
        return
      }
      if (choice !== 'picture' && officialEmbedFor(url)) {
        sites[w.id] = { url, show: 'embed' }
        return
      }
      const check = await sitePreviewer.check(url, viewportFor(w.width, w.height), origin)
      const show = decideShow(choice, check)
      if (show === 'picture' && check.picture) {
        sites[w.id] = { url, show, picture: check.picture }
      } else {
        sites[w.id] = { url, show }
        if (show === 'link' && check.refusal) notes.push({ widgetId: w.id, host: hostOf(url), why: check.refusal })
      }
    })
  )
  if (Object.keys(sites).length) input.sites = sites
  return { input, notes }
}
