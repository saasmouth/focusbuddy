import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  unreadFromTitle,
  looksSignedOut,
  sumAriaUnread,
  titleUnitOf,
  useAppNotifications
} from '../../src/renderer/src/stores/appNotifications'
// 4.3.32 lexicon standard: user-facing text says “work widget”. The string pins in
// this file that read “widget” were rewritten to the new wording (owner ruling).

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
  // 4.3.32: Tile moved to nav/menuParts.tsx (shared with the Widgets section).
  const accordion = read('renderer/src/components/nav/AreaAccordion.tsx') + read('renderer/src/components/nav/menuParts.tsx')
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
  // 4.3.32: Tile moved to nav/menuParts.tsx (shared with the Widgets section).
  const accordion = read('renderer/src/components/nav/AreaAccordion.tsx') + read('renderer/src/components/nav/menuParts.tsx')

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

  it('the header OUTRANKS every assistant surface', () => {
    // Geometry alone was not enough. The header sat at z-[100] while the
    // assistant runs 120 (sidebar, floating, pill) to 190 (fullscreen, right
    // takeover), so the toolbar read as sitting under the assistant and any
    // menu opened from a header button painted behind it.
    const app = read('renderer/src/App.tsx')
    expect(app).toContain('relative z-[195] h-10')
    const zs = [...overlay.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]))
    expect(zs.length).toBeGreaterThan(0)
    expect(Math.max(...zs)).toBeLessThan(195)
  })

  it('but still sits below modals, which must cover everything', () => {
    const app = read('renderer/src/App.tsx')
    expect(app).toContain('relative z-[195]')
    expect(app).not.toContain('relative z-[2')
  })

  it('fullscreen insets below the h-10 header', () => {
    // inset-0 put it over Add widget, the load alarm, Smart Stack, body
    // double, search and settings — all unreachable until it was dismissed.
    expect(overlay).toContain("'fixed top-10 inset-x-0 bottom-0 z-[190]")
    expect(overlay).not.toContain("'fixed inset-0 z-[190]")
  })
})

describe('every top-menu button explains itself on hover', () => {
  it('the header wraps each of its own buttons in a Tooltip', () => {
    const app = read('renderer/src/App.tsx').split('\n').slice(566, 710).join('\n')
    expect(app.match(/<Tooltip/g)?.length ?? 0).toBeGreaterThanOrEqual(
      app.match(/<button/g)?.length ?? 0
    )
  })

  it('AND so does the desk action bar, which is MOST of the top menu', () => {
    // The assertion above was vacuously green: it covered only the four
    // buttons literally in App.tsx, while the dozen icons the user actually
    // sees are portalled into #fb-header-actions by FloatingPill — which had
    // 14 buttons and zero Tooltips, only native `title=`.
    const pill = read('renderer/src/components/FloatingPill.tsx')
    const buttons = (pill.match(/<button|<motion\.button/g) ?? []).length
    const tooltips = (pill.match(/<Tooltip/g) ?? []).length
    expect(buttons).toBeGreaterThan(0)
    expect(tooltips).toBeGreaterThanOrEqual(buttons)
  })

  it('and none of them is left on a native title', () => {
    // Native tooltips are slow and unstyled, and on this frameless window they
    // were not appearing over the assistant at all.
    const pill = read('renderer/src/components/FloatingPill.tsx')
    const code = pill.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\stitle=/)
  })

  it('the load alarm uses the same tooltip as the rest of the header', () => {
    const meter = read('renderer/src/components/LoadMeter.tsx')
    expect(meter).toContain('<Tooltip')
    expect(meter).toContain('Click to park what you are not using')
  })

  it('adding a widget explains itself too', () => {
    // Superseded 4.3.32: this pinned the header's Add widget button
    // (desk/DeskAddWidget, title "Add a widget to this desk"). That button is
    // gone — widgets are added from the side menu's Widgets section — and every
    // tile there carries its full name as a tooltip (so a clipped label never
    // loses it), with the menu's own items saying what each gesture does.
    // …and, since the loose ends of 4.3.32, a second line saying what a click
    // and a drag make (lib/widgetMenu widgetMenuHint).
    expect(read('renderer/src/components/nav/menuParts.tsx')).toContain('title={[note ? `${label} — ${note}` : label, hint].filter(Boolean).join')
    expect(read('renderer/src/components/nav/WidgetsSection.tsx')).toContain('hint={widgetMenuHint(entry)}')
    const section = read('renderer/src/components/nav/WidgetsSection.tsx')
    expect(section).toContain("label: 'Add to this desk'")
    expect(section).toContain("label: 'Move to Other work widgets'")
  })
})

