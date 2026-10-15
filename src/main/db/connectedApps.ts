import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId, PERSONAL_ORG_ID } from './activeOrg'
import type {
  ConnectedApp,
  ConnectedAppDraft,
  ConnectedAppKind,
  ConnectedAppPatch
} from '@shared/types'

// Connected apps belong to an ORGANISATION, not to the install.
//
// WHY. The same app is a different account in each org you work in — your own
// Slack, the client's Slack, the agency's Slack. A connected app carries a
// vault binding and a signed-in webview session, so getting this scope wrong
// does not merely show the wrong tile: it points one org's credentials at
// another org's workspace. That is why every statement below is scoped, not
// just the listing.
//
// PERSONAL IS THE AGGREGATE. The reserved 'personal' org is the one account
// that belongs to the human rather than to a company, so it is the one place
// that sees everything — their own apps plus whatever they connected inside
// each org, labelled with where it came from. A real org never aggregates: in
// it you see that org's apps and nothing else.
//
// Everything created while an org is active belongs to that org, including
// anything created from Personal, which belongs to Personal.

/**
 * The clause that limits a statement to rows the active org may touch.
 *
 * One clause with one always-bound parameter, rather than two shapes of SQL:
 * `@scopeOrg` is null in Personal (which sees everything) and the org id
 * otherwise. Written this way because better-sqlite3 rejects a named parameter
 * the statement does not use, so a clause that sometimes drops its placeholder
 * would throw at runtime in exactly the aggregate case.
 */
const ORG_SCOPE = '(@scopeOrg IS NULL OR org_id = @scopeOrg)'

function scopeOrg(): string | null {
  const org = getActiveOrgId()
  return org === PERSONAL_ORG_ID ? null : org
}

interface AppRow {
  id: string
  title: string
  url: string
  icon: string
  color: string | null
  sort_order: number
  use_count: number
  last_used_at: number | null
  pinned: number
  vault_entry_id: string | null
  notifications: number
  autofill_enabled: number
  kind: string | null
  app_path: string | null
  bundle_id: string | null
  icon_png_base64: string | null
  org_id: string | null
  created_at: number
  updated_at: number
}

