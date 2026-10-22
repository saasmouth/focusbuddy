// A widget file, full-pane — docs/widget-files.md.
//
// The body is the SAME component the desk renders (renderWidget), in the
// embedded surface so it fills the pane and cannot be dragged. Its widget is a
// synthetic one with id `wf:<file id>`; the widget store routes its edits to the
// file, and the file fans them out to every desk instance.
//
// The header is the file's own: its name (rename here and it is yours), its
// type, a handle to drag it onto a desk (a linked instance), a picker to place
// it on a desk without opening one, export, and Move to Trash.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { resolveEntityIcon } from '../../lib/plexiiIconMap'
import DocFiledInChip from '../DocFiledInChip'
import { renderWidget } from '../widgets/renderWidget'
import { WidgetSurfaceContext } from '../../lib/widgetSurface'
import { useWidgetFilesStore } from '../../stores/widgetFiles'
import { useWidgetStore } from '../../stores/widgets'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useNoticeStore } from '../../stores/notice'
import { catalogFor } from '../../lib/widgetCatalog'
import { writeWidgetFileDrag } from '../../lib/widgetFileDrag'
import { confirmTrashWidgetFile } from '../../lib/widgetRemoval'
import { widgetFileType, widgetFromFile, widgetFilePaneId } from '@shared/widgetFiles'
import type { Widget } from '@shared/types'

export default function WidgetFileView({ fileId }: { fileId: string }): JSX.Element {
  const file = useWidgetFilesStore((s) => s.files[fileId])
  const load = useWidgetFilesStore((s) => s.load)
  const rename = useWidgetFilesStore((s) => s.rename)
  const [missing, setMissing] = useState(false)
  const [instances, setInstances] = useState<Widget[] | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 900, height: 600 })

  useEffect(() => {
    let alive = true
    setMissing(false)
    void load(fileId).then((f) => {
      if (alive && !f) setMissing(true)
    })
    void window.api.widgetFiles.instances(fileId).then((ws) => {
      if (alive) setInstances(ws)
    })
    return () => {
      alive = false
    }
  }, [fileId, load])

  // Interactive kinds (a diagram, a sketch) take input only when active, as on
  // a desk; full-pane, the file IS the active thing.
  useEffect(() => {
    const id = widgetFilePaneId(fileId)
    const ws = useWidgetStore.getState()
    const prev = ws.activeWidgetId
    ws.setActive(id)
    return () => {
      if (useWidgetStore.getState().activeWidgetId === id) useWidgetStore.getState().setActive(prev)
    }
  }, [fileId])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [file?.id])

  const widget = useMemo(() => (file ? widgetFromFile(file, size) : null), [file, size])
  // Desks, not instances: two copies on one desk are still one desk.
  const deskCount = useMemo(() => new Set((instances ?? []).map((w) => w.taskId)).size, [instances])

  if (missing) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center p-8" data-testid="widget-file-missing">
        <Icon name="link_off" size={28} className="text-[var(--ink-40)]" />
        <p className="text-[14px] text-[var(--ink-70)]">This work widget file no longer exists.</p>
        <p className="text-[12px] text-[var(--ink-40)]">It may be in the Documents trash, or was deleted on another device.</p>
        <button className="fb-btn-surface text-[12px] px-3 py-1.5" onClick={() => useViewStore.getState().goFiles()}>
          Go to Files
        </button>
      </div>
    )
  }
  if (!file || !widget) {
    return <div className="h-full" data-testid="widget-file-loading" />
  }

  const type = widgetFileType(file.kind)
  const icon = catalogFor(file.kind)?.icon ?? type?.icon ?? 'widgets'

  return (
    <div className="h-full flex flex-col bg-[var(--surface-raised)]" data-testid="widget-file-view" data-file-id={file.id} data-kind={file.kind}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--edge-soft)] shrink-0">
        <button
          className="inline-flex items-center gap-1 text-[12px] text-[var(--ink-50)] hover:text-accent"
          onClick={() => useViewStore.getState().goFiles()}
          title="Back to Files"
          data-testid="widget-file-crumb"
        >
          <Icon name="folder" size={14} />
          Files
        </button>
        <Icon name="chevron_right" size={14} className="text-[var(--ink-30)]" />
        <span
          draggable
          onDragStart={(e) => writeWidgetFileDrag(e.dataTransfer, { id: file.id, title: file.title })}
          title="Drag onto a desk to place a linked copy — edits sync both ways"
          data-testid="widget-file-drag"
          className={`inline-flex items-center justify-center w-7 h-7 rounded-lg cursor-grab active:cursor-grabbing shrink-0 ${
            resolveEntityIcon('widget', file.kind).asset ? '' : 'bg-[var(--surface-sunken)] text-accent'
          }`}
        >
          <PlexiiIcon kind="widget" id={file.kind} size={28} fallback={icon} fallbackFilled />
        </span>
        <TitleField value={file.title} onCommit={(t) => void rename(file.id, t)} />
        <span
          className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--surface-sunken)] text-[var(--ink-50)]"
          data-testid="widget-file-type"
          title={type ? `${type.label} (${type.ext})` : file.kind}
        >
          {type?.label ?? file.kind}
        </span>
        {/* Where it lives in Files, and one tap to put it somewhere.
            A work widget is a documents row (docs/widget-files.md), so the
            same chip the office editors use works here unchanged — a widget
            made from the side menu has no desk AND, until now, no obvious way
            to be filed. */}
        <DocFiledInChip docId={fileId} compact className="ml-3 shrink-0" />
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {deskCount > 0 && (
            <span className="text-[11px] text-[var(--ink-40)] mr-1" data-testid="widget-file-instances">
              On {deskCount} desk{deskCount === 1 ? '' : 's'}
            </span>
          )}
          <PlaceOnDesk fileId={file.id} onPlaced={(w) => setInstances((xs) => [...(xs ?? []), w])} />
          <button
            className="h-8 px-2 inline-flex items-center gap-1 rounded-lg text-[12px] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
            title={`Export as ${type?.ext ?? 'a file'}`}
            data-testid="widget-file-export"
            onClick={() => {
              void window.api.widgetFiles.export(file.id).then((r) => {
                if (r.ok) useNoticeStore.getState().show({ text: `Exported to ${r.path}`, icon: 'download' })
                else if (!r.canceled) useNoticeStore.getState().show({ text: r.error ?? 'Export failed.', icon: 'error' })
              })
            }}
          >
            <Icon name="ios_share" size={15} />
            Export
          </button>
          <button
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--ink-50)] hover:text-rose-600 hover:bg-[var(--surface-sunken)]"
            title={
              deskCount > 0
                ? `Delete: moves it to Trash and removes it from ${deskCount === 1 ? 'the desk' : `all ${deskCount} desks`} it is on`
                : 'Move to Trash'
            }
            data-testid="widget-file-trash"
            // Deleting the file takes its desk instances too (main does it);
            // when it is placed anywhere, this asks first and says so.
            onClick={() => void confirmTrashWidgetFile(file.id)}
          >
            <Icon name="delete" size={16} />
          </button>
        </div>
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 relative p-3" data-testid="widget-file-body">
        <div className="h-full w-full relative" data-widget-file-surface>
          <WidgetSurfaceContext.Provider value="embedded">{renderWidget(widget)}</WidgetSurfaceContext.Provider>
        </div>
      </div>
    </div>
  )
}

