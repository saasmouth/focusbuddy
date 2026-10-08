import { useState } from 'react'
import Icon from '../Icon'
import { usePinLayer } from '../../stores/pinLayer'
import { canPlaceKind, pinDropMarkdown, PIN_ICON, type PinnedItem } from '../../lib/pinnable'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'

// The universal pin layer's UI (spec §7): a persistent tray, mounted app-wide so
// pins stay reachable across every surface. Each pin can be opened (jump to its
// source), dropped onto the current desk (materialised as a Portal for a desk, or
// a markdown note for captured text/links), and removed. Shows its source and how
// many desks it's been placed on. Renders nothing until something is pinned, so it
// never adds chrome to an empty workspace.

export default function PinTray(): JSX.Element | null {
  const items = usePinLayer((s) => s.items)
  const unpin = usePinLayer((s) => s.unpin)
  const markPlaced = usePinLayer((s) => s.markPlaced)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const setActive = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const goRoom = useViewStore((s) => s.goRoom)
  const goDocument = useViewStore((s) => s.goDocument)
  const createWidget = useWidgetStore((s) => s.create)

  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  if (items.length === 0) return null // no chrome until something is pinned

  function canOpen(item: PinnedItem): boolean {
    return (
      item.kind === 'desk' ||
      item.kind === 'room' ||
      item.kind === 'document' ||
      ((item.kind === 'widget' || item.kind === 'activity') && !!item.deskId) ||
      (item.kind === 'link' && !!item.url)
    )
  }

  function openPin(item: PinnedItem): void {
    if (item.kind === 'desk') {
      setActive(item.refId)
      goTask(item.refId)
    } else if (item.kind === 'room') {
      // A room shows its desks (see goRoom in stores/view.ts), not a canvas.
      goRoom(item.refId)
    } else if (item.kind === 'document') {
      goDocument(item.refId)
    } else if ((item.kind === 'widget' || item.kind === 'activity') && item.deskId) {
      setActive(item.deskId)
      goTask(item.deskId)
    } else if (item.kind === 'link' && item.url) {
      void window.api.files.openExternal(item.url).catch(() => {})
    }
  }

  async function drop(item: PinnedItem): Promise<void> {
    if (!activeTaskId || !canPlaceKind(item.kind)) return
    setMsg(null)
    try {
      // Go through the widget store (not raw IPC) so the canvas updates live.
      if (item.kind === 'desk') {
        await createWidget({
          taskId: activeTaskId,
          kind: 'portal',
          title: item.title,
          content: JSON.stringify({ targetTaskId: item.refId })
        })
      } else {
        await createWidget({
          taskId: activeTaskId,
          kind: 'markdown',
          title: item.title,
          content: pinDropMarkdown(item)
        })
      }
      markPlaced(item.id, activeTaskId)
      setMsg(`Placed “${item.title}” on this desk.`)
    } catch (err) {
      setMsg(`Could not place: ${(err as Error).message || 'unknown error'}`)
    }
  }

  return (
    <div className="fixed left-[14px] bottom-[42px] z-[119]">
      {open && (
        <div
          data-testid="pin-tray-panel"
          className="fb-card mb-2 w-[300px] max-h-[60vh] overflow-y-auto p-2"
        >
          <div className="flex items-center gap-1.5 px-1 pb-1.5">
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold flex-1">
              Pinned ({items.length})
            </span>
          </div>
          {msg && <div className="px-1 pb-1.5 text-[11px] text-[var(--ink-50)]" data-testid="pin-tray-msg">{msg}</div>}
          <ul className="space-y-1">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid={`pin-item-${item.id}`}
                className="group rounded-lg bg-[var(--surface-sunken)] px-2.5 py-2 hover:bg-[var(--surface-raised)]"
              >
                <div className="flex items-center gap-2">
                  <Icon name={PIN_ICON[item.kind]} size={14} className="text-[var(--ink-40)] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-[var(--ink-100)]">{item.title}</span>
                    <span className="block truncate text-[10.5px] text-[var(--ink-50)]">
                      {item.source ?? item.kind}
                      {item.placedOn.length > 0 ? ` · on ${item.placedOn.length} desk${item.placedOn.length > 1 ? 's' : ''}` : ''}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {canOpen(item) && (
                    <button
                      onClick={() => openPin(item)}
                      data-testid={`pin-open-${item.id}`}
                      className="fb-btn-surface h-6 px-2 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-raised)]"
                    >
                      Open
                    </button>
                  )}
                  <button
                    onClick={() => void drop(item)}
                    disabled={!activeTaskId || !canPlaceKind(item.kind)}
                    title={
                      !canPlaceKind(item.kind)
                        ? 'This kind opens in place; it cannot be dropped as a widget yet'
                        : !activeTaskId
                          ? 'Open a desk first'
                          : 'Add to the current desk'
                    }
                    data-testid={`pin-drop-${item.id}`}
                    className="h-6 px-2 rounded-md text-[11px] bg-[rgb(var(--accent))] text-white disabled:opacity-40"
                  >
                    Add to desk
                  </button>
                  <button
                    onClick={() => unpin(item.id)}
                    data-testid={`pin-remove-${item.id}`}
                    className="ml-auto icon-btn h-6 w-6 text-[var(--ink-40)] hover:text-rose-500"
                    title="Remove from pins"
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="pin-tray-toggle"
        title={`${items.length} pinned item${items.length > 1 ? 's' : ''}`}
        className="fb-floating-chrome inline-flex items-center gap-1.5 h-10 px-3 fb-btn-surface fb-press rounded-full text-[var(--ink-80)]"
      >
        <Icon name="push_pin" size={16} className="text-[rgb(var(--accent))]" filled />
        <span className="text-[12px] font-medium fb-tabular">{items.length}</span>
      </button>
    </div>
  )
}
