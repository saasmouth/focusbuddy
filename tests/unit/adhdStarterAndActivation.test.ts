// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/plexii-activation-test' } }))
vi.mock('../../src/main/db/database', () => ({
  getDb: () => {
    throw new Error('activation tests pass a database in')
  }
}))

import { hasChecklist } from '../../src/renderer/src/lib/stickyText'
import {
  ADHD_STARTER_DESK_DESCRIPTION,
  ADHD_STARTER_DESK_TITLE,
  ADHD_STARTER_WIDGETS,
  decideStarterProvision,
  isUntouchedStarterWorkspace,
  starterWidgetDrafts
} from '../../src/shared/adhdStarterDesk'
import {
  activationForTelemetry,
  attributionFromArgv,
  attributionFromUrl,
  isLaterLocalDay,
  mergeAttribution,
  sanitizeAttribution
} from '../../src/shared/activationEvents'
import {
  activationTelemetry,
  noteActivation,
  noteAppOpen,
  noteFirstUserDesk,
  parseActivationState,
  readActivationState,
  type ActivationState
} from '../../src/main/db/activation'

function memoryDb(): { raw: DatabaseSync; db: NonNullable<Parameters<typeof noteAppOpen>[2]> } {
  const raw = new DatabaseSync(':memory:')
  raw.exec('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const db = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql)
      return {
        get: (key: string) => stmt.get(key) as unknown,
        run: (key: string, value: string) => {
          stmt.run(key, value)
        }
      }
    }
  }
  return { raw, db }
}

describe('ADHD Starter Desk', () => {
  it('is a real desk: top 3, a brain dump, a focus checklist, and a 25-minute timer', () => {
    expect(ADHD_STARTER_DESK_TITLE).toBe('ADHD Starter Desk')
    expect(ADHD_STARTER_DESK_DESCRIPTION).toContain('Brain calm in 30 seconds')
    const titles = ADHD_STARTER_WIDGETS.map((w) => w.title)
    expect(titles).toEqual(["Today's Top 3", 'Quick brain dump', 'Focus block', '25-minute focus'])
    const top3 = ADHD_STARTER_WIDGETS[0]
    const dump = ADHD_STARTER_WIDGETS[1]
    const focus = ADHD_STARTER_WIDGETS[2]
    const timer = ADHD_STARTER_WIDGETS[3]
    expect(hasChecklist(top3.content)).toBe(true)
    expect(hasChecklist(focus.content)).toBe(true)
    expect(dump.content).toContain('Nothing here is a commitment')
    expect(JSON.parse(timer.content)).toMatchObject({ targetSec: 1500, state: 'idle' })
    const drafts = starterWidgetDrafts('desk-1')
    expect(drafts).toHaveLength(4)
    expect(drafts.every((d) => d.taskId === 'desk-1' && d.content.length > 0)).toBe(true)
    // The welcome copy is the product's, not the person's.
    const blob = JSON.stringify(ADHD_STARTER_WIDGETS)
    expect(blob).not.toMatch(/@/)
  })

  it('treats a workspace that is only the starter desk as still new', () => {
    expect(isUntouchedStarterWorkspace([{ id: 's', kind: 'task' }], 's')).toBe(true)
    expect(isUntouchedStarterWorkspace([{ id: 's', kind: 'task' }, { id: 'other', kind: 'task' }], 's')).toBe(false)
    expect(isUntouchedStarterWorkspace([{ id: 'room', kind: 'folder' }], 's')).toBe(false)
    expect(isUntouchedStarterWorkspace([], 's')).toBe(false)
    expect(isUntouchedStarterWorkspace([{ id: 's', kind: 'task', archived: true }], 's')).toBe(false)
  })

  it('provisions only a settled, empty, first install', () => {
    const base = {
      harness: false,
      firstInstall: true,
      decision: null,
      starterStillExists: false,
      hasOtherWork: false,
      syncSettled: true
    }
    expect(decideStarterProvision(base)).toBe('provision')
    expect(decideStarterProvision({ ...base, harness: true })).toBe('skip')
    expect(decideStarterProvision({ ...base, firstInstall: false })).toBe('skip')
    expect(decideStarterProvision({ ...base, hasOtherWork: true })).toBe('skip')
    expect(decideStarterProvision({ ...base, syncSettled: false })).toBe('wait')
    expect(decideStarterProvision({ ...base, decision: 'skipped' })).toBe('skip')
    expect(
      decideStarterProvision({ ...base, decision: 'provisioned', starterStillExists: true, hasOtherWork: true })
    ).toBe('open')
    expect(decideStarterProvision({ ...base, decision: 'provisioned', starterStillExists: false })).toBe('skip')
  })
})

