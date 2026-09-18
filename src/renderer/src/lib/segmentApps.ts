// Every app inside a segment, in one place.
//
// The app you have open inside a segment is NAVIGATION — it belongs in the view
// store, it belongs in the tray, and the back arrow should return to it. Three
// of the four segments kept it in a `useState` instead, which meant none of
// their apps appeared in the tray, back did nothing inside a segment, and
// reloading dropped you back on the segment's home having lost what you were
// looking at. PlexiOffice had the same bug; fixing it there left twenty-four
// apps across PlexiDesk, PlexiPeople and PlexiBrain still broken.
//
// The tray needs a NAME and an ICON for each of them. Those already existed, in
// the shells, next to the renderers — so the tray grew a second copy, and a
// second copy of a list nobody remembers to update is how you end up with a tab
// reading "home". (It already had: office:home was missing from that copy and
// rendered its raw key.) This module is the one source: the shells spread their
// label and icon from here, and so does the tray.

export type SegmentKind = 'plexidesk' | 'plexipeople' | 'plexibrain' | 'office'

export interface SegmentAppMeta {
  key: string
  label: string
  icon: string
  /**
   * This app IS the segment's landing page.
   *
   * The tray lists things you have OPEN, not places you can go — a tray that
   * lists destinations is a second navigation bar at the bottom of the window.
   * A segment's home is the place you arrive at, and four tabs all reading
   * some variant of "Home" would be noise, so hubs are deliberately excluded.
   */
  hub?: boolean
}

export const SEGMENT_APPS = {
  plexidesk: [
    { key: 'home', label: 'Home', icon: 'plexii:home', hub: true },
    { key: 'desk', label: 'My Desk', icon: 'space_dashboard' },
    { key: 'workspaces', label: 'Workspaces', icon: 'apartment' },
    { key: 'plans', label: 'Plans', icon: 'account_tree' },
    { key: 'ops', label: 'Agentic Ops', icon: 'smart_toy' },
    { key: 'tasks', label: 'Desks', icon: 'checklist' },
    { key: 'calendar', label: 'Calendar', icon: 'calendar_month' },
    { key: 'files', label: 'Files', icon: 'folder' },
    { key: 'recent', label: 'Recent', icon: 'schedule' }
  ],
  plexipeople: [
    { key: 'home', label: 'People Home', icon: 'groups', hub: true },
    { key: 'directory', label: 'Directory', icon: 'badge' },
    { key: 'workspaces', label: 'Organisation', icon: 'apartment' },
    { key: 'map', label: 'Organisation Map', icon: 'account_tree' }
  ],
  plexibrain: [
    { key: 'home', label: 'Brain Home', icon: 'plexii:home', hub: true },
    { key: 'ask', label: 'Ask Brain', icon: 'neurology' },
    { key: 'search', label: 'Search', icon: 'search' },
    { key: 'map', label: 'Brain Map', icon: 'bubble_chart' },
    { key: 'decisions', label: 'Decisions', icon: 'gavel' },
    { key: 'assemble', label: 'Assemble a desk', icon: 'dashboard_customize' },
    { key: 'flows', label: 'Flows', icon: 'bolt' },
    { key: 'agents', label: 'Agents', icon: 'smart_toy' },
    { key: 'connect', label: 'Connect', icon: 'hub' },
    { key: 'api', label: 'APIs', icon: 'api' },
    { key: 'insights', label: 'Insights', icon: 'insights' }
  ],
  office: [
    { key: 'home', label: 'Office Home', icon: 'plexii:home', hub: true },
    { key: 'mail', label: 'Mail', icon: 'mail' },
    { key: 'inbox', label: 'Inbox', icon: 'inbox' },
    { key: 'chat', label: 'Chat', icon: 'forum' },
    { key: 'meet', label: 'Meet', icon: 'video_call' },
    { key: 'sign', label: 'Sign', icon: 'plexii:sign' },
    { key: 'browser', label: 'Browser', icon: 'public' },
    // The document apps. Not comms apps — deep-linking one lands on the Office
    // hub filtered to that type — but `office:<key>` is a real view either way,
    // so the tray has to be able to name it.
    { key: 'docs', label: 'PlexiDocs', icon: 'description' },
    { key: 'sheets', label: 'PlexiSheets', icon: 'table_chart' },
    { key: 'slides', label: 'PlexiSlides', icon: 'slideshow' },
    { key: 'diagrams', label: 'PlexiDiagrams', icon: 'account_tree' },
    { key: 'design', label: 'PlexiDesign', icon: 'plexii:design' },
    { key: 'draw', label: 'PlexiDraw', icon: 'brush' }
  ]
} as const satisfies Record<SegmentKind, readonly SegmentAppMeta[]>

/** The app keys a given segment actually has, as literal types. */
export type AppKeyOf<K extends SegmentKind> = (typeof SEGMENT_APPS)[K][number]['key']

/**
 * One app's name and icon.
 *
 * Typed so a key that does not exist in that segment is a COMPILE error rather
 * than a tray tab reading "reciepts" six months from now.
 */
export function appMeta<K extends SegmentKind>(
  kind: K,
  key: AppKeyOf<K>
): { key: string; label: string; icon: string } {
  const found = (SEGMENT_APPS[kind] as readonly SegmentAppMeta[]).find((a) => a.key === key)
  // Unreachable through the typed signature; kept honest for callers holding a
  // key that came from persisted state rather than from source.
  if (!found) return { key: String(key), label: String(key), icon: 'apps' }
  return { key: found.key, label: found.label, icon: found.icon }
}

/** Look up an app by a key from anywhere — a stored view, a deep link. */
export function lookupApp(kind: SegmentKind, key: string | null | undefined): SegmentAppMeta | null {
  if (!key) return null
  return (SEGMENT_APPS[kind] as readonly SegmentAppMeta[]).find((a) => a.key === key) ?? null
}

/** Whether this app is the segment's landing page, and so not a tray entry. */
export function isHubApp(kind: SegmentKind, key: string | null | undefined): boolean {
  if (!key) return true
  return lookupApp(kind, key)?.hub === true
}
