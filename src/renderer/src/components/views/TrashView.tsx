import { useEffect, useState } from 'react'
import { useNodeStore } from '../../stores/nodes'
import { useWorkItemStore } from '../../stores/workItems'
import Icon from '../Icon'
import { confirmPermanentDelete, tombstonePurged } from '../../lib/deleteDeskFlow'
import { promptText, confirmDialog } from '../plexi/PromptDialog'

// Trash (lifecycle track L1 + DEC-021's D2). Trashed rooms and desks wait
// here for the 7-day purge; Restore brings one back with its entire subtree,
// bit-lossless (§2.5.1 — work_item children included). The list shows ROOTS
// only: children travel with their parent. Purge timing is honest — each row
// says when the sweep will claim it.
//
// "Delete permanently" is the D2 choice, living where the trash lives (the
// OS "empty trash" shape): typed-name confirmation, immediate hard-delete,
// memory purged. The auto-purge keeps memory; only the explicit permanent
// delete erases it — stated in the header copy.

interface TrashEntry {
  id: string
  kind: string
  title: string
  trashedAt: number
  purgeAt: number
}

function daysLeft(purgeAt: number): string {
  const ms = purgeAt - Date.now()
  if (ms <= 0) return 'purging soon'
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
  return days === 1 ? '1 day left' : `${days} days left`
}