// ── Counting messages, not conversations ──────────────────────────────────
// "whatsapp notifications are working, but its showing conversations as the
// metric, not total messages to address" / "there were 5 unread in one message
// and it reported as 1".
//
// A messaging app's TITLE counts threads: one chat holding five unread titles
// itself "(1)". So the badge was answering "how many conversations" while the
// user was asking "how much is waiting" — the wrong question, answered
// confidently. The per-thread pills carry the real numbers in their accessible
// names, and `aria-label` is a standard rather than a selector, which is what
// keeps this working on an app nobody anticipated.

describe('summing the real message counts out of accessible labels', () => {
  const lbl = (label: string, containsAnother = false): { label: string; containsAnother: boolean } => ({
    label,
    containsAnother
  })

  it('sums the per-conversation counts — the 5-in-one-chat case', () => {
    // The exact report: one chat, five messages, badged as 1 from the title.
    expect(sumAriaUnread([lbl('5 unread messages')])).toBe(5)
  })

  it('adds up across conversations', () => {
    expect(
      sumAriaUnread([lbl('5 unread messages'), lbl('2 unread messages'), lbl('1 unread message')])
    ).toBe(8)
  })

  it('does NOT double count a pill inside a labelled row', () => {
    // The one real hazard: a row and its own pill can both be labelled, and a
    // container may restate its children's total. Only the innermost counts.
    expect(
      sumAriaUnread([lbl('7 unread messages', true), lbl('5 unread messages'), lbl('2 unread messages')])
    ).toBe(7)
  })

  it('returns null when the page makes no such claim, so the title still applies', () => {
    // Null means "fall back", never "zero" — most of the web says nothing here.
    expect(sumAriaUnread([])).toBeNull()
    expect(sumAriaUnread([lbl('Search'), lbl('Profile photo')])).toBeNull()
  })

  it('ignores a zero or malformed claim rather than badging it', () => {
    expect(sumAriaUnread([lbl('0 unread messages')])).toBeNull()
    expect(sumAriaUnread([lbl('no unread messages')])).toBeNull()
  })
})

describe('the unit travels with the number', () => {
  beforeEach(() => {
    useAppNotifications.setState({ counts: {}, status: {} })
  })

  it('reads the unit out of a title that states one', () => {
    expect(titleUnitOf('Inbox - 5 unread messages')).toBe('messages')
    expect(titleUnitOf('3 unread chats')).toBe('conversations')
  })

  it('calls a bare "(3)" unknown rather than guessing conversations', () => {
    // It usually IS conversations, but "usually" is not a claim worth making
    // about someone's inbox — so the tooltip stays vague instead of wrong.
    expect(titleUnitOf('(3) Inbox')).toBe('unknown')
    expect(titleUnitOf('Slack (12)')).toBe('unknown')
  })

  it('a message-level count is NOT overwritten by a later title', () => {
    // The precedence that makes the fix stick: the DOM read is the better
    // answer, so a thread count arriving afterwards must not clobber it.
    const s = useAppNotifications.getState()
    s.reportCount('a', 5, 'messages')
    s.report('a', '(1) WhatsApp')
    expect(useAppNotifications.getState().countFor('a')).toBe(5)
    expect(useAppNotifications.getState().unitFor('a')).toBe('messages')
  })

  it('does NOT freeze forever if the app stops publishing per-thread counts', () => {
    // The staleness trap in the precedence rule: a message count outranks the
    // title, so if an app changed its markup the badge would sit on a number
    // nothing could refresh. A live check that finds no labels hands the lead
    // back — keeping the number it saw, but stopping it outranking the title.
    const s = useAppNotifications.getState()
    s.reportCount('a', 5, 'messages')
    s.releaseMessageClaim('a')
    expect(useAppNotifications.getState().countFor('a')).toBe(5)
    expect(useAppNotifications.getState().unitFor('a')).toBe('unknown')
    s.report('a', '(2) Chat')
    expect(useAppNotifications.getState().countFor('a')).toBe(2)
  })

  it('releasing is a no-op when there was no message claim', () => {
    const s = useAppNotifications.getState()
    s.reportCount('b', 3, 'unknown')
    s.releaseMessageClaim('b')
    expect(useAppNotifications.getState().countFor('b')).toBe(3)
    s.releaseMessageClaim('never-seen')
    expect(useAppNotifications.getState().countFor('never-seen')).toBe(0)
  })

  it('the host hands the lead back when a live check finds no labels', () => {
    const host = read('renderer/src/components/AppNotificationHost.tsx')
    expect(host).toContain('store.releaseMessageClaim(app.id)')
  })

  it('still clears when the app says the count is gone', () => {
    const s = useAppNotifications.getState()
    s.reportCount('a', 5, 'messages')
    s.reportCount('a', null, 'messages')
    expect(useAppNotifications.getState().countFor('a')).toBe(0)
  })

  it('survives a restart with its unit intact', () => {
    // Dropping the unit on reload would turn a known message count back into
    // an unlabelled number, which is the bug this field exists to stop.
    const store = read('renderer/src/stores/appNotifications.ts')
    expect(store).toContain("v.unit === 'messages' || v.unit === 'conversations' ? v.unit : 'unknown'")
  })
})

