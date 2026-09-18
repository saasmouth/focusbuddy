import { randomUUID } from 'crypto'
import { getDb } from './database'
import type { InboxRules, MailTag, MailTagDraft, MailTagPatch } from '@shared/types'

// Where a user's mail tags live.
//
// A tag is a saved criterion, not a drawer (see the note on MailTag in
// shared/types.ts). Nothing here touches the mail server: these rows describe
// how to LOOK at INBOX, which is what lets a message sit in two tags, lets a
// tag be deleted with no consequence, and keeps a mis-typed rule from being
// destructive.
//
// `rules` is stored as JSON text. The main process is the persistence layer for
// tags and has no business knowing what a rule means -- the renderer owns
// that vocabulary (lib/inboxFilter.ts), and keeping the semantics on one side
// means adding a rule kind does not require a migration here.

export function ensureMailTagSchema(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      colour TEXT NOT NULL DEFAULT 'sky',
      -- InboxRules as JSON. Opaque here on purpose; see the note above.
      rules TEXT NOT NULL DEFAULT '{}',
      -- The desk or task this tag is about, when it is about one.
      --
      -- ON DELETE SET NULL, NOT CASCADE, and the difference matters: deleting a
      -- desk must never silently destroy somebody's mail categorisation. The
      -- tag survives and merely stops being about that desk.
      node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      -- Comma-separated uids forced in / forced out, overriding the rules.
      pinned TEXT NOT NULL DEFAULT '',
      excluded TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_folders_node ON mail_folders (node_id);
    CREATE INDEX IF NOT EXISTS idx_mail_folders_sort ON mail_folders (sort_order);
  `)
}

interface Row {
  id: string
  name: string
  colour: string
  rules: string
  node_id: string | null
  pinned: string
  excluded: string
  sort_order: number
  created_at: number
  updated_at: number
}

/** Uids round-trip as a comma list; anything unparseable is dropped, not guessed. */
function parseUids(raw: string | null | undefined): number[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
}

const writeUids = (uids: readonly number[] | undefined): string =>
  [...new Set((uids ?? []).filter((n) => Number.isFinite(n)))].join(',')

function parseRules(raw: string | null | undefined): InboxRules {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as InboxRules
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
  } catch {
    // A corrupt rule blob becomes an empty rule, which files NOTHING. The other
    // direction -- treating it as "match everything" -- would quietly sweep the
    // whole inbox into one tag.
    return {}
  }
}

const toTag = (r: Row): MailTag => ({
  id: r.id,
  name: r.name,
  colour: r.colour || 'sky',
  rules: parseRules(r.rules),
  nodeId: r.node_id,
  pinned: parseUids(r.pinned),
  excluded: parseUids(r.excluded),
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listMailTags(): MailTag[] {
  return (
    getDb()
      .prepare('SELECT * FROM mail_folders ORDER BY sort_order, name COLLATE NOCASE')
      .all() as Row[]
  ).map(toTag)
}

/** The tags about one desk or task. */
export function listMailTagsForNode(nodeId: string): MailTag[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM mail_folders WHERE node_id = ? ORDER BY sort_order, name COLLATE NOCASE'
      )
      .all(nodeId) as Row[]
  ).map(toTag)
}

export function createMailTag(draft: MailTagDraft): MailTag {
  const id = randomUUID()
  const now = Date.now()
  // New tags go to the end rather than the top: an existing arrangement the
  // user made is not rearranged by adding to it.
  const next =
    ((
      getDb().prepare('SELECT MAX(sort_order) AS m FROM mail_folders').get() as
        | { m: number | null }
        | undefined
    )?.m ?? -1) + 1
  getDb()
    .prepare(
      `INSERT INTO mail_folders (id, name, colour, rules, node_id, pinned, excluded, sort_order, created_at, updated_at)
       VALUES (@id, @name, @colour, @rules, @nodeId, '', '', @sortOrder, @now, @now)`
    )
    .run({
      id,
      name: draft.name?.trim() || 'New tag',
      colour: draft.colour || 'sky',
      rules: JSON.stringify(draft.rules ?? {}),
      nodeId: draft.nodeId ?? null,
      sortOrder: next,
      now
    })
  return getMailTag(id)!
}

export function getMailTag(id: string): MailTag | null {
  const r = getDb().prepare('SELECT * FROM mail_folders WHERE id = ?').get(id) as Row | undefined
  return r ? toTag(r) : null
}

export function updateMailTag(id: string, patch: MailTagPatch): MailTag | null {
  const existing = getMailTag(id)
  if (!existing) return null
  // Only the fields actually present are written. A patch that mentions nothing
  // must not blank the tag out.
  const sets: string[] = []
  const args: Record<string, unknown> = { id, now: Date.now() }
  const put = (col: string, key: string, value: unknown): void => {
    sets.push(`${col} = @${key}`)
    args[key] = value
  }
  if (patch.name !== undefined) put('name', 'name', patch.name.trim() || existing.name)
  if (patch.colour !== undefined) put('colour', 'colour', patch.colour || 'sky')
  if (patch.rules !== undefined) put('rules', 'rules', JSON.stringify(patch.rules ?? {}))
  // null is a real value here: it means "stop being about that desk".
  if (patch.nodeId !== undefined) put('node_id', 'nodeId', patch.nodeId ?? null)
  if (patch.pinned !== undefined) put('pinned', 'pinned', writeUids(patch.pinned))
  if (patch.excluded !== undefined) put('excluded', 'excluded', writeUids(patch.excluded))
  if (patch.sortOrder !== undefined) put('sort_order', 'sortOrder', patch.sortOrder)
  if (sets.length === 0) return existing
  getDb()
    .prepare(`UPDATE mail_folders SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`)
    .run(args)
  return getMailTag(id)
}

export function deleteMailTag(id: string): boolean {
  // Deleting a tag deletes a VIEW. No mail is touched, on the server or
  // anywhere else, which is what makes this safe to offer without a warning.
  return (getDb().prepare('DELETE FROM mail_folders WHERE id = ?').run(id).changes ?? 0) > 0
}

/** Force a message into a tag the rules missed. */
export function pinToTag(id: string, uid: number): MailTag | null {
  const f = getMailTag(id)
  if (!f) return null
  return updateMailTag(id, {
    pinned: [...f.pinned, uid],
    // Pinning something previously excluded is a reversal of that decision, so
    // the exclusion has to go or the pin would be silently ignored.
    excluded: f.excluded.filter((u) => u !== uid)
  })
}

/** Force a message out of a tag the rules wrongly caught. */
export function excludeFromTag(id: string, uid: number): MailTag | null {
  const f = getMailTag(id)
  if (!f) return null
  return updateMailTag(id, {
    excluded: [...f.excluded, uid],
    pinned: f.pinned.filter((u) => u !== uid)
  })
}

/** Persist a new order for the tag list. Ids not named keep their place. */
export function reorderMailTags(ids: readonly string[]): MailTag[] {
  const db = getDb()
  const stmt = db.prepare('UPDATE mail_folders SET sort_order = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  ids.forEach((id, i) => stmt.run(i, now, id))
  return listMailTags()
}
