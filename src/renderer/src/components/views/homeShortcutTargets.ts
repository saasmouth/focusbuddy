// Pure helpers for the Shortcuts widget: URL normalization, target identity,
// display resolution, and per-size slot budgets. No JSX, no store imports —
// unit tests, the widget, and the composer share one source of truth.

import { QUICK_LINK_ROUTES } from './homeWidgetDefs'
import type { HomeWidgetConfig, HomeWidgetId, ShortcutTarget, WidgetSize } from './homeWidgetDefs'

// What the widget needs to know about the world to describe a target. The
// component builds these from its stores; tests build them from fixtures.
export interface ShortcutLookups {
  // parentTitle: the containing room's name for a desk, when it has one — it
  // feeds the "Desk · Loop" context caption.
  node: (id: string) => { title: string; archived: boolean; parentTitle?: string | null } | null
  document: (id: string) => { title: string; docType: string; archived: boolean } | null
  app: (id: string) => { title: string } | null
}

export interface ShortcutView {
  label: string
  // Kind caption shown on the larger sizes ('Desk', 'Spreadsheet', 'Website').
  caption: string
  icon: string
  tone: string
  // false: the subject is gone or archived. The tile dims and stops navigating;
  // clicking it opens the composer so the dead entry can be removed.
  alive: boolean
}

// Slot budget per widget size, the add tile included. Derived from the real
// cell geometry (GRID cellH 200, RailCard header ~40px): sm fits two rows of
// THREE 64x72 lit tiles (the old two-rows-of-four assumption never held at
// the ~215px card interior — it produced a clipped third row); md fits two
// rows of three labeled tiles; stack fits eight list rows; lg fits two
// columns of seven rows.
// (icon is never a Shortcuts size; the entry only satisfies the Record.)
export const SHORTCUT_SLOTS: Record<WidgetSize, number> = { icon: 2, sm: 6, md: 6, stack: 8, lg: 14 }

// How many targets render at a size. The add tile always takes one slot; when
// targets overflow the rest, the final visible slot becomes a "+N" spillover
// that opens the composer, so nothing is ever silently hidden.
export function visibleShortcuts(total: number, size: WidgetSize): { shown: number; overflow: number } {
  const room = SHORTCUT_SLOTS[size] - 1
  if (total <= room) return { shown: total, overflow: 0 }
  const shown = Math.max(0, room - 1)
  return { shown, overflow: total - shown }
}

