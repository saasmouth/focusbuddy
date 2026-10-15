import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  unreadFromTitle,
  looksSignedOut,
  useAppNotifications
} from '../../src/renderer/src/stores/appNotifications'

// Connected-app notifications in the side menu.
//
// The count comes from the app's own page title — "(3) Inbox", "Slack (12)" —
// which is the app's claim about itself, so reading it is reporting rather
// than inferring. The parser is the whole risk: a loose rule turns a year or a
// version into an unread count, and a badge reading "2024" would be worse than
// no badge at all.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('reading a count out of a page title', () => {
  it('reads the leading-parenthesis convention', () => {
    expect(unreadFromTitle('(3) Inbox — Gmail')).toBe(3)
    expect(unreadFromTitle('(12) Slack | general')).toBe(12)
    expect(unreadFromTitle('(99+) Mail')).toBe(99)
  })

  it('reads a trailing count', () => {
    expect(unreadFromTitle('Slack (12)')).toBe(12)
    expect(unreadFromTitle('Notion (4)')).toBe(4)
  })

  it('reads the worded form', () => {
    expect(unreadFromTitle('Inbox - 5 unread')).toBe(5)
    expect(unreadFromTitle('7 unread messages')).toBe(7)
  })

  it('does NOT mistake a year for a count', () => {
    // The whole reason the trailing rule is capped at three digits.
    expect(unreadFromTitle('Figma (2024)')).toBeNull()
    expect(unreadFromTitle('Annual report (2026)')).toBeNull()
  })

  it('does NOT mistake a version for a count', () => {
    expect(unreadFromTitle('Editor (1.2)')).toBeNull()
    expect(unreadFromTitle('App (v3)')).toBeNull()
  })

  it('returns null for an ordinary title', () => {
    expect(unreadFromTitle('Gmail')).toBeNull()
    expect(unreadFromTitle('')).toBeNull()
    expect(unreadFromTitle('Google Docs — Untitled document')).toBeNull()
  })

  it('treats zero as nothing to show', () => {
    expect(unreadFromTitle('(0) Inbox')).toBeNull()
    expect(unreadFromTitle('0 unread')).toBeNull()
  })
})

describe('the store only holds what an app actually reported', () => {
  beforeEach(() => {
    useAppNotifications.setState({ counts: {} })
  })

  it('records a reported count', () => {
    useAppNotifications.getState().report('app-1', '(4) Inbox')
    expect(useAppNotifications.getState().countFor('app-1')).toBe(4)
  })

  it('CLEARS the badge when the app stops claiming one', () => {
    // An inbox that has been read reports a plain title again; leaving the old
    // number would be showing a count that is no longer true.
    useAppNotifications.getState().report('app-1', '(4) Inbox')
    useAppNotifications.getState().report('app-1', 'Inbox')
    expect(useAppNotifications.getState().countFor('app-1')).toBe(0)
  })

  it('never invents a count for an app that said nothing', () => {
    expect(useAppNotifications.getState().countFor('never-seen')).toBe(0)
  })

  it('clears on open, since opening it is reading it', () => {
    useAppNotifications.getState().report('app-1', '(9) Inbox')
    useAppNotifications.getState().clear('app-1')
    expect(useAppNotifications.getState().countFor('app-1')).toBe(0)
  })
})

