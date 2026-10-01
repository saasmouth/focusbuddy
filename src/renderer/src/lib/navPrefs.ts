import { useSyncExternalStore } from 'react'

// ── Canvas navigation preferences ───────────────────────────────────────────
// User-tunable controls for every way you move the camera: click-drag panning
// (+ its slingshot momentum), edge-pan, trackpad/wheel panning, and zoom.
// Persisted to localStorage and broadcast so the Canvas + the live preview in
// Settings react instantly. Modelled on soundPrefs.ts.

export interface NavPrefs {
  // ── Click-drag pan ──
  dragPanEnabled: boolean
  dragSensitivity: number // 0.5..2.5 — how far the camera moves per unit of drag (1 = 1:1)
  momentumEnabled: boolean // the "slingshot" — keep gliding after you let go
  slingshot: number // 1..6 — launch boost on release (higher = flings further)
  glide: number // 0..1 — how long it coasts before stopping (maps to friction)
  sonarOnGrab: boolean // sonar ping + pulse ring when you grab the canvas
  // ── Edge pan ──
  edgePanEnabled: boolean
  edgePanSpeed: number // 0.3..2.5 — max edge-scroll speed (1 = default)
  // ── Trackpad / wheel pan ──
  wheelSensitivity: number // 0.3..2.5 — two-finger / wheel pan speed (1 = 1:1)
  // ── Zoom ──
  zoomSensitivity: number // 0.3..2.5 — ⌘/pinch zoom speed (1 = default)
  // ── Arrow-key / swipe widget navigation ──
  /**
   * A decisive two-finger flick jumps to the neighbouring widget instead of
   * panning. Gentle two-finger movement still pans freely, so this costs
   * nothing until you actually flick -- but it is a toggle because a trackpad
   * gesture that sometimes snaps is worth being able to turn off.
   */
  swipeToWidget: boolean
  /**
   * 1..2 — how far an arrow-key or swipe jump may magnify a widget to make it
   * usable. 1 means never bigger than its designed size. The ceiling is the
   * canvas's own 2x; past about 1.5 a jump starts to feel like focus mode,
   * which is the thing this navigation exists to avoid.
   */
  navZoom: number
  // ── Layout ──
  snapToGridEnabled: boolean // round a dragged widget's drop position to an 8px grid
}

export const NAV_DEFAULTS: NavPrefs = {
  dragPanEnabled: true,
  dragSensitivity: 1,
  momentumEnabled: true,
  slingshot: 3.2,
  glide: 0.6,
  sonarOnGrab: true,
  edgePanEnabled: true,
  edgePanSpeed: 1,
  wheelSensitivity: 1,
  zoomSensitivity: 1,
  swipeToWidget: true,
  navZoom: 1.25,
  snapToGridEnabled: false
}

const KEY = 'fb.nav.prefs'

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}

function readFromStorage(): NavPrefs {
  if (typeof localStorage === 'undefined') return { ...NAV_DEFAULTS }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...NAV_DEFAULTS }
    const p = JSON.parse(raw) as Partial<NavPrefs>
    return {
      dragPanEnabled: bool(p.dragPanEnabled, NAV_DEFAULTS.dragPanEnabled),
      dragSensitivity: clamp(p.dragSensitivity, 0.5, 2.5, NAV_DEFAULTS.dragSensitivity),
      momentumEnabled: bool(p.momentumEnabled, NAV_DEFAULTS.momentumEnabled),
      slingshot: clamp(p.slingshot, 1, 6, NAV_DEFAULTS.slingshot),
      glide: clamp(p.glide, 0, 1, NAV_DEFAULTS.glide),
      sonarOnGrab: bool(p.sonarOnGrab, NAV_DEFAULTS.sonarOnGrab),
      edgePanEnabled: bool(p.edgePanEnabled, NAV_DEFAULTS.edgePanEnabled),
      edgePanSpeed: clamp(p.edgePanSpeed, 0.3, 2.5, NAV_DEFAULTS.edgePanSpeed),
      wheelSensitivity: clamp(p.wheelSensitivity, 0.3, 2.5, NAV_DEFAULTS.wheelSensitivity),
      zoomSensitivity: clamp(p.zoomSensitivity, 0.3, 2.5, NAV_DEFAULTS.zoomSensitivity),
      swipeToWidget: bool(p.swipeToWidget, NAV_DEFAULTS.swipeToWidget),
      navZoom: clamp(p.navZoom, 1, 2, NAV_DEFAULTS.navZoom),
      snapToGridEnabled: bool(p.snapToGridEnabled, NAV_DEFAULTS.snapToGridEnabled)
    }
  } catch {
    return { ...NAV_DEFAULTS }
  }
}

let cached: NavPrefs = readFromStorage()
const subscribers = new Set<() => void>()

export function getNavPrefs(): NavPrefs {
  return cached
}

export function setNavPrefs(patch: Partial<NavPrefs>): void {
  cached = { ...cached, ...patch }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, JSON.stringify(cached))
    } catch {
      // ignore quota
    }
  }
  subscribers.forEach((cb) => cb())
}

export function resetNavPrefs(): void {
  setNavPrefs({ ...NAV_DEFAULTS })
}

export function subscribeNavPrefs(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

// React hook — components re-render when any nav pref changes.
export function useNavPrefs(): NavPrefs {
  return useSyncExternalStore(subscribeNavPrefs, getNavPrefs, getNavPrefs)
}

// Map the user-facing "glide" (0..1) to a per-frame friction coefficient.
// 0 → 0.90 (stops quickly), 1 → 0.985 (coasts a long way).
export function frictionFromGlide(glide: number): number {
  return 0.9 + Math.max(0, Math.min(1, glide)) * 0.085
}
