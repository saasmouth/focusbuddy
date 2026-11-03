// What the sender chose about how a link presents their desk, remembered per
// desk on this computer, and turned into the request the main process packs.
//
// Per desk, not per link: every link to a desk shows the same desk, and "Update
// link" must re-send what the sender chose last time without asking again. It
// lives in localStorage beside the desk's other viewing preferences (the view it
// opens in, its Columns setup), which are this computer's too.
import {
  isShareView,
  isSiteChoice,
  type SharePresentationRequest,
  type ShareView,
  type SiteChoice,
  type SiteShow
} from '@shared/sitePresentation'
import { DESK_COLUMNS_KEY_PREFIX } from '../../lib/deskLocalPrefs'

export interface PresentationChoices {
  view: ShareView
  /** "Only this view": visitors cannot switch. */
  lockView: boolean
  /** Widget id -> choice; a site not named is 'auto'. */
  sites: Record<string, SiteChoice>
}

const KEY_PREFIX = 'fb.sharePresentation.v1.'

/** The view a new link opens in when the sender has not chosen: the one they are using now. */
export function defaultShareView(current: string | null | undefined): ShareView {
  return isShareView(current) ? current : 'canvas'
}

export function loadChoices(deskId: string, currentView: string | null | undefined): PresentationChoices {
  const fallback: PresentationChoices = { view: defaultShareView(currentView), lockView: true, sites: {} }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_PREFIX + deskId) ?? 'null') as Partial<PresentationChoices> | null
    if (!raw || typeof raw !== 'object') return fallback
    const sites: Record<string, SiteChoice> = {}
    if (raw.sites && typeof raw.sites === 'object') {
      for (const [k, v] of Object.entries(raw.sites)) if (isSiteChoice(v) && v !== 'auto') sites[k] = v
    }
    return {
      view: isShareView(raw.view) ? raw.view : fallback.view,
      lockView: typeof raw.lockView === 'boolean' ? raw.lockView : fallback.lockView,
      sites
    }
  } catch {
    return fallback
  }
}

export function saveChoices(deskId: string, c: PresentationChoices): void {
  try {
    const sites: Record<string, SiteChoice> = {}
    for (const [k, v] of Object.entries(c.sites)) if (v !== 'auto') sites[k] = v
    localStorage.setItem(KEY_PREFIX + deskId, JSON.stringify({ view: c.view, lockView: c.lockView, sites }))
  } catch {
    /* private mode: the choices last for this sheet */
  }
}

/** The sender's own Columns setup for this desk, when they have one. */
function storedColumns(deskId: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(DESK_COLUMNS_KEY_PREFIX + deskId) ?? 'null') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function originOf(url: string): string {
  try {
    return url ? new URL(url).origin : ''
  } catch {
    return ''
  }
}

/**
 * What the main process needs to pack a link the way the sender chose.
 *
 *   kind 'folder'  a room: no view (it opens on its first desk), websites only
 *   layoutUserId   whose layouts on this computer are the sender's -- the
 *                  account id, or 'local' signed out, exactly as the renderer
 *                  keys them (stores/widgets.ts)
 *   embedderOrigin where links open, for checking which sites may be framed there
 */
export function presentationRequest(
  kind: 'folder' | 'task',
  deskId: string,
  c: PresentationChoices,
  ctx: { accountId: string | null; cloudAppUrl: string }
): SharePresentationRequest {
  const req: SharePresentationRequest = {
    sites: { ...c.sites },
    embedderOrigin: originOf(ctx.cloudAppUrl),
    layoutUserId: ctx.accountId ?? 'local'
  }
  if (kind === 'task') {
    req.view = c.view
    if (c.lockView) req.lockView = true
    const columns = storedColumns(deskId)
    if (columns) req.columns = columns
  }
  return req
}

/** How a site will show, in a few words for the sheet. */
export function showLabel(show: SiteShow, provider: string | null): string {
  if (show === 'embed') return provider ? `Live · ${provider}'s own player` : 'Live'
  if (show === 'live') return 'Live'
  if (show === 'picture') return 'Picture'
  return 'Link only'
}

/** What a choice comes to for a site with these options (the same rule as sitePreviewCore.decideShow). */
export function shownFor(choice: SiteChoice, options: SiteShow[]): SiteShow {
  if (choice === 'link') return 'link'
  if (choice === 'picture') return options.includes('picture') ? 'picture' : 'link'
  return options[0] ?? 'link'
}

/** Which of choiceOptions is in effect: what the choice actually comes to. */
export function selectedChoice(choice: SiteChoice, options: SiteShow[]): SiteChoice {
  const s = shownFor(choice, options)
  return s === 'embed' || s === 'live' ? 'live' : s
}

/** A line saying how the link presents the desk, for the update confirmation. */
export function presentationSummary(
  kind: 'folder' | 'task',
  c: PresentationChoices,
  sites: Array<{ widgetId: string; options: SiteShow[] | null }>
): string {
  const parts: string[] = []
  if (kind === 'task') {
    const label = c.view === 'workcentre' ? 'Workcentre' : c.view === 'columns' ? 'Columns' : 'Canvas'
    parts.push(c.lockView ? `Opens in ${label} only` : `Opens in ${label}`)
  }
  const counts = { live: 0, picture: 0, link: 0 }
  for (const s of sites) {
    if (!s.options) continue
    const shown = shownFor(c.sites[s.widgetId] ?? 'auto', s.options)
    counts[shown === 'embed' ? 'live' : shown]++
  }
  const bits: string[] = []
  if (counts.live) bits.push(`${counts.live} live`)
  if (counts.picture) bits.push(`${counts.picture} as pictures`)
  if (counts.link) bits.push(`${counts.link} as links`)
  if (bits.length) parts.push(`websites ${bits.join(', ')}`)
  return parts.length ? `${parts.join('; ')}.` : ''
}

/** The choices the sheet offers for a site with these options, best first. */
export function choiceOptions(options: SiteShow[]): Array<{ choice: SiteChoice; label: string }> {
  const out: Array<{ choice: SiteChoice; label: string }> = []
  if (options.includes('embed') || options.includes('live')) out.push({ choice: 'live', label: 'Live' })
  if (options.includes('picture')) out.push({ choice: 'picture', label: 'Picture' })
  out.push({ choice: 'link', label: 'Link only' })
  return out
}

/** The websites a link went out without a picture for, said plainly. Empty when none. */
export function describeSitesOmitted(notes: Array<{ host: string; why: string }> | undefined): string {
  if (!notes?.length) return ''
  return `Shown as a link instead of a picture: ${notes.map((n) => n.why.replace(/\.$/, '')).join('; ')}.`
}
