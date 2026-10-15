import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unreadFromTitle, useAppNotifications } from '../../src/renderer/src/stores/appNotifications'

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
