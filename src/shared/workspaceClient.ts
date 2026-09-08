// GENERATED FILE -- DO NOT EDIT.
// Vendored from projects/haptyx-shared/src by scripts/sync-contract.mjs.
// Edit the canonical copy there, then run: npm run sync:contract
// The workspace client both runtimes share.
//
// The desktop already syncs its whole workspace to Signal -- nodes, widgets,
// tables, rows and time blocks, with revisions, tombstones and delta cursors,
// across a personal scope and one per org. That substrate is live, which means
// the server already holds the data a browser would need; what has been missing
// is a client for it that does not run inside Electron.
//
// This is that client, written to be isomorphic: it uses fetch and nothing
// else, so the same code serves a browser app, a test, or a future worker. It
// is deliberately transport-only -- it moves items and cursors and reports
// conflicts, and knows nothing about desks, widgets or how any of it is drawn.

export type WorkspaceItemType = 'node' | 'widget' | 'timeblock' | 'table' | 'row'

export interface WorkspaceItem {
  id: string
  itemType: WorkspaceItemType
  body: unknown
  rev: number
  deleted: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Which workspace is being synced. The server keeps these separate and the
 * client must not mix their cursors: a personal cursor advanced against an
 * org's changes would skip everything in between, permanently.
 */
export type WorkspaceScope =
  | { kind: 'personal' }
  | { kind: 'org'; orgId: string }
  | { kind: 'shared'; token: string }

export interface PullResult {
  items: WorkspaceItem[]
  /** The cursor to store and pass to the next pull. */
  cursor: number
}

export type UpsertResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: true; current: WorkspaceItem }
  | { ok: false; conflict: false; error: string }

function basePath(scope: WorkspaceScope): string {
  switch (scope.kind) {
    case 'personal':
      return '/workspace'
    case 'org':
      return '/workspace/org'
    case 'shared':
      return '/workspace/shared'
  }
}

export interface WorkspaceClientOptions {
  apiBase: string
  /** Session bearer token. A shared scope may be read without one. */
  token?: string | null
  /** Sent as the active org for org-scoped calls. */
  orgId?: string | null
  fetchImpl?: typeof fetch
}

export class WorkspaceClient {
  private readonly apiBase: string
  private readonly token: string | null
  private readonly orgId: string | null
  private readonly doFetch: typeof fetch

  constructor(opts: WorkspaceClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, '')
    this.token = opts.token ?? null
    this.orgId = opts.orgId ?? null
    this.doFetch = opts.fetchImpl ?? fetch
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['content-type'] = 'application/json'
    if (this.token) h.Authorization = `Bearer ${this.token}`
    // The server reads the active org from a header for org-scoped routes.
    if (this.orgId) h['x-fb-org'] = this.orgId
    return h
  }

  /**
   * Everything that changed after `since`, tombstones included. A caller that
   * drops the returned cursor and reuses its old one repeats work; a caller
   * that advances it without applying the items loses them for good, so the
   * cursor is returned separately rather than stored here.
   */
  async pull(scope: WorkspaceScope, since: number): Promise<PullResult> {
    const path = scope.kind === 'shared'
      ? `${basePath(scope)}/sync?token=${encodeURIComponent(scope.token)}&since=${since}`
      : `${basePath(scope)}/sync?since=${since}`
    const res = await this.doFetch(`${this.apiBase}${path}`, { headers: this.headers(false) })
    if (!res.ok) throw new Error(`workspace pull failed: HTTP ${res.status}`)
    const body = (await res.json()) as { ok?: boolean; items?: WorkspaceItem[]; now?: number; error?: string }
    if (body.ok === false) throw new Error(body.error ?? 'workspace pull refused')
    return { items: body.items ?? [], cursor: typeof body.now === 'number' ? body.now : since }
  }

  /**
   * Write one item. `baseRev` is the revision the caller last saw; the server
   * refuses the write if it has moved on, and hands back what it holds. That
   * conflict is a normal outcome, not an error -- two clients editing one
   * workspace is the entire point -- so it is reported as data.
   */
  async upsert(
    scope: WorkspaceScope,
    item: { id: string; itemType: WorkspaceItemType; body: unknown; baseRev: number }
  ): Promise<UpsertResult> {
    const res = await this.doFetch(`${this.apiBase}${basePath(scope)}/items/${encodeURIComponent(item.id)}`, {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify({ itemType: item.itemType, body: item.body, baseRev: item.baseRev })
    })
    if (res.status === 409) {
      const body = (await res.json()) as { current?: WorkspaceItem; item?: WorkspaceItem }
      const current = body.current ?? body.item
      if (current) return { ok: false, conflict: true, current }
      return { ok: false, conflict: false, error: 'conflict without a current copy' }
    }
    if (!res.ok) return { ok: false, conflict: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { ok?: boolean; rev?: number; error?: string }
    if (body.ok === false) return { ok: false, conflict: false, error: body.error ?? 'refused' }
    return { ok: true, rev: typeof body.rev === 'number' ? body.rev : item.baseRev + 1 }
  }

  /** Tombstone an item. Deletion is a write like any other and carries a baseRev. */
  async remove(scope: WorkspaceScope, id: string, baseRev: number): Promise<UpsertResult> {
    const res = await this.doFetch(`${this.apiBase}${basePath(scope)}/items/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...this.headers(true) },
      body: JSON.stringify({ baseRev })
    })
    if (!res.ok) return { ok: false, conflict: false, error: `HTTP ${res.status}` }
    return { ok: true, rev: baseRev + 1 }
  }
}

/**
 * Fold a delta into a map of items, tombstones included.
 *
 * Applying a delta is not "merge the new ones in": a tombstone has to remove
 * what is already there, and an item that arrives older than the copy in hand
 * has to be ignored, or a slow response can resurrect deleted work.
 */
export function applyDelta(
  into: Map<string, WorkspaceItem>,
  items: readonly WorkspaceItem[]
): Map<string, WorkspaceItem> {
  for (const item of items) {
    const have = into.get(item.id)
    if (have && have.rev > item.rev) continue
    // The tombstone is KEPT, not removed. Deleting the entry outright leaves
    // nothing to compare a later revision against, so a slow response carrying
    // an older copy would put deleted work back on screen -- and it would stay
    // there, because the deletion has already gone past the cursor and will
    // never be sent again. Callers read live items through `liveItems`.
    into.set(item.id, item)
  }
  return into
}

/** The items a surface should actually show: everything not tombstoned. */
export function liveItems(map: ReadonlyMap<string, WorkspaceItem>): WorkspaceItem[] {
  return [...map.values()].filter((i) => !i.deleted)
}

/**
 * Drop tombstones older than `before`. A client that never forgets a deletion
 * grows for ever; one that forgets too eagerly can resurrect the work. Callers
 * should prune well behind their cursor, not at it.
 */
export function pruneTombstones(map: Map<string, WorkspaceItem>, before: number): number {
  let n = 0
  for (const [id, item] of map) {
    if (item.deleted && item.updatedAt < before) {
      map.delete(id)
      n++
    }
  }
  return n
}
