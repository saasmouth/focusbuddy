// The side menu's Widgets section (4.3.32) — docs/widget-files.md.
//
// "Add a new section to the side menu for widgets that are not already
// represented in apps. Make it so users can move lesser used widgets to an
// accordion section called 'Other widgets' to keep the menu a reasonable size."
//
// Which kinds: lib/widgetMenu (the catalogue minus what Apps already is).
// Which list each sits in: lib/widgetMenuPrefs (per user, synced).
//
//   click            a standalone widget file, opened full-pane
//   drag onto desk   a new widget file, placed as a linked instance
//   right-click      Add to this desk · New <kind> file · Move to Other widgets / Widgets
//   drag in menu     reorder, or move between the two lists
//
// The same kinds render as icons in the collapsed rail (WidgetsRail below).

import { useEffect, useMemo, useState, type JSX } from 'react'
import Icon from '../Icon'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import { SubHeading, Tile, TileGrid } from './menuParts'
import type { WidgetKind } from '@shared/types'
import { isStandaloneWidgetKind } from '@shared/widgetFiles'
import { DRAG_MIME, useCaseGroupOf, type WidgetCatalogEntry } from '../../lib/widgetCatalog'
import { moveWidgetKind, splitWidgetMenu, widgetMenuEntries } from '../../lib/widgetMenu'
import {
  hydrateWidgetMenuPrefs,
  readOtherWidgetsOpen,
  setWidgetMenuPrefs,
  useWidgetMenuPrefs,
  writeOtherWidgetsOpen
} from '../../lib/widgetMenuPrefs'
import { widgetGroupTone } from '../../lib/areaTones'
import { writeNewWidgetFileDrag } from '../../lib/widgetFileDrag'
import { addKindToOpenDesk, openOrCreateFromMenu, ensureCanAdd } from '../../lib/addWidget'
import { requestCanvasBringSynced, requestCanvasImportFile } from '../../lib/canvasCommands'
import { canCreateWidget } from '../../lib/gating'
import { useCapabilityStore } from '../../stores/capabilities'
import { useAccountStore } from '../../stores/account'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useWidgetFilesStore } from '../../stores/widgetFiles'
import { useNoticeStore } from '../../stores/notice'

/** Internal drag type for rearranging the menu itself. */
const MENU_ITEM_MIME = 'application/x-plexii-widget-menu-item'

type ListId = 'main' | 'other'

/** The live split, plus the operations on it. Shared by the section and the rail. */
export function useWidgetMenu(): {
  main: WidgetCatalogEntry[]
  other: WidgetCatalogEntry[]
  move: (kind: string, to: ListId, beforeKind?: string | null) => void
} {
  const prefs = useWidgetMenuPrefs()
  const token = useAccountStore((s) => s.sessionToken)
  const entries = useMemo(() => widgetMenuEntries(), [])
  const split = useMemo(() => splitWidgetMenu(prefs, entries), [prefs, entries])
  // Pull the arrangement saved on the user's other devices, once signed in.
  useEffect(() => {
    if (token) void hydrateWidgetMenuPrefs(token)
  }, [token])
  const move = (kind: string, to: ListId, beforeKind: string | null = null): void => {
    setWidgetMenuPrefs(moveWidgetKind(prefs, kind, to, beforeKind, entries), token ?? null)
  }
  return { main: split.main, other: split.other, move }
}

/** Whether a desk is on screen, reactively. */
function useDeskOpen(): boolean {
  const view = useViewStore((s) => s.view)
  const active = useNodeStore((s) => s.activeTaskId)
  return view.kind === 'task' && !!(active ?? view.taskId)
}

/** The right-click menu for one kind, wherever it is shown. */
export function widgetKindMenuItems(
  entry: WidgetCatalogEntry,
  list: ListId,
  deskOpen: boolean,
  move: (kind: string, to: ListId) => void
): CtxMenuItem[] {
  const standalone = isStandaloneWidgetKind(entry.kind)
  const items: CtxMenuItem[] = []
  if (deskOpen) {
    items.push({
      label: 'Add to this desk',
      icon: 'add_to_queue',
      onClick: () => void addKindToOpenDesk(entry.kind)
    })
  }
  if (standalone) {
    items.push({
      label: `New ${entry.label.toLowerCase()} file`,
      icon: 'note_add',
      onClick: () => {
        if (ensureCanAdd(entry.kind)) void useWidgetFilesStore.getState().create(entry.kind)
      }
    })
  } else if (!deskOpen) {
    items.push({ label: 'Only works on a desk', icon: 'desk', disabled: true })
  }
  items.push({ separator: true })
  items.push(
    list === 'main'
      ? { label: 'Move to Other widgets', icon: 'south', onClick: () => move(entry.kind, 'other') }
      : { label: 'Move to Widgets', icon: 'north', onClick: () => move(entry.kind, 'main') }
  )
  return items
}