describe('activation events', () => {
  it('keeps installer and UTM codes and drops secrets', () => {
    const fromUrl = attributionFromUrl(
      'plexii://auth?token=sekret&email=a@b.co&utm_source=newsletter&utm_campaign=launch&utm_medium=email'
    )
    expect(fromUrl).toEqual({ utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'launch' })
    expect(JSON.stringify(fromUrl)).not.toContain('sekret')
    expect(JSON.stringify(fromUrl)).not.toContain('a@b.co')
    expect(sanitizeAttribution({ utm_source: 'https://evil.example/x', installer: '../tmp/x' })).toBeNull()
    expect(sanitizeAttribution({ installer: 'dmg', utm_source: 'site' })).toEqual({
      installer: 'dmg',
      utmSource: 'site'
    })
    expect(
      attributionFromArgv(['--utm-source=winget', 'plexii://open?utm_campaign=spring&token=nope'])
    ).toEqual({ utmSource: 'winget', utmCampaign: 'spring' })
    expect(mergeAttribution({ utmSource: 'first' }, { utmSource: 'second', utmMedium: 'cpc' })).toEqual({
      utmSource: 'first',
      utmMedium: 'cpc'
    })
  })

  it('day 2 is the next local calendar day', () => {
    const morning = new Date(2026, 10, 13, 9, 0, 0).getTime()
    const later = new Date(2026, 10, 13, 23, 30, 0).getTime()
    const next = new Date(2026, 10, 14, 0, 5, 0).getTime()
    expect(isLaterLocalDay(morning, later)).toBe(false)
    expect(isLaterLocalDay(morning, next)).toBe(true)
  })

  it('stamps a new install once, counts a later return, and leaves an upgrade alone', () => {
    const { db } = memoryDb()
    const first = new Date(2026, 10, 13, 8, 0, 0).getTime()
    const sameDay = new Date(2026, 10, 13, 20, 0, 0).getTime()
    const nextDay = new Date(2026, 10, 14, 8, 0, 0).getTime()
    noteAppOpen(true, first, db)
    noteAppOpen(true, sameDay, db)
    let state = readActivationState(db)
    expect(state.cohort).toBe('new')
    expect(state.events.map((e) => e.name)).toEqual(['app_first_launch'])
    noteAppOpen(true, nextDay, db)
    state = readActivationState(db)
    expect(state.events.map((e) => e.name)).toEqual(['app_first_launch', 'day2_return'])

    const upgrade = memoryDb().db
    noteAppOpen(false, first, upgrade)
    noteAppOpen(false, nextDay, upgrade)
    expect(readActivationState(upgrade).events).toEqual([])
    expect(readActivationState(upgrade).cohort).toBe('existing')
  })

  it('records the starter-adjacent funnel without private fields in the snapshot', () => {
    const { db } = memoryDb()
    noteAppOpen(true, 1_000, db)
    noteFirstUserDesk('desk-user', 2_000, db)
    noteFirstUserDesk('desk-user', 3_000, db)
    noteActivation('pro_upgrade_clicked', 4_000, db)
    noteActivation('pro_upgrade_clicked', 5_000, db)
    const state = readActivationState(db)
    expect(state.events.find((e) => e.name === 'first_user_desk_created')?.count).toBe(1)
    expect(state.events.find((e) => e.name === 'pro_upgrade_clicked')?.count).toBe(2)
    const wire = activationTelemetry(db)
    expect(wire.events.map((e) => e.name)).toEqual([
      'app_first_launch',
      'first_user_desk_created',
      'pro_upgrade_clicked'
    ])
    expect(JSON.stringify(wire)).not.toContain('desk-user')
  })

  it('does not count a desk on an install that already had work', () => {
    const { db } = memoryDb()
    noteAppOpen(false, 1_000, db)
    noteFirstUserDesk('desk-user', 2_000, db)
    expect(readActivationState(db).events).toEqual([])
  })

  it('refuses a tampered ledger entry that is not an activation event', () => {
    const parsed = parseActivationState({
      cohort: 'new',
      events: [
        { name: 'app_first_launch', at: 5, count: 1 },
        { name: 'typed_a_password', at: 6, count: 1 },
        { name: 'starter_desk_loaded', at: 7, count: 1 }
      ],
      starterDeskId: 'local-only',
      attribution: { utmSource: 'ok', email: 'nope@x.co' }
    })
    expect(parsed.events.map((e) => e.name)).toEqual(['app_first_launch', 'starter_desk_loaded'])
    const wire = activationForTelemetry(parsed.events, parsed.attribution)
    expect(wire.attribution).toEqual({ utmSource: 'ok' })
    expect(JSON.stringify(wire)).not.toContain('local-only')
    expect(JSON.stringify(wire)).not.toContain('nope@')
  })

  it('round-trips the ledger', () => {
    const { db } = memoryDb()
    noteAppOpen(true, 10, db)
    const again = readActivationState(db)
    const expected: ActivationState = {
      cohort: 'new',
      events: [{ name: 'app_first_launch', at: 10, count: 1 }],
      attribution: null,
      starterDeskId: null,
      starterDecision: null
    }
    expect(again).toEqual(expected)
  })
})
