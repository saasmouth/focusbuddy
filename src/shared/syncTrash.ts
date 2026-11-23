// What the Trash shows of things deleted elsewhere: on another device, or by
// someone you share a desk with (4.3.55; main/db/syncTrash.ts builds it).

export type DeletedElsewhereKind = 'widget' | 'node' | 'table' | 'row' | 'timeblock' | 'file' | 'document'

export interface DeletedElsewhereEntry {
  kind: DeletedElsewhereKind
  id: string
  title: string
  /** The desk, table or folder it was in; null when it stood on its own. */
  where: string | null
  deletedAt: number
  /** When the purge claims it, or null for kinds that never age out. */
  purgeAt: number | null
  /**
   * It lives where other people can delete it too (a shared desk, or an org
   * workspace), so "on another device" alone would not be the whole truth.
   */
  sharedScope: boolean
}

export interface DeletedElsewhereRestore {
  restored: boolean
  /** What came back: a desk's subtree, or a table and the rows deleted with it. */
  ids: string[]
}
