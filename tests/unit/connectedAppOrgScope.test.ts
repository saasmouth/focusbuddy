import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Connected apps belong to an ORGANISATION.
//
// "Sometimes different people have different logins to the same apps for
// different organisations, connected apps should be at the organisation level,
// only personal accounts should aggregate them all under the ownership of one
// user as the master of the account."
//
// The listing was already org-scoped. Every by-id mutation was NOT, and that is
// what these tests are really about: a connected app carries a vault binding
// and a signed-in webview session, so an unscoped statement does not merely
// show the wrong tile — it points one org's credentials at another org's
// workspace.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const db = read('main/db/connectedApps.ts')
const types = read('shared/types.ts')
// 4.3.32: the Tile, TileGrid and SubHeading the accordion draws moved to
// nav/menuParts.tsx so the new Widgets section could share them. The menu is
// still one menu, so its source is read as the two files together.
const accordion =
  read('renderer/src/components/nav/AreaAccordion.tsx') + '\n' + read('renderer/src/components/nav/menuParts.tsx')

/** Every SQL statement in the module, as one string per statement. */
function statements(src: string): string[] {
  const out: string[] = []
  const re = /\.prepare\(\s*(`[\s\S]*?`|'[^']*')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}

describe('every statement that touches connected_apps is scoped', () => {
  const sql = statements(db)

  it('finds the statements at all, so this test cannot pass vacuously', () => {
    expect(sql.length).toBeGreaterThanOrEqual(8)
  })

  it('no statement reaches rows outside the active org', () => {
    // The property, stated once: every statement that SELECTS, UPDATEs or
    // DELETEs either carries the org scope clause or filters org_id directly.
    // Nothing is org-blind. (An INSERT stamps rather than filters — see below.)
    for (const s of sql.filter((x) => !/INSERT/.test(x))) {
      const scoped = s.includes('ORG_SCOPE') || /org_id\s*=\s*[?@]/.test(s)
      expect(scoped, `unscoped statement: ${s.slice(0, 90)}`).toBe(true)
    }
  })

  it('an INSERT stamps the active org onto the new row', () => {
    const inserts = sql.filter((x) => /INSERT/.test(x))
    expect(inserts.length).toBeGreaterThanOrEqual(1)
    for (const s of inserts) {
      expect(s).toContain('org_id')
      expect(s).toContain('@orgId')
    }
    // Always the ACTIVE org — including from Personal, which owns what it
    // creates rather than creating on another org's behalf.
    expect(db).toContain('orgId: getActiveOrgId()')
  })

  it('scopes the WRITES, which is where it actually mattered', () => {
    const writes = sql.filter((s) => /UPDATE|DELETE/.test(s))
    expect(writes.length).toBeGreaterThanOrEqual(4)
    for (const s of writes) {
      expect(s.includes('ORG_SCOPE'), `unscoped write: ${s.slice(0, 90)}`).toBe(true)
    }
  })
})

describe('the scope clause survives the aggregate case', () => {
  it('uses ONE clause with an always-bound parameter', () => {
    // better-sqlite3 throws on a named parameter the statement does not use,
    // so a clause that drops its placeholder in Personal would fail at
    // runtime in exactly the aggregate case. One clause, always bound.
    expect(db).toContain("const ORG_SCOPE = '(@scopeOrg IS NULL OR org_id = @scopeOrg)'")
  })

  it('binds null for Personal and the id otherwise', () => {
    expect(db).toContain('return org === PERSONAL_ORG_ID ? null : org')
  })

  it('never builds two different shapes of SQL per case', () => {
    expect(db).not.toContain("where: '1 = 1'")
    expect(db).not.toContain(".replace('?', '@scopeOrg')")
  })
})

describe('Personal is the aggregate; an org is not', () => {
  it('Personal lists every app, an org only its own', () => {
    expect(db).toContain('PERSONAL IS THE AGGREGATE')
    expect(db).toContain('function scopeOrg(): string | null')
  })

  it('a dedupe match is confined to the org the row would be created in', () => {
    // The sharpest version of the bug: connecting slack.com inside the
    // client's org must not find the Slack you connected in your own org and
    // silently reuse its row, its vault binding and its session. Two orgs
    // having their own Slack is the normal case.
    expect(db).toContain("'SELECT * FROM connected_apps WHERE org_id = ?'")
    expect(db).toContain('Personal aggregates for READING')
  })

  it('an app says which org it belongs to', () => {
    expect(types).toContain('orgId: string')
    expect(db).toContain('orgId: row.org_id ?? PERSONAL_ORG_ID')
  })
})

describe('the side menu says whose account it is showing', () => {
  it('the heading names the active org', () => {
    expect(accordion).toContain("label={isPersonal ? 'Connected apps — all accounts' : `Connected apps — ${orgName ?? 'this org'}`}")
  })

  it('labels each tile with its org, but only in the aggregate', () => {
    // Inside an org every tile is that org's, so the label would be noise.
    expect(accordion).toContain('note={isPersonal ? orgLabel(app.orgId) : undefined}')
    expect(accordion).toContain('data-testid="nav-tile-note"')
  })

  it('an unlabelled duplicate is never shown', () => {
    expect(accordion).toContain('the same app can appear once per')
  })
})

describe('adding a connected app from the menu', () => {
  it('has its own + beside the Connected apps heading', () => {
    expect(accordion).toContain('data-testid="nav-add-connected-app"')
    expect(accordion).toContain('setAddAppOpen(true)')
  })

  it('says which org it will connect to before you click it', () => {
    expect(accordion).toContain("`Connect an app to ${orgName ?? 'this organisation'}`")
  })

  it('opens the same dialog the rest of the app uses', () => {
    // Not a second connect flow: the dialog already captures credentials to
    // the vault and the notifications opt-out.
    expect(accordion).toContain("import AddConnectedAppDialog from '../AddConnectedAppDialog'")
    expect(accordion).toContain('<AddConnectedAppDialog')
  })

  it('the dialog says which account it will connect to', () => {
    const dialog = read('renderer/src/components/AddConnectedAppDialog.tsx')
    expect(dialog).toContain('data-testid="connect-target-org"')
    expect(dialog).toContain("'Connecting to your personal account'")
    expect(dialog).toContain('`Connecting to ${targetOrgName}`')
  })

  it('goes to the app it just connected', () => {
    expect(accordion).toContain('onAdded={(id) => {')
    expect(accordion).toContain('goConnectedApp(id)')
  })
})