describe('the preference, and where it lives', () => {
  const types = read('shared/types.ts')
  const migrations = read('main/db/migrations.ts')
  const dialog = read('renderer/src/components/AddConnectedAppDialog.tsx')
  const accordion = read('renderer/src/components/nav/AreaAccordion.tsx')
  const store = read('renderer/src/stores/appNotifications.ts')

  it('is a durable per-app choice, not session state', () => {
    expect(types).toContain('notifications: boolean')
    expect(migrations).toContain("ensureColumn(db, 'connected_apps', 'notifications'")
  })

  it('defaults to ON, including for apps that predate the column', () => {
    expect(migrations).toContain("'INTEGER NOT NULL DEFAULT 1'")
    expect(read('main/db/connectedApps.ts')).toContain(
      'row.notifications === undefined ? true : row.notifications === 1'
    )
  })

  it('is opt-out at connect time, as asked', () => {
    expect(dialog).toContain('data-testid="connect-notifications"')
    expect(dialog).toContain('useState(true)')
    expect(dialog).toContain('notifications')
  })

  it('a badge only renders for an app that opted in', () => {
    expect(accordion).toContain('badge={app.notifications ?')
  })

  it('says plainly what it cannot do, rather than implying background polling', () => {
    // A badge that invented a number while the app was closed would be worse
    // than no badge; the limit is documented where the next person will look.
    // Matched on a phrase that does not straddle a comment line-wrap.
    expect(store).toContain('nothing here loads an app you did not open')
  })
})

describe('sign-in details go to the Vault, not to the app row', () => {
  const dialog = read('renderer/src/components/AddConnectedAppDialog.tsx')

  it('captures a username and password at connect time', () => {
    expect(dialog).toContain('data-testid="connect-username"')
    expect(dialog).toContain('data-testid="connect-password"')
  })

  it('writes them to the encrypted Vault and binds the entry to the app', () => {
    // The vault is already the encrypted store, and the webviews already
    // autofill from a bound entry — so this reuses both rather than adding a
    // second place credentials can live.
    expect(dialog).toContain('addVaultEntry({')
    expect(dialog).toContain('setAppVaultEntry(appId, entry.id)')
  })

  it('does not fail the whole connect when the vault is locked', () => {
    // An app that connected without autofill is still a working app.
    expect(dialog).toContain('Vault is locked')
  })
})

// ── Background counts, and telling live from remembered ───────────────────
// "We should not presume the existing apps in the directory is finite… read
// their notifications from their logged in state, and if they are logged out
// show awake/asleep — a moon and a grey count when not live, a yellow sun and
// a green count when logged in."

describe('signed-out detection is generic, because the app list is not finite', () => {
  it('treats a visible password field as signed out, whatever the app', () => {
    expect(looksSignedOut('https://anything.example.com/', true)).toBe(true)
  })

  it('recognises the login URL shapes the whole web uses', () => {
    for (const u of [
      'https://app.example.com/login',
      'https://example.com/signin?next=/inbox',
      'https://example.com/sign-in',
      'https://accounts.example.com/oauth/authorize',
      'https://example.com/users/sign_in',
      'https://example.com/session/new',
      'https://example.com/u/login'
    ]) {
      expect(looksSignedOut(u, false), u).toBe(true)
    }
  })

  it('does not call an ordinary app URL signed out', () => {
    for (const u of [
      'https://mail.example.com/u/0/#inbox',
      'https://example.com/workspace/docs',
      'https://example.com/authors/jane'
    ]) {
      expect(looksSignedOut(u, false), u).toBe(false)
    }
  })

  it('contains no per-app rules in the CODE', () => {
    // Comments may name an app to illustrate a convention ("(3) Inbox" is how
    // Gmail does it); the logic may not. So this strips comments and checks
    // what actually executes — the property that matters is that adding an app
    // nobody anticipated needs no change here.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const store = stripComments(read('renderer/src/stores/appNotifications.ts')).toLowerCase()
    const host = stripComments(read('renderer/src/components/AppNotificationHost.tsx')).toLowerCase()
    for (const brand of ['gmail', 'slack', 'notion', 'figma', 'outlook']) {
      expect(store, `store branches on ${brand}`).not.toContain(brand)
      expect(host, `host branches on ${brand}`).not.toContain(brand)
    }
  })
})