export default function TrashView(): JSX.Element {
  const refreshNodes = useNodeStore((s) => s.refresh)
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // DEC-022 selection mode, Trash edition: grab groups and restore or
  // permanently delete them together. Same interaction grammar as the index
  // pages (Select toggle, click-to-toggle checks, Select all, action bar).
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [busyBulk, setBusyBulk] = useState(false)
  const exitSelect = (): void => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function load(): Promise<void> {
    try {
      setEntries(await window.api.nodes.listTrash())
    } catch {
      setEntries([])
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function restore(id: string): Promise<void> {
    setBusyId(id)
    try {
      await window.api.nodes.restoreTree(id)
      await refreshNodes()
      await load()
    } finally {
      setBusyId(null)
    }
  }

  async function bulkRestore(): Promise<void> {
    const ids = [...selected]
    if (!ids.length) return
    setBusyBulk(true)
    try {
      for (const id of ids) await window.api.nodes.restoreTree(id)
      await refreshNodes()
      await load()
      exitSelect()
    } finally {
      setBusyBulk(false)
    }
  }

  async function bulkDeleteForever(): Promise<void> {
    const ids = [...selected]
    if (!ids.length) return
    // One deliberate confirmation for the batch — typing per-item names does
    // not scale to groups, but the friction stays typed and explicit.
    const typed = await promptText({
      title: `Permanently delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
      label:
        'Each one and everything Plexii learned from it is erased immediately. Attention items are preserved — they move to your Attention page. Type DELETE to confirm.',
      placeholder: 'DELETE',
      confirmLabel: 'Delete permanently',
      danger: true,
      selectAll: false
    })
    if (typed == null || typed.trim().toUpperCase() !== 'DELETE') {
      if (typed != null) {
        await confirmDialog({
          title: 'Nothing was deleted',
          body: 'Type DELETE exactly to confirm a bulk permanent delete.',
          confirmLabel: 'OK'
        })
      }
      return
    }
    setBusyBulk(true)
    try {
      let revived = 0
      let failed = 0
      for (const id of ids) {
        try {
          const r = await window.api.nodes.deletePermanent(id)
          tombstonePurged(r) // DEC-142 — the bulk arm tombstones too
          revived += r.revived
        } catch {
          failed++
        }
      }
      await refreshNodes()
      await useWorkItemStore.getState().refresh()
      window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
      await load()
      exitSelect()
      if (revived > 0 || failed > 0) {
        await confirmDialog({
          title: 'Permanent delete finished',
          body:
            (revived > 0
              ? `${revived} attention item${revived === 1 ? ' was' : 's were'} preserved and moved to your Attention page. `
              : '') + (failed > 0 ? `${failed} item${failed === 1 ? '' : 's'} could not be deleted.` : ''),
          confirmLabel: 'OK'
        })
      }
    } finally {
      setBusyBulk(false)
    }
  }

  async function deleteForever(e: TrashEntry): Promise<void> {
    setBusyId(e.id)
    try {
      const done = await confirmPermanentDelete(e)
      if (done) await load()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface-base)] text-[var(--ink-100)]">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="mb-6 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="fb-t-title text-[var(--ink-90)]">Trash</h1>
            <p className="fb-t-body text-[var(--ink-50)] mt-1">
              Deleted rooms and desks stay here for 7 days, then purge automatically — what
              Plexii learned from them stays either way. Restoring brings everything back
              exactly as it was. “Delete permanently” erases the item AND its memory, right
              now; attention items always survive and move to your Attention page.
            </p>
          </div>
          {entries != null && entries.length > 0 && !selecting && (
            <button
              onClick={() => setSelecting(true)}
              data-testid="trash-select"
              className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)]"
            >
              <Icon name="check_circle" size={15} /> Select
            </button>
          )}
        </div>

        {selecting && (
          <div
            data-testid="trash-selection-bar"
            className="flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-[var(--radius-field)] bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--edge-hairline)]"
          >
            <span className="fb-t-label text-[var(--ink-90)] fb-tabular">{selected.size} selected</span>
            <button
              onClick={() => {
                const all = (entries ?? []).map((e) => e.id)
                setSelected((prev) => (prev.size === all.length ? new Set() : new Set(all)))
              }}
              className="inline-flex items-center gap-1 h-7 px-2.5 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)]"
            >
              <Icon name="select_all" size={14} />
              {entries && selected.size === entries.length && entries.length > 0
                ? 'Select none'
                : 'Select all'}
            </button>
            <div className="w-px h-5 bg-[var(--edge-soft)]" />
            <button
              onClick={() => void bulkRestore()}
              disabled={selected.size === 0 || busyBulk}
              data-testid="trash-bulk-restore"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)] disabled:opacity-40 disabled:pointer-events-none"
            >
              <Icon name="restore_from_trash" size={14} /> {busyBulk ? 'Working…' : 'Restore'}
            </button>
            <button
              onClick={() => void bulkDeleteForever()}
              disabled={selected.size === 0 || busyBulk}
              data-testid="trash-bulk-delete"
              className="inline-flex items-center gap-1.5 h-7 px-2.5 fb-btn-surface fb-press fb-t-label text-[var(--danger,#c0392b)] hover:opacity-80 disabled:opacity-40 disabled:pointer-events-none"
            >
              <Icon name="delete_forever" size={14} /> Delete permanently
            </button>
            <button
              onClick={exitSelect}
              className="ml-auto inline-flex items-center gap-1 h-7 px-2.5 fb-t-label text-[var(--ink-60)] hover:text-[var(--ink-100)] fb-press"
            >
              Done
            </button>
          </div>
        )}
        {entries === null ? null : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Icon name="delete" size={28} className="text-[var(--ink-30)] mb-3" />
            <div className="fb-t-label text-[var(--ink-50)]">Trash is empty</div>
            <div className="fb-t-body text-[var(--ink-30)] mt-1">
              Nothing is waiting to be purged.
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--edge-soft)] divide-y divide-[var(--edge-soft)] overflow-hidden">
            {entries.map((e) => (
              <div
                key={e.id}
                onClick={selecting ? () => toggleSelected(e.id) : undefined}
                className={`flex items-center gap-3 px-4 py-3 ${
                  selecting
                    ? selected.has(e.id)
                      ? 'bg-accent/[0.08] cursor-pointer'
                      : 'bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)] cursor-pointer'
                    : 'bg-[var(--surface-raised)]'
                }`}
                data-testid={`trash-row-${e.id}`}
              >
                {selecting && (
                  <Icon
                    name={selected.has(e.id) ? 'check_circle' : 'radio_button_unchecked'}
                    size={17}
                    className={`shrink-0 ${
                      selected.has(e.id) ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-30)]'
                    }`}
                  />
                )}
                <Icon
                  name={e.kind === 'folder' ? 'folder' : 'desk'}
                  size={18}
                  className="text-[var(--ink-50)] shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="fb-t-label text-[var(--ink-100)] truncate">
                    {e.title || (e.kind === 'folder' ? 'Untitled room' : 'Untitled desk')}
                  </div>
                  <div className="fb-t-body text-[var(--ink-50)]">{daysLeft(e.purgeAt)}</div>
                </div>
                {!selecting && (
                  <>
                    <button
                      onClick={() => void restore(e.id)}
                      disabled={busyId === e.id}
                      className="inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)] disabled:opacity-50"
                    >
                      <Icon name="restore_from_trash" size={15} />
                      {busyId === e.id ? 'Working…' : 'Restore'}
                    </button>
                    <button
                      onClick={() => void deleteForever(e)}
                      disabled={busyId === e.id}
                      title="Erase this and its memory immediately (typed confirmation)"
                      data-testid={`trash-delete-forever-${e.id}`}
                      className="inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--danger,#c0392b)] hover:opacity-80 disabled:opacity-50"
                    >
                      <Icon name="delete_forever" size={15} />
                      Delete permanently
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
