import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { DocSnapshotMeta } from '@shared/types'
import { useDocumentsStore } from '../../stores/documents'
import Icon from '../Icon'

// Version history panel for office files, shared by every editor. Snapshots
// are captured on the main-process save path (interval-gated), so this panel
// just lists them and restores. Restore is reversible: the backend records a
// "Before restore" snapshot first, which appears at the top of this list.
//
// Menu bars open it through the tiny store below (no prop drilling through
// five editors); DocHistoryPanelHost is mounted once per renderer root.

interface HistoryPanelState {
  docId: string | null
  open: (docId: string) => void
  close: () => void
}

export const useDocHistoryPanel = create<HistoryPanelState>((set) => ({
  docId: null,
  open: (docId) => set({ docId }),
  close: () => set({ docId: null })
}))

export function openDocHistory(docId: string): void {
  useDocHistoryPanel.getState().open(docId)
}

function whenLabel(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today, ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

export function DocHistoryPanelHost(): JSX.Element | null {
  const docId = useDocHistoryPanel((s) => s.docId)
  const close = useDocHistoryPanel((s) => s.close)
  const open = useDocumentsStore((s) => s.open)
  const [items, setItems] = useState<DocSnapshotMeta[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    setItems(null)
    if (!docId) return
    void window.api.documents.listSnapshots(docId).then(setItems)
  }, [docId])

  if (!docId) return null

  async function restore(snapshotId: string): Promise<void> {
    if (!docId) return
    setBusyId(snapshotId)
    const doc = await window.api.documents.restoreSnapshot(snapshotId)
    setBusyId(null)
    if (doc) {
      // Reload the open editor onto the restored body and refresh the list,
      // which now leads with the "Before restore" snapshot.
      await open(docId)
      void window.api.documents.listSnapshots(docId).then(setItems)
    }
  }

  return (
    <div
      className="fb-scrim fixed inset-0 z-[280] flex justify-end"
      onMouseDown={close}
      data-testid="doc-history-panel"
      data-doc-id={docId}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            close()
          }
        }}
        className="w-[min(360px,90vw)] h-full bg-[var(--surface-raised)] border-l border-[var(--edge-soft)] shadow-2xl flex flex-col"
      >
        <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="history" size={16} className="text-accent" />
            <span className="text-[13px] font-semibold text-[var(--ink-100)]">Version history</span>
          </div>
          <button onClick={close} aria-label="Close" className="p-1 rounded text-[var(--ink-40)] hover:text-[var(--ink-70)]">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {items === null ? (
            <p className="text-[12px] text-[var(--ink-50)] px-1 py-2">Loading versions…</p>
          ) : items.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)] px-1 py-2 leading-relaxed">
              No versions yet. A version is saved automatically every few minutes while you edit, so
              this list fills up as you work.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((snap, i) => (
                <li
                  key={snap.id}
                  className="group flex items-center gap-2 rounded-lg bg-[var(--surface-sunken)] px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-[var(--ink-90)]">
                      {whenLabel(snap.at)}
                      {i === 0 && <span className="ml-1.5 text-[10px] text-[var(--ink-40)]">newest</span>}
                    </div>
                    {snap.label && (
                      <div className="text-[11px] text-[var(--ink-50)]">{snap.label}</div>
                    )}
                  </div>
                  <button
                    onClick={() => void restore(snap.id)}
                    disabled={busyId !== null}
                    className="fb-btn-surface text-[11px] px-2 py-1 text-[var(--ink-70)] hover:border-accent hover:text-accent disabled:opacity-50"
                    data-testid="doc-history-restore"
                  >
                    {busyId === snap.id ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="px-4 py-2.5 border-t border-[var(--edge-soft)] text-[11px] text-[var(--ink-50)]">
          Restoring saves the current state first, so you can always come back.
        </p>
      </div>
    </div>
  )
}