function rowToApp(row: AppRow): ConnectedApp {
  return {
    id: row.id,
    // Which org this app belongs to. Surfaced because in the Personal
    // aggregate the same app appears once per org, and an unlabelled duplicate
    // is worse than no aggregation at all.
    orgId: row.org_id ?? PERSONAL_ORG_ID,
    title: row.title,
    url: row.url,
    icon: row.icon,
    color: row.color,
    sortOrder: row.sort_order,
    kind: (row.kind ?? 'web') as ConnectedAppKind,
    appPath: row.app_path,
    bundleId: row.bundle_id,
    iconPngBase64: row.icon_png_base64,
    pinned: row.pinned === 1,
    useCount: row.use_count ?? 0,
    lastUsedAt: row.last_used_at,
    vaultEntryId: row.vault_entry_id,
    // Older rows predate the column; the default is on.
    notifications: row.notifications === undefined ? true : row.notifications === 1,
    autofillEnabled: (row.autofill_enabled ?? 1) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listConnectedApps(): ConnectedApp[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM connected_apps WHERE ${ORG_SCOPE} ORDER BY sort_order ASC, created_at ASC`
    )
    .all({ scopeOrg: scopeOrg() }) as AppRow[]
  return rows.map(rowToApp)
}

function nextSortOrder(): number {
  const db = getDb()
  const row = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM connected_apps WHERE org_id = ?')
    .get(getActiveOrgId()) as { next: number }
  return row.next
}

export function createConnectedApp(draft: ConnectedAppDraft): ConnectedApp {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO connected_apps (
       id, title, url, icon, color, sort_order,
       use_count, last_used_at, pinned, vault_entry_id, notifications, autofill_enabled,
       kind, app_path, bundle_id, icon_png_base64,
       created_at, updated_at, org_id
     )
     VALUES (
       @id, @title, @url, @icon, @color, @sortOrder,
       0, NULL, @pinned, @vaultEntryId, @notifications, 1,
       @kind, @appPath, @bundleId, @iconPngBase64,
       @now, @now, @orgId
     )`
  ).run({
    id,
    title: draft.title,
    url: draft.url,
    icon: draft.icon ?? 'apps',
    color: draft.color ?? null,
    sortOrder: nextSortOrder(),
    pinned: draft.pinned ? 1 : 0,
    notifications: draft.notifications === false ? 0 : 1,
    vaultEntryId: draft.vaultEntryId ?? null,
    kind: draft.kind ?? 'web',
    appPath: draft.appPath ?? null,
    bundleId: draft.bundleId ?? null,
    iconPngBase64: draft.iconPngBase64 ?? null,
    orgId: getActiveOrgId(),
    now
  })
  // Scoped like every other read, so the property holds everywhere rather
  // than "everywhere except the one we know is safe".
  const row = db
    .prepare(`SELECT * FROM connected_apps WHERE id = @id AND ${ORG_SCOPE}`)
    .get({ id, scopeOrg: scopeOrg() }) as AppRow
  return rowToApp(row)
}

export function updateConnectedApp(
  id: string,
  patch: ConnectedAppPatch
): ConnectedApp | null {
  const db = getDb()
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  if (patch.title !== undefined) {
    fields.push('title = @title')
    params.title = patch.title
  }
  if (patch.url !== undefined) {
    fields.push('url = @url')
    params.url = patch.url
  }
  if (patch.icon !== undefined) {
    fields.push('icon = @icon')
    params.icon = patch.icon
  }
  if (patch.color !== undefined) {
    fields.push('color = @color')
    params.color = patch.color
  }
  if (patch.notifications !== undefined) {
    fields.push('notifications = @notifications')
    params.notifications = patch.notifications ? 1 : 0
  }
  if (patch.pinned !== undefined) {
    fields.push('pinned = @pinned')
    params.pinned = patch.pinned ? 1 : 0
  }
  if (patch.vaultEntryId !== undefined) {
    fields.push('vault_entry_id = @vaultEntryId')
    params.vaultEntryId = patch.vaultEntryId
  }
  if (patch.autofillEnabled !== undefined) {
    fields.push('autofill_enabled = @autofillEnabled')
    params.autofillEnabled = patch.autofillEnabled ? 1 : 0
  }
  if (patch.appPath !== undefined) {
    fields.push('app_path = @appPath')
    params.appPath = patch.appPath
  }
  if (patch.bundleId !== undefined) {
    fields.push('bundle_id = @bundleId')
    params.bundleId = patch.bundleId
  }
  if (patch.iconPngBase64 !== undefined) {
    fields.push('icon_png_base64 = @iconPngBase64')
    params.iconPngBase64 = patch.iconPngBase64
  }
  if (fields.length === 0) {
    const row = db
      .prepare(`SELECT * FROM connected_apps WHERE id = @id AND ${ORG_SCOPE}`)
      .get({ id, scopeOrg: scopeOrg() }) as AppRow | undefined
    return row ? rowToApp(row) : null
  }
  fields.push('updated_at = @now')
  // Scoped: an id from another org cannot be mutated from inside this one.
  // Personal is the aggregate, so it can edit what it can see.
  const org = scopeOrg()
  db.prepare(
    `UPDATE connected_apps SET ${fields.join(', ')} WHERE id = @id AND ${ORG_SCOPE}`
  ).run({ ...params, scopeOrg: org })
  const row = db
    .prepare(`SELECT * FROM connected_apps WHERE id = @id AND ${ORG_SCOPE}`)
    .get({ id, scopeOrg: org }) as AppRow | undefined
  return row ? rowToApp(row) : null
}

export function deleteConnectedApp(id: string): boolean {
  const db = getDb()
  const result = db
    .prepare(`DELETE FROM connected_apps WHERE id = @id AND ${ORG_SCOPE}`)
    .run({ id, scopeOrg: scopeOrg() })
  return result.changes > 0
}

export function reorderConnectedApps(orderedIds: string[]): void {
  const db = getDb()
  const org = scopeOrg()
  const tx = db.transaction(() => {
    const stmt = db.prepare(
      `UPDATE connected_apps SET sort_order = @order, updated_at = @now
        WHERE id = @id AND ${ORG_SCOPE}`
    )
    const now = Date.now()
    orderedIds.forEach((id, i) => stmt.run({ order: i, now, id, scopeOrg: org }))
  })
  tx()
}

// Bump usage counters. Called every time the user opens an app full-pane,
// drags it to the canvas, or focuses the canvas widget bound to it. Feeds the
// recency × frequency sort.
export function touchConnectedApp(id: string): ConnectedApp | null {
  const db = getDb()
  const now = Date.now()
  const org = scopeOrg()
  db.prepare(
    `UPDATE connected_apps
        SET use_count = use_count + 1,
            last_used_at = @now,
            updated_at = @now
      WHERE id = @id AND ${ORG_SCOPE}`
  ).run({ id, now, scopeOrg: org })
  const row = db
    .prepare(`SELECT * FROM connected_apps WHERE id = @id AND ${ORG_SCOPE}`)
    .get({ id, scopeOrg: org }) as AppRow | undefined
  return row ? rowToApp(row) : null
}

// Look up a Connected App by hostname (any URL whose hostname matches).
// Used by "Add to Connected Apps" so we don't create duplicates when the user
// hits the button on a URL we already track.
//
// SCOPED, and this one matters most. Unscoped, connecting slack.com inside the
// client's org would find the app you connected in your own org and quietly
// reuse it — same row, same vault binding, same signed-in session. The user
// would believe they had connected a second account and would in fact be
// looking at the first. Two orgs having their own Slack is the normal case, so
// a match only counts within the org asking.
export function findConnectedAppByHostname(hostname: string): ConnectedApp | null {
  const db = getDb()
  const org = getActiveOrgId()
  // Personal aggregates for READING, but a dedupe decision is about where the
  // new row would be created — which is always the active org — so Personal
  // matches only its own rows here.
  const rows = db
    .prepare('SELECT * FROM connected_apps WHERE org_id = ?')
    .all(org) as AppRow[]
  const needle = hostname.replace(/^www\./, '').toLowerCase()
  for (const row of rows) {
    try {
      const h = new URL(row.url).hostname.replace(/^www\./, '').toLowerCase()
      if (h === needle) return rowToApp(row)
    } catch {
      // ignore malformed URL
    }
  }
  return null
}