/** The section body: the main list, then "Other widgets", then the footer. */
export default function WidgetsSection(): JSX.Element {
  const { main, other, move } = useWidgetMenu()
  const caps = useCapabilityStore((s) => s.capabilities)
  const deskOpen = useDeskOpen()
  const [otherOpen, setOtherOpen] = useState<boolean>(readOtherWidgetsOpen)
  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(null)
  const [dropTarget, setDropTarget] = useState<ListId | null>(null)

  useEffect(() => writeOtherWidgetsOpen(otherOpen), [otherOpen])

  const tile = (entry: WidgetCatalogEntry, list: ListId): JSX.Element => {
    const locked = !canCreateWidget(caps, entry.kind)
    const standalone = isStandaloneWidgetKind(entry.kind)
    return (
      <div
        key={entry.kind}
        className="relative"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MENU_ITEM_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }
        }}
        onDrop={(e) => {
          const kind = e.dataTransfer.getData(MENU_ITEM_MIME)
          if (!kind) return
          e.preventDefault()
          e.stopPropagation()
          setDropTarget(null)
          move(kind, list, entry.kind)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, items: widgetKindMenuItems(entry, list, deskOpen, move) })
        }}
      >
        <Tile
          label={entry.label}
          active={false}
          testid={`sidemenu-widget-${entry.kind}`}
          note={locked ? 'Pro' : undefined}
          locked={locked}
          onClick={() => void openOrCreateFromMenu(entry.kind)}
          onDragStart={(e) => {
            // Rearranging the menu and putting a widget on a desk are the same
            // gesture with different destinations; both payloads ride along and
            // the drop target decides.
            e.dataTransfer.setData(MENU_ITEM_MIME, entry.kind)
            if (locked) return
            if (standalone) writeNewWidgetFileDrag(e.dataTransfer, entry.kind)
            else e.dataTransfer.setData(DRAG_MIME, entry.kind)
            e.dataTransfer.effectAllowed = 'copyMove'
          }}
        >
          <Icon
            name={entry.icon}
            size={22}
            filled
            className={locked ? 'text-[var(--ink-40)] opacity-60' : widgetGroupTone(useCaseGroupOf(entry.kind))}
          />
          {locked && (
            <span className="absolute -top-1 -right-1.5 text-accent" aria-hidden="true">
              <Icon name="lock" size={10} />
            </span>
          )}
        </Tile>
      </div>
    )
  }

  /** A list that accepts menu items dropped on its empty space (appends). */
  const listDrop = (list: ListId) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(MENU_ITEM_MIME)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(list)
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.target === e.currentTarget) setDropTarget(null)
    },
    onDrop: (e: React.DragEvent) => {
      const kind = e.dataTransfer.getData(MENU_ITEM_MIME)
      setDropTarget(null)
      if (!kind) return
      e.preventDefault()
      move(kind, list)
    }
  })

  return (
    <div data-testid="sidemenu-widgets">
      <div
        {...listDrop('main')}
        data-testid="sidemenu-widgets-main"
        className={`rounded-lg ${dropTarget === 'main' ? 'ring-1 ring-accent/50 bg-accent/5' : ''}`}
      >
        {main.length === 0 ? (
          <p className="px-3 py-1.5 text-[11px] text-[var(--ink-40)] leading-snug">
            Drag widgets here from Other widgets to keep them one click away.
          </p>
        ) : (
          <TileGrid>{main.map((e) => tile(e, 'main'))}</TileGrid>
        )}
      </div>

      <div
        {...listDrop('other')}
        className={`mt-1 rounded-lg ${dropTarget === 'other' ? 'ring-1 ring-accent/50 bg-accent/5' : ''}`}
      >
        <button
          onClick={() => setOtherOpen((v) => !v)}
          aria-expanded={otherOpen}
          data-testid="sidemenu-other-widgets-toggle"
          className="w-full flex items-center gap-1 px-3 pt-2 pb-1 text-left hover:text-[var(--ink-80)]"
          title={otherOpen ? 'Collapse Other widgets' : 'Expand Other widgets'}
        >
          <span className="flex-1 min-w-0 truncate text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--ink-40)]">
            Other widgets
          </span>
          <span className="text-[10px] text-[var(--ink-40)] tabular-nums">{other.length}</span>
          <Icon name={otherOpen ? 'expand_less' : 'expand_more'} size={14} className="text-[var(--ink-40)]" />
        </button>
        <div hidden={!otherOpen} data-testid="sidemenu-other-widgets">
          {other.length === 0 ? (
            <p className="px-3 pb-1 text-[11px] text-[var(--ink-40)] leading-snug">
              Every widget is in the main list. Right-click one to move it here.
            </p>
          ) : (
            <TileGrid>{other.map((e) => tile(e, 'other'))}</TileGrid>
          )}
        </div>
      </div>

      <SubHeading label="Bring in" />
      <div className="px-2 pb-1 flex flex-col">
        <FooterRow
          icon="upload_file"
          label="Import widget file…"
          testid="sidemenu-widgets-import-widget-file"
          title="Open a .plexii-table, .plexii-tasks … file exported from Plexii"
          onClick={() => {
            void window.api.widgetFiles.import().then((r) => {
              if (r.ok) useViewStore.getState().goDocument(r.file.id)
              else if (!r.canceled) useNoticeStore.getState().show({ text: r.error ?? 'Import failed.', icon: 'error' })
            })
          }}
        />
        {deskOpen && (
          <>
            <FooterRow
              icon="description"
              label="Import file to this desk…"
              testid="sidemenu-widgets-import-file"
              title=".txt / .md become a note, .csv / .json a table"
              onClick={() => requestCanvasImportFile()}
            />
            <FooterRow
              icon="link"
              label="Bring a synced widget…"
              testid="sidemenu-widgets-bring-synced"
              title="Put a linked copy of a widget from another desk on this one"
              onClick={() => requestCanvasBringSynced()}
            />
          </>
        )}
      </div>

      {ctx && <CanvasContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </div>
  )
}