describe('liveness is recorded, never assumed', () => {
  beforeEach(() => {
    useAppNotifications.setState({ counts: {}, status: {} })
  })

  it('an app nobody has checked is asleep, not live', () => {
    expect(useAppNotifications.getState().livenessFor('unchecked')).toBe('asleep')
  })

  it('records live and signed-out distinctly', () => {
    const s = useAppNotifications.getState()
    s.setLiveness('a', 'live', 'https://example.com/inbox')
    s.setLiveness('b', 'signed-out', 'https://example.com/login')
    expect(useAppNotifications.getState().livenessFor('a')).toBe('live')
    expect(useAppNotifications.getState().livenessFor('b')).toBe('signed-out')
  })

  it('keeps the last count when an app signs out, but stops calling it live', () => {
    // The number was true when we saw it; the claim that it is CURRENT is not.
    const s = useAppNotifications.getState()
    s.report('a', '(6) Inbox')
    s.setLiveness('a', 'signed-out', 'https://example.com/login')
    expect(useAppNotifications.getState().countFor('a')).toBe(6)
    expect(useAppNotifications.getState().livenessFor('a')).toBe('signed-out')
  })
})

describe('the badge shows which kind of claim it is making', () => {
  const accordion = read('renderer/src/components/nav/AreaAccordion.tsx')

  it('green count and a sun when live', () => {
    expect(accordion).toContain("liveness === 'live'")
    expect(accordion).toContain('bg-emerald-500')
    expect(accordion).toContain('wb_sunny')
    expect(accordion).toContain('text-amber-400')
  })

  it('grey count and a moon otherwise', () => {
    expect(accordion).toContain('bedtime')
    expect(accordion).toContain('bg-[var(--ink-30)]')
  })

  it('shows the sun/moon even at zero unread', () => {
    // "Nothing new" and "we cannot see" are different answers.
    expect(accordion).toContain('{liveness !== null && (')
  })

  it('explains itself on hover rather than leaving a bare mark', () => {
    expect(accordion).toContain('signed in, checked just now')
    expect(accordion).toContain('so this is not current')
  })
})

describe('the background host is cheap and reuses the real session', () => {
  const host = read('renderer/src/components/AppNotificationHost.tsx')

  it('polls then releases, rather than holding a renderer per app', () => {
    expect(host).toContain('POLL THEN RELEASE')
    expect(host).toContain('const SLOTS')
  })

  it('runs in the app’s own persistent partition, so a signed-in app stays so', () => {
    expect(host).toContain('`persist:connectedapp-${app.id}`')
  })

  it('creates no sessions and logs nobody in', () => {
    expect(host).toContain('Nothing here logs anybody in')
  })

  it('skips local apps, which have no page to read', () => {
    expect(host).toContain("a.kind !== 'local'")
  })

  it('only watches apps that opted in', () => {
    expect(host).toContain('a.notifications')
  })

  it('reports asleep rather than inventing a count when a probe fails', () => {
    expect(host).toContain("setLiveness(app.id, 'asleep'")
  })
})

describe('the assistant no longer covers the top menu', () => {
  const overlay = read('renderer/src/components/assistant/AssistantOverlay.tsx')

  it('fullscreen insets below the h-10 header', () => {
    // inset-0 put it over Add widget, the load alarm, Smart Stack, body
    // double, search and settings — all unreachable until it was dismissed.
    expect(overlay).toContain("'fixed top-10 inset-x-0 bottom-0 z-[190]")
    expect(overlay).not.toContain("'fixed inset-0 z-[190]")
  })
})

describe('every top-menu button explains itself on hover', () => {
  it('the header wraps each of its buttons in a Tooltip', () => {
    const app = read('renderer/src/App.tsx').split('\n').slice(566, 700).join('\n')
    expect(app.match(/<Tooltip/g)?.length ?? 0).toBeGreaterThanOrEqual(
      app.match(/<button/g)?.length ?? 0
    )
  })

  it('the load alarm uses the same tooltip as the rest of the header', () => {
    const meter = read('renderer/src/components/LoadMeter.tsx')
    expect(meter).toContain('<Tooltip')
    expect(meter).toContain('Click to park what you are not using')
  })

  it('Add widget explains itself too', () => {
    expect(read('renderer/src/components/desk/DeskAddWidget.tsx')).toContain(
      'title="Add a widget to this desk"'
    )
  })
})
