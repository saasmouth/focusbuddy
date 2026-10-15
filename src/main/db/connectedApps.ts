import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import type {
  ConnectedApp,
  ConnectedAppDraft,
  ConnectedAppKind,
  ConnectedAppPatch
} from '@shared/types'

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
  created_at: number
  updated_at: number
}

function rowToApp(row: AppRow): ConnectedApp {
  return {
    id: row.id,
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
      'SELECT * FROM connected_apps WHERE org_id = ? ORDER BY sort_order ASC, created_at ASC'
    )
    .all(getActiveOrgId()) as AppRow[]
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
  const row = db
    .prepare('SELECT * FROM connected_apps WHERE id = ?')
    .get(id) as AppRow
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
      .prepare('SELECT * FROM connected_apps WHERE id = ?')
      .get(id) as AppRow | undefined
    return row ? rowToApp(row) : null
  }
  fields.push('updated_at = @now')
  db.prepare(`UPDATE connected_apps SET ${fields.join(', ')} WHERE id = @id`).run(
    params
  )
  const row = db
    .prepare('SELECT * FROM connected_apps WHERE id = ?')
    .get(id) as AppRow | undefined
  return row ? rowToApp(row) : null
}

export function deleteConnectedApp(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM connected_apps WHERE id = ?').run(id)
  return result.changes > 0
}

export function reorderConnectedApps(orderedIds: string[]): void {
  const db = getDb()
  const tx = db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE connected_apps SET sort_order = @order, updated_at = @now WHERE id = @id'
    )
    const now = Date.now()
    orderedIds.forEach((id, i) => stmt.run({ order: i, now, id }))
  })
  tx()
}

// Bump usage counters. Called every time the user opens an app full-pane,
// drags it to the canvas, or focuses the canvas widget bound to it. Feeds the
// recency × frequency sort.
export function touchConnectedApp(id: string): ConnectedApp | null {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `UPDATE connected_apps
        SET use_count = use_count + 1,
            last_used_at = @now,
            updated_at = @now
      WHERE id = @id`
  ).run({ id, now })
  const row = db
    .prepare('SELECT * FROM connected_apps WHERE id = ?')
    .get(id) as AppRow | undefined
  return row ? rowToApp(row) : null
}

// Look up a Connected App by hostname (any URL whose hostname matches).
// Used by "Add to Connected Apps" so we don't create duplicates when the user
// hits the button on a URL we already track.
export function findConnectedAppByHostname(hostname: string): ConnectedApp | null {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM connected_apps').all() as AppRow[]
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
