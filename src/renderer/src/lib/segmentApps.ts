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
  /**
   * The view kind this app stands in for, when it is gated.
   *
   * It lived in two other places: `segments.tsx` set it inline per app, and the
   * Office shell kept its own COMMS_VIEW_KIND map. A menu that lists an app the
   * backbone will refuse is a dead affordance, and two copies of the mapping is
   * how one of them ends up missing an entry. Omitted means core: always shown.
   */
  gateKind?: string
  /**
   * The icon's colour, as a Tailwind text class.
   *
   * It lived in `segments.tsx` and in the Office shell's own two registries,
   * which is why the same app could be sky in one menu and uncoloured in
   * another. The operator asked for every icon in the menu to carry colour, so
   * it belongs on the one registry the menu reads.
   */
  tone?: string
}

export const SEGMENT_APPS = {
  plexidesk: [
    { key: 'home', label: 'Home', icon: 'plexii:home', hub: true, tone: 'text-indigo-500' },
    { key: 'desk', label: 'My Desk', icon: 'space_dashboard', tone: 'text-sky-500' },
    { key: 'workspaces', label: 'Workspaces', icon: 'apartment', gateKind: 'organization', tone: 'text-teal-500' },
    { key: 'plans', label: 'Plans', icon: 'account_tree', tone: 'text-violet-500' },
    { key: 'ops', label: 'Agentic Ops', icon: 'smart_toy', tone: 'text-cyan-600' },
    { key: 'tasks', label: 'Desks', icon: 'checklist', tone: 'text-emerald-500' },
    // Calendar and Files are NOT here. 4.3.25 moved them into Office, beside
    // the inbox, on the reasoning that a calendar is where you answer people —
    // but this registry kept its own copies, so both ended up listed in two
    // areas. Two tray tabs reading "Calendar" cannot be told apart, and the one
    // menu would have shown it twice. They live in `office` only.
    { key: 'recent', label: 'Recent', icon: 'schedule', tone: 'text-rose-500' }
  ],
  plexipeople: [
    { key: 'home', label: 'People Home', icon: 'groups', hub: true, tone: 'text-indigo-500' },
    { key: 'directory', label: 'Directory', icon: 'badge', tone: 'text-sky-500' },
    { key: 'workspaces', label: 'Organisation', icon: 'apartment', gateKind: 'organization', tone: 'text-teal-500' },
    { key: 'map', label: 'Organisation Map', icon: 'account_tree', gateKind: 'people-map', tone: 'text-violet-500' }
  ],
  plexibrain: [
    { key: 'home', label: 'Brain Home', icon: 'plexii:home', hub: true, tone: 'text-indigo-500' },
    { key: 'ask', label: 'Ask Brain', icon: 'neurology', tone: 'text-indigo-500' },
    { key: 'search', label: 'Search', icon: 'search', tone: 'text-sky-500' },
    { key: 'map', label: 'Brain Map', icon: 'bubble_chart', tone: 'text-fuchsia-500' },
    { key: 'decisions', label: 'Decisions', icon: 'gavel', tone: 'text-red-500' },
    { key: 'assemble', label: 'Assemble a desk', icon: 'dashboard_customize', tone: 'text-lime-600' },
    { key: 'flows', label: 'Flows', icon: 'bolt', tone: 'text-violet-500' },
    { key: 'agents', label: 'Agents', icon: 'smart_toy', tone: 'text-emerald-500' },
    { key: 'connect', label: 'Connect', icon: 'hub', tone: 'text-cyan-500' },
    { key: 'api', label: 'APIs', icon: 'api', tone: 'text-amber-500' },
    { key: 'insights', label: 'Insights', icon: 'insights', tone: 'text-rose-500' }
  ],
  office: [
    { key: 'home', label: 'Office Home', icon: 'plexii:home', hub: true, tone: 'text-indigo-500' },
    { key: 'mail', label: 'Mail', icon: 'mail', gateKind: 'mail', tone: 'text-rose-500' },
    { key: 'inbox', label: 'Inbox', icon: 'inbox', tone: 'text-amber-500' },
    { key: 'chat', label: 'Chat', icon: 'forum', gateKind: 'messages', tone: 'text-sky-500' },
    { key: 'meet', label: 'Meet', icon: 'video_call', gateKind: 'meetings', tone: 'text-violet-500' },
    { key: 'sign', label: 'Sign', icon: 'plexii:sign', gateKind: 'sign', tone: 'text-teal-500' },
    { key: 'browser', label: 'Browser', icon: 'public', tone: 'text-indigo-500' },
    // Calendar and Files render inside Office and are real `office:<key>` views,
    // but were never listed here — so the tray named them by their raw key. The
    // Vault joins them for the same reason.
    { key: 'calendar', label: 'Calendar', icon: 'calendar_month', gateKind: 'calendar', tone: 'text-violet-500' },
    { key: 'files', label: 'Files', icon: 'folder', gateKind: 'files', tone: 'text-sky-500' },
    { key: 'vault', label: 'Vault', icon: 'lock', gateKind: 'vault', tone: 'text-slate-500' },
    // The document apps. Not comms apps — deep-linking one lands on the Office
    // hub filtered to that type — but `office:<key>` is a real view either way,
    // so the tray has to be able to name it.
    { key: 'docs', label: 'PlexiDocs', icon: 'description', tone: 'text-sky-500' },
    { key: 'sheets', label: 'PlexiSheets', icon: 'table_chart', tone: 'text-emerald-500' },
    { key: 'slides', label: 'PlexiSlides', icon: 'slideshow', tone: 'text-orange-500' },
    { key: 'diagrams', label: 'PlexiDiagrams', icon: 'account_tree', tone: 'text-violet-500' },
    { key: 'design', label: 'PlexiDesign', icon: 'plexii:design', tone: 'text-fuchsia-500' },
    { key: 'draw', label: 'PlexiDraw', icon: 'brush', tone: 'text-rose-500' }
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
): { key: string; label: string; icon: string; gateKind?: string; tone?: string } {
  const found = (SEGMENT_APPS[kind] as readonly SegmentAppMeta[]).find((a) => a.key === key)
  // Unreachable through the typed signature; kept honest for callers holding a
  // key that came from persisted state rather than from source.
  if (!found) return { key: String(key), label: String(key), icon: 'apps' }
  return {
    key: found.key,
    label: found.label,
    icon: found.icon,
    gateKind: found.gateKind,
    tone: found.tone
  }
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