// Accepts what a person actually pastes or types: full URLs, scheme-less
// domains ("netsuite.com/login"), localhost with a port. Returns a canonical
// URL string, or null when the text is clearly not a link.
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s || /\s/.test(s)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    ? s
    : /^localhost(:\d+)?([/?#]|$)/i.test(s)
      ? `http://${s}`
      : `https://${s}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname
  // A bare word ("payroll") is a search query, not a link. Real hosts have a
  // dot; localhost and IPs pass on their own shape.
  if (!host.includes('.') && host !== 'localhost') return null
  if (/\.$/.test(host) || /^\./.test(host)) return null
  return url.href
}

// The human name for a URL when no label was given: hostname minus www.
export function urlLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// Favicon for a website tile. Google's s2 service resolves icons reliably
// across hosts that bury theirs; the tile falls back to a globe glyph when
// the image fails to load.
export function faviconUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
  } catch {
    return null
  }
}

// Stable identity for dedupe and list keys. Two targets are the same shortcut
// when they lead to the same place, regardless of label.
export function targetKey(t: ShortcutTarget): string {
  switch (t.kind) {
    case 'url':
      return `url:${t.url}`
    case 'section':
      return `section:${t.id}`
    case 'desk':
      return `desk:${t.nodeId}`
    case 'room':
      return `room:${t.roomId}`
    case 'document':
      return `document:${t.documentId}`
    case 'connected-app':
      return `app:${t.appId}`
    case 'action':
      return `action:${t.action}`
    case 'person':
      return `person:${t.accountId}`
    case 'desk-widget':
      return `deskwidget:${t.nodeId}:${t.widgetId}`
  }
}

// Quick Links absorption (2026-08-21): a stored quick-links instance becomes a
// Shortcuts box whose targets are its picked sections, keeping its key, size,
// and position. Runs at layout load. Idempotent: the result is 'shortcuts' and
// never matches again. The box keeps the old widget's name so the board reads
// unchanged after migration.
export function migrateQuickLinks<T extends { widget: HomeWidgetId; config?: HomeWidgetConfig }>(inst: T): T {
  if (inst.widget !== 'quick-links') return inst
  const targets: ShortcutTarget[] = (inst.config?.routes ?? [])
    .map((id): ShortcutTarget | null => {
      const route = QUICK_LINK_ROUTES.find((r) => r.id === id)
      return route ? { kind: 'section', id, label: route.label } : null
    })
    .filter((t): t is ShortcutTarget => t !== null)
  return { ...inst, widget: 'shortcuts' as HomeWidgetId, config: { title: 'Quick links', targets } }
}

// Document tiles carry their product's suite accent (plexiSuite.ts: Docs
// #3b82f6, Sheets #22c55e, Slides #f97316) so a Q3 budget reads as a Sheets
// object at a glance — identity in the chip, distinct from colour-is-state.
const DOC_VISUALS: Record<string, { icon: string; tone: string; caption: string }> = {
  doc: { icon: 'description', tone: 'text-blue-500', caption: 'Document' },
  sheet: { icon: 'table_chart', tone: 'text-green-500', caption: 'Spreadsheet' },
  slides: { icon: 'slideshow', tone: 'text-orange-500', caption: 'Deck' }
}

export function describeShortcutTarget(t: ShortcutTarget, lookups: ShortcutLookups): ShortcutView {
  switch (t.kind) {
    case 'url': {
      // A renamed link keeps its domain visible ("NetSuite" · netsuite.com);
      // an unnamed one already shows the domain as its label.
      const host = urlLabel(t.url)
      const label = t.label || host
      return {
        label,
        caption: label === host ? 'Website' : host,
        icon: 'language',
        tone: 'text-indigo-500',
        alive: true
      }
    }
    case 'section': {
      const route = QUICK_LINK_ROUTES.find((r) => r.id === t.id)
      return route
        ? { label: route.label, caption: 'PlexiDesk', icon: route.icon, tone: route.tone, alive: true }
        : { label: t.label || 'Missing section', caption: 'PlexiDesk', icon: 'link', tone: 'text-[var(--ink-40)]', alive: false }
    }
    case 'desk': {
      const node = lookups.node(t.nodeId)
      return {
        label: node?.title || t.label || 'Missing desk',
        caption: node?.parentTitle ? `Desk · ${node.parentTitle}` : 'Desk',
        icon: 'desk',
        tone: 'text-violet-500',
        alive: !!node && !node.archived
      }
    }
    case 'room': {
      const node = lookups.node(t.roomId)
      return {
        label: node?.title || t.label || 'Missing room',
        caption: 'Room',
        icon: 'meeting_room',
        tone: 'text-sky-500',
        alive: !!node && !node.archived
      }
    }
    case 'document': {
      const doc = lookups.document(t.documentId)
      const visuals = DOC_VISUALS[doc?.docType ?? 'doc'] ?? DOC_VISUALS.doc
      return {
        label: doc?.title || t.label || 'Missing document',
        // detail = the Drive folder it lives in, snapshotted when it was
        // added: "Spreadsheet · Flamelit" instead of an anonymous doc icon.
        caption: t.detail ? `${visuals.caption} · ${t.detail}` : visuals.caption,
        icon: visuals.icon,
        tone: visuals.tone,
        alive: !!doc && !doc.archived
      }
    }
    case 'connected-app': {
      const app = lookups.app(t.appId)
      return {
        label: app?.title || t.label || 'Missing app',
        caption: 'App',
        icon: 'apps',
        tone: 'text-emerald-500',
        alive: !!app
      }
    }
    case 'action':
      return t.action === 'new-meeting'
        ? { label: t.label || 'New meeting', caption: 'Action', icon: 'plexii:meet', tone: 'text-rose-500', alive: true }
        : { label: t.label || 'Transcribe', caption: 'Action', icon: 'plexii:mic', tone: 'text-violet-500', alive: true }
    case 'person':
      // People are never stale: the DM starts for real on first click, and the
      // name was snapshotted at add time.
      return {
        label: t.label || t.handle || 'Someone',
        caption: 'Message',
        icon: 'account_circle',
        tone: 'text-sky-500',
        alive: true
      }
    case 'desk-widget': {
      // Liveness follows the DESK: Home cannot see another desk's widget list,
      // and landing on the desk is still correct if the widget was removed.
      const node = lookups.node(t.nodeId)
      return {
        label: t.label || 'Work widget',
        caption: node?.title ? `On ${node.title}` : 'Work widget',
        icon: 'dashboard_customize',
        tone: 'text-teal-500',
        alive: !!node && !node.archived
      }
    }
  }
}
