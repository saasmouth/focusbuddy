// Desk pop-ups — the pure half.
//
// A web pop-up (a sign-in window, a scripted `window.open` with features, a
// named handle) used to open as a separate OS window. It now opens ON THE DESK:
// main hosts the pop-up's own webContents in a WebContentsView attached to the
// main window, and the renderer draws the card around it. The webContents is
// the one Electron created for the `window.open` call, so `window.opener`,
// `postMessage` and `window.close()` behave exactly as in a real window — that
// is what keeps OAuth / SSO hand-offs working.
//
// Everything here is pure so the unit suite can pin it: the geometry that turns
// a renderer rect into native view bounds, the card layout, and the small rules
// (when is a hand-off finished, which pop-ups may navigate where, is the native
// fallback on).

/** A rectangle in the renderer's CSS pixels, viewport-relative. */
export interface PopupRect {
  x: number
  y: number
  width: number
  height: number
}

/** What the renderer needs to draw a card. */
export interface DeskPopupInfo {
  id: string
  url: string
  title: string
  /** Preferred content size in CSS px, from the pop-up's window features. */
  preferredWidth: number
  preferredHeight: number
}

/** Native-window fallback switch, as exposed to Settings. */
export interface DeskPopupMode {
  /** True when pop-ups open as separate OS windows (the old behaviour). */
  native: boolean
  /** True when PLEXI_POPUPS_NATIVE forces native and the toggle cannot undo it. */
  forcedByEnv: boolean
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/** Whether the PLEXI_POPUPS_NATIVE env value asks for native windows. */
export function envForcesNativePopups(value: string | undefined): boolean {
  return TRUTHY.has(String(value ?? '').trim().toLowerCase())
}

/** Native windows when the env flag OR the Settings toggle says so. */
export function shouldUseNativePopups(opts: { env: string | undefined; pref: boolean | undefined }): boolean {
  return envForcesNativePopups(opts.env) || opts.pref === true
}

/**
 * Convert the renderer's content-slot rect (CSS px) into WebContentsView bounds
 * (device-independent px of the window's content view).
 *
 * The renderer's CSS pixel is `zoomFactor` DIPs: the app's UI scale is a
 * webContents zoom (uiScale.ts → app:setZoomFactor), so at the 0.85 default on a
 * laptop a 600px-wide slot is 510 DIPs. devicePixelRatio is NOT the factor to
 * use — it also folds in the display's backing scale, which DIPs already hide.
 *
 * Returns null for a rect that cannot be shown (non-finite, or nothing left
 * after clamping to the window), so the caller hides the view rather than
 * placing it somewhere meaningless.
 */
export function popupBoundsFromCssRect(
  rect: PopupRect,
  zoomFactor: number,
  content: { width: number; height: number }
): PopupRect | null {
  const vals = [rect?.x, rect?.y, rect?.width, rect?.height]
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  // Snap outward-inward consistently: the left/top edge rounds, the right/bottom
  // edge rounds, and the size is their difference — so two adjacent rects never
  // overlap or gap by a pixel from independent rounding.
  let left = Math.round(rect.x * z)
  let top = Math.round(rect.y * z)
  let right = Math.round((rect.x + rect.width) * z)
  let bottom = Math.round((rect.y + rect.height) * z)
  left = Math.max(0, left)
  top = Math.max(0, top)
  right = Math.min(Math.floor(content.width), right)
  bottom = Math.min(Math.floor(content.height), bottom)
  const width = right - left
  const height = bottom - top
  if (width < 1 || height < 1) return null
  return { x: left, y: top, width, height }
}

/** Header height of a card, CSS px. The content slot sits below it. */
export const CARD_HEADER_PX = 40
/** Gap kept between a card and the edge of the area it floats in. */
export const CARD_MARGIN_PX = 24
/** Each stacked card steps down-right by this much so the ones beneath peek out. */
export const CARD_CASCADE_PX = 28

/**
 * Where card `index` (0 = bottom of the stack) sits inside an area of the given
 * size: the preferred content size plus the header, clamped to the area with a
 * margin, centred, then cascaded so every card's header stays visible.
 */
export function cardLayout(
  area: { width: number; height: number },
  preferred: { width: number; height: number },
  index: number
): { left: number; top: number; width: number; height: number } {
  const step = (Math.max(0, Math.floor(index)) % 6) * CARD_CASCADE_PX
  const maxW = Math.max(240, area.width - CARD_MARGIN_PX * 2 - step)
  const maxH = Math.max(200, area.height - CARD_MARGIN_PX * 2 - step)
  const prefW = Number.isFinite(preferred.width) && preferred.width > 0 ? preferred.width : 520
  const prefH = Number.isFinite(preferred.height) && preferred.height > 0 ? preferred.height : 720
  const width = Math.round(Math.min(prefW, maxW))
  const height = Math.round(Math.min(prefH + CARD_HEADER_PX, maxH))
  // Centre the card, step it by the cascade, and keep it inside the area.
  const place = (span: number, size: number): number =>
    Math.round(Math.max(0, Math.min(span - size, Math.max(0, (span - size) / 2) + step)))
  return { left: place(area.width, width), top: place(area.height, height), width, height }
}

/**
 * Bounds to use when the renderer never reported a slot (it crashed, or the
 * layer is not mounted on this screen). A pop-up must never be silently
 * invisible, so main centres it in the window on its own.
 */
export function fallbackPopupBounds(
  content: { width: number; height: number },
  preferred: { width: number; height: number }
): PopupRect {
  const width = Math.max(1, Math.min(Math.round(preferred.width || 520), Math.floor(content.width) - 48))
  const height = Math.max(1, Math.min(Math.round(preferred.height || 720), Math.floor(content.height) - 96))
  return {
    x: Math.max(0, Math.round((content.width - width) / 2)),
    y: Math.max(0, Math.round((content.height - height) / 2)),
    width,
    height
  }
}

/** The host a card shows under its title: `accounts.google.com`, no `www.`. */
export function popupHostLabel(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** The title a card shows: the page title, else its host, else a plain label. */
export function popupTitleLabel(title: string | null | undefined, url: string): string {
  const t = String(title ?? '').trim()
  if (t && t !== url && t !== 'about:blank') return t
  return popupHostLabel(url) || 'Pop-up'
}

/**
 * A pop-up that has loaded a real page and then goes to about:blank has handed
 * off — the classic end of an OAuth flow that blanks itself instead of calling
 * window.close(). Its card should go. The initial about:blank every new window
 * starts on is NOT a hand-off, hence `everLoadedWeb`.
 */
export function isHandoffEnd(url: string, everLoadedWeb: boolean): boolean {
  if (!everLoadedWeb) return false
  return /^about:blank(?:[#?].*)?$/i.test(String(url ?? '').trim())
}

/**
 * Which top-frame navigations a desk pop-up may make. Web pages and about:blank
 * only — the same line the desk webviews draw (a guest loading from disk or a
 * blob is refused there too). A custom scheme (zoommtg:, slack:) has no handler
 * inside a pop-up either way; refusing it here just makes that explicit.
 */
export function isAllowedPopupNavigation(url: string): boolean {
  return /^(https?:|about:blank)/i.test(String(url ?? '').trim())
}
