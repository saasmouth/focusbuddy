import { randomUUID } from 'crypto'
import { getDb } from './database'
import type { Contact, ContactDraft, ContactPatch } from '@shared/types'

// The people a workspace deals with.
//
// This is the table that did not exist. Org members live on the signal server
// and are fetched per session; everybody else -- a conveyancer, a photographer,
// a client's accountant -- had nowhere to live at all, so the contacts widget
// kept its own list inside one widget's content and no two desks could share a
// person. Half the people on any real piece of work are not in your org, and a
// directory that can only hold colleagues is not a directory.
//
// A contact here is a GUEST by default. An org member can also be recorded, in
// which case accountId points at them and the server stays the authority on
// name, role and access -- this row is only the workspace's own notes about
// somebody it already knows.

export function ensureContactsSchema(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      role TEXT,
      notes TEXT,
      -- 'guest' (external) or 'member' (mirrors an org account).
      kind TEXT NOT NULL DEFAULT 'guest',
      account_id TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email);

    -- Which desks a person is actually on. The link the "desk as a lens" idea
    -- needed and never had: without it a widget can only show a list it owns,
    -- and the same person on three desks is three unrelated rows.
    CREATE TABLE IF NOT EXISTS contact_links (
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (contact_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_links_node ON contact_links (node_id);
  `)
}

interface Row {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  notes: string | null
  kind: string
  account_id: string | null
  tags: string | null
  created_at: number
  updated_at: number
}

const toContact = (r: Row): Contact => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  company: r.company,
  role: r.role,
  notes: r.notes,
  kind: (r.kind === 'member' ? 'member' : 'guest') as Contact['kind'],
  accountId: r.account_id,
  tags: r.tags ? r.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export function listContacts(): Contact[] {
  return (getDb().prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE').all() as Row[]).map(
    toContact
  )
}

export function getContact(id: string): Contact | null {
  const r = getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined
  return r ? toContact(r) : null
}

/** Contacts linked to a desk (or any node). */
export function listContactsForNode(nodeId: string): Contact[] {
  return (
    getDb()
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contact_links l ON l.contact_id = c.id
         WHERE l.node_id = ?
         ORDER BY c.name COLLATE NOCASE`
      )
      .all(nodeId) as Row[]
  ).map(toContact)
}

export function createContact(draft: ContactDraft): Contact {
  const id = draft.id ?? randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO contacts (id, name, email, phone, company, role, notes, kind, account_id, tags, created_at, updated_at)
       VALUES (@id, @name, @email, @phone, @company, @role, @notes, @kind, @accountId, @tags, @now, @now)`
    )
    .run({
      id,
      name: draft.name?.trim() || 'Unnamed',
      email: draft.email?.trim() || null,
      phone: draft.phone?.trim() || null,
      company: draft.company?.trim() || null,
      role: draft.role?.trim() || null,
      notes: draft.notes?.trim() || null,
      kind: draft.kind === 'member' ? 'member' : 'guest',
      accountId: draft.accountId ?? null,
      tags: draft.tags?.length ? draft.tags.join(',') : null,
      now
    })
  if (draft.nodeId) linkContact(id, draft.nodeId)
  return getContact(id) as Contact
}

export function updateContact(id: string, patch: ContactPatch): Contact | null {
  const cols: Array<[keyof ContactPatch, string]> = [
    ['name', 'name'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['company', 'company'],
    ['role', 'role'],
    ['notes', 'notes'],
    ['accountId', 'account_id'],
    ['kind', 'kind']
  ]
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  for (const [k, col] of cols) {
    if (patch[k] !== undefined) {
      fields.push(`${col} = @${String(k)}`)
      params[String(k)] = patch[k]
    }
  }
  if (patch.tags !== undefined) {
    fields.push('tags = @tags')
    params.tags = patch.tags.length ? patch.tags.join(',') : null
  }
  if (fields.length === 0) return getContact(id)
  fields.push('updated_at = @now')
  getDb().prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = @id`).run(params)
  return getContact(id)
}

export function deleteContact(id: string): boolean {
  const db = getDb()
  db.prepare('DELETE FROM contact_links WHERE contact_id = ?').run(id)
  const res = db.prepare('DELETE FROM contacts WHERE id = ?').run(id)
  return (res.changes ?? 0) > 0
}

export function linkContact(contactId: string, nodeId: string): boolean {
  // Idempotent: putting somebody on a desk twice is a no-op, not an error.
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO contact_links (contact_id, node_id, created_at) VALUES (?, ?, ?)`
    )
    .run(contactId, nodeId, Date.now())
  return (res.changes ?? 0) > 0
}

export function unlinkContact(contactId: string, nodeId: string): boolean {
  const res = getDb()
    .prepare('DELETE FROM contact_links WHERE contact_id = ? AND node_id = ?')
    .run(contactId, nodeId)
  return (res.changes ?? 0) > 0
}

/** Every desk a person appears on, for "what am I working on with them". */
export function listNodesForContact(contactId: string): string[] {
  return (
    getDb()
      .prepare('SELECT node_id FROM contact_links WHERE contact_id = ?')
      .all(contactId) as Array<{ node_id: string }>
  ).map((r) => r.node_id)
}