function FooterRow({
  icon,
  label,
  title,
  testid,
  onClick
}: {
  icon: string
  label: string
  title: string
  testid: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      data-testid={testid}
      className="flex items-center gap-2 w-full px-2 py-1 rounded-lg text-[12px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
    >
      <Icon name={icon} size={15} className="text-[var(--ink-50)] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * The collapsed rail's Widgets group: the main list as icons with tooltips,
 * and a toggle that reveals Other widgets — same gestures as the section.
 */
export function WidgetsRail({ iconClass }: { iconClass: (active: boolean, tone?: string) => string }): JSX.Element {
  const { main, other, move } = useWidgetMenu()
  const deskOpen = useDeskOpen()
  const caps = useCapabilityStore((s) => s.capabilities)
  const [otherOpen, setOtherOpen] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(null)
  const railIcon = (entry: WidgetCatalogEntry, list: ListId): JSX.Element => {
    const locked = !canCreateWidget(caps, entry.kind)
    return (
      <button
        key={entry.kind}
        draggable={!locked}
        onDragStart={(e) => {
          if (isStandaloneWidgetKind(entry.kind)) writeNewWidgetFileDrag(e.dataTransfer, entry.kind as WidgetKind)
          else e.dataTransfer.setData(DRAG_MIME, entry.kind)
        }}
        onClick={() => void openOrCreateFromMenu(entry.kind)}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, items: widgetKindMenuItems(entry, list, deskOpen, move) })
        }}
        title={locked ? `${entry.label} (Pro)` : entry.label}
        aria-label={entry.label}
        data-testid={`rail-widget-${entry.kind}`}
        data-locked={locked ? 'true' : undefined}
        className={iconClass(false, locked ? 'text-[var(--ink-40)]' : widgetGroupTone(useCaseGroupOf(entry.kind)))}
      >
        <Icon name={entry.icon} size={16} filled />
      </button>
    )
  }
  return (
    <>
      {main.map((e) => railIcon(e, 'main'))}
      <button
        onClick={() => setOtherOpen((v) => !v)}
        title={otherOpen ? 'Hide other widgets' : 'Other widgets'}
        aria-expanded={otherOpen}
        data-testid="rail-other-widgets-toggle"
        className={iconClass(otherOpen)}
      >
        <Icon name={otherOpen ? 'expand_less' : 'more_horiz'} size={16} />
      </button>
      {otherOpen && other.map((e) => railIcon(e, 'other'))}
      {ctx && <CanvasContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </>
  )
}