describe('the badge says which thing it counted', () => {
  // 4.3.32: Tile moved to nav/menuParts.tsx (shared with the Widgets section).
  const accordion = read('renderer/src/components/nav/AreaAccordion.tsx') + read('renderer/src/components/nav/menuParts.tsx')

  it('names messages or conversations instead of a bare "unread"', () => {
    expect(accordion).toContain("${badge} unread ${badge === 1 ? 'message' : 'messages'}")
    expect(accordion).toContain("with unread")
  })

  it('falls back to plain "unread" when the unit is genuinely unknown', () => {
    expect(accordion).toContain('`${badge} unread`')
  })

  it('passes the unit through from the store', () => {
    expect(accordion).toContain("unit={unreadCounts[app.id]?.unit ?? 'unknown'}")
  })
})

describe('the message sum stays generic', () => {
  it('uses the ARIA standard, not per-app selectors', () => {
    const host = read('renderer/src/components/AppNotificationHost.tsx')
    expect(host).toContain("querySelectorAll('[aria-label]')")
    expect(host).toContain('containsAnother')
  })

  it('still names no app in the code', () => {
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const store = stripComments(read('renderer/src/stores/appNotifications.ts')).toLowerCase()
    const host = stripComments(read('renderer/src/components/AppNotificationHost.tsx')).toLowerCase()
    for (const brand of ['whatsapp', 'gmail', 'slack', 'notion', 'figma', 'outlook']) {
      expect(store, `store branches on ${brand}`).not.toContain(brand)
      expect(host, `host branches on ${brand}`).not.toContain(brand)
    }
  })
})

// ── The polling must not compound over a long session ─────────────────────
// A session left open overnight with 17 connected apps died with a native
// abort — no JS error, nothing in crash_events, just a SIGTRAP .ips. The
// scheduler below is the part that could plausibly produce that: it mounts a
// real <webview> guest per probe, so anything that makes it run more often
// than intended multiplies renderer processes for hours.

describe('the notification scheduler is pure where React requires it', () => {
  const host = read('renderer/src/components/AppNotificationHost.tsx')

  it('never mutates the queue or schedules timers inside a setState updater', () => {
    // React may invoke an updater more than once per update, and requires it
    // to be pure. The old version shifted `queue.current` AND called
    // setTimeout from in there: invoked twice it dropped an app from the
    // round and could leave a second round timer running, which then pumps
    // twice as often — compounding for as long as the app stays open.
    const updaters = host.match(/setActive\(\([^)]*\)\s*=>\s*\{[\s\S]*?\n  {0,6}\}\)/g) ?? []
    for (const u of updaters) {
      expect(u, 'setTimeout inside a setState updater').not.toContain('setTimeout')
      expect(u, 'queue mutation inside a setState updater').not.toContain('queue.current.shift')
    }
  })

  it('decides against a ref, then sets plain state', () => {
    expect(host).toContain('const activeRef = useRef<string[]>([])')
    expect(host).toContain('const cur = activeRef.current')
    expect(host).toContain('setActive(next)')
  })

  it('schedules at most one round timer', () => {
    expect(host).toContain('if (roundTimer.current === null) {')
  })

  it('tears down in-flight probes when the watched set changes', () => {
    // Otherwise a guest stays mounted with nothing left to retire it.
    expect(host).toContain('activeRef.current = []')
    expect(host).toContain('setActive([])')
  })

  it('still holds at most SLOTS probes at once', () => {
    expect(host).toContain('if (cur.length >= SLOTS) return')
    expect(host).toContain('while (next.length < SLOTS')
  })
})
