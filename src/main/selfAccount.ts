import { getDb } from './db/database'

// Who is signed in, as the main process needs to know it (DEC-144).
//
// The session lives in the renderer (stores/account), and main never saw an
// account id. Team-workspace Focus needs one in main: a task is stamped with
// who raised it, and the Focus list, badge and counts in a team workspace show
// the tasks assigned to YOU. So the renderer publishes the id on sign-in and
// clears it on sign-out, and it is kept in sync_meta (beside the active org)
// so it is already known at the next launch, before the renderer has booted.
//
// Null means signed out. Personal-workspace Focus does not depend on it.

const META_KEY = 'self_account_id'
let cached: string | null | undefined

export function getSelfAccountId(): string | null {
  if (cached !== undefined) return cached
  try {
    const row = getDb().prepare('SELECT value FROM sync_meta WHERE key = ?').get(META_KEY) as
      | { value: string }
      | undefined
    cached = row?.value || null
  } catch {
    cached = null
  }
  return cached
}

export function setSelfAccountId(accountId: string | null): string | null {
  const next = typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null
  const db = getDb()
  if (next) {
    db.prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(META_KEY, next)
  } else {
    db.prepare('DELETE FROM sync_meta WHERE key = ?').run(META_KEY)
  }
  cached = next
  return next
}