function TitleField({ value, onCommit }: { value: string; onCommit: (t: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  if (!editing) {
    return (
      <button
        className="min-w-0 truncate text-left text-[15px] font-semibold text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] rounded px-1"
        onClick={() => setEditing(true)}
        title="Rename"
        data-testid="widget-file-title"
      >
        {value}
      </button>
    )
  }
  const commit = (): void => {
    setEditing(false)
    const t = draft.trim()
    if (t && t !== value) onCommit(t)
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
      data-testid="widget-file-title-input"
      className="min-w-0 flex-1 max-w-[420px] text-[15px] font-semibold bg-[var(--surface-raised)] border border-accent rounded px-1"
    />
  )
}

/** Place a linked instance on any desk, without opening it. */
function PlaceOnDesk({ fileId, onPlaced }: { fileId: string; onPlaced: (w: Widget) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const nodes = useNodeStore((s) => s.nodes)
  const place = useWidgetFilesStore((s) => s.place)
  const desks = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return nodes
      .filter((n) => n.kind === 'task' && !n.archived)
      // A desk, not a task on one: its parent is a room or nothing.
      .filter((n) => !n.parentId || byId.get(n.parentId)?.kind !== 'task')
      .filter((n) => !q.trim() || n.title.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 14)
  }, [nodes, q])
  return (
    <div className="relative">
      <button
        className="h-8 px-2 inline-flex items-center gap-1 rounded-lg text-[12px] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
        onClick={() => setOpen((v) => !v)}
        data-testid="widget-file-place"
        title="Put a linked copy on a desk — edits sync both ways"
      >
        <Icon name="add_to_queue" size={15} />
        Add to desk
      </button>
      {open && (
        <div
          className="absolute right-0 top-9 z-[60] w-[260px] fb-card p-1.5 shadow-lg"
          data-testid="widget-file-place-menu"
          onMouseLeave={() => setOpen(false)}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a desk…"
            className="fb-field w-full h-7 text-[12px] px-2 mb-1"
          />
          {desks.length === 0 ? (
            <p className="text-[11px] text-[var(--ink-40)] px-2 py-1.5">No desks match.</p>
          ) : (
            desks.map((d) => (
              <button
                key={d.id}
                className="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
                onClick={() => {
                  setOpen(false)
                  void place(fileId, d.id).then((w) => {
                    if (!w) return
                    onPlaced(w)
                    useNoticeStore.getState().show({
                      text: `Added to ${d.title || 'the desk'} — linked, so edits sync both ways`,
                      icon: 'desk',
                      action: { label: 'Open desk', run: () => useViewStore.getState().goTask(d.id) }
                    })
                  })
                }}
              >
                <Icon name="desk" size={14} className="text-[var(--ink-40)]" />
                <span className="truncate">{d.title || 'Desk'}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
