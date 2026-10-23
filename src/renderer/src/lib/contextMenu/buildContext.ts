// Helpers that turn a right-click on a surface into a MenuContext. A widget
// only knows what it was that got clicked (itself, a selection inside it, a
// table cell), so it calls one of these and hands the result to the menu. The
// canvas-space point is only needed for empty-canvas placement, so widget and
// multi contexts leave it at the origin; createConnectedTool positions new
// widgets relative to the source, not the click point.

import type { Widget } from '@shared/types'
import type { CtxMenuItem } from '../../components/CanvasContextMenu'
import type { FrameCallbacks, MenuContext, MenuContribution } from './types'
import { SHOW_IN_FULL_VIEW_LABEL, SHOW_ON_CANVAS_LABEL } from './labels'

interface ClickPoint {
  clientX: number
  clientY: number
}

export function buildContextForWidget(
  widget: Widget,
  e: ClickPoint,
  opts?: {
    granularity?: string
    payload?: Record<string, unknown>
    selectionText?: string
    frame?: FrameCallbacks
    headerExtras?: CtxMenuItem[]
    contributions?: MenuContribution[]
    renameFirst?: boolean
  }
): MenuContext {
  const text = opts?.selectionText?.trim() ? opts.selectionText : undefined
  return {
    object: { type: 'widget', widget },
    sub: opts?.granularity ? { granularity: opts.granularity, payload: opts.payload ?? {} } : undefined,
    selection: text
      ? { text, sourceWidgetId: widget.id, sourceKind: widget.kind }
      : undefined,
    taskId: widget.taskId,
    canvasPoint: { x: 0, y: 0 },
    clientPoint: { x: e.clientX, y: e.clientY },
    frame: opts?.frame,
    headerExtras: opts?.headerExtras,
    contributions: opts?.contributions,
    renameFirst: opts?.renameFirst
  }
}

export function buildContextForSelection(widget: Widget, e: ClickPoint, selectionText: string): MenuContext {
  return buildContextForWidget(widget, e, { selectionText })
}

export function buildContextForMulti(widgets: Widget[], e: ClickPoint): MenuContext {
  return {
    object: { type: 'multi', widgets },
    taskId: widgets[0]?.taskId ?? '',
    canvasPoint: { x: 0, y: 0 },
    clientPoint: { x: e.clientX, y: e.clientY }
  }
}

// ── One context builder per non-frame surface, so the app and the guard test
// (tests/unit/contextMenuContract.wp1a.test.ts) build each menu identically ──

/** The section handle (SectionWidget): its own dialogs, the 'section' provider's rows. */
export function sectionMenuContext(
  section: Widget,
  e: ClickPoint,
  host: Pick<FrameCallbacks, 'onShare' | 'onMakeTask' | 'onRename'>
): MenuContext {
  return buildContextForWidget(section, e, { frame: { ...host, removal: 'archive-only' } })
}

/**
 * A tile in focus mode's dock (WidgetFocusDock). The dock hosts the dialogs a
 * frame would (share, make a desk, save as snippet), so the tile gets the same
 * rows as the widget's header, plus "Show in full view" as its object row.
 */
export function focusDockTileContext(
  w: Widget,
  e: ClickPoint,
  host: Pick<FrameCallbacks, 'onShare' | 'onMakeTask' | 'onSaveAsSnippet'> & { onShowInFullView: () => void }
): MenuContext {
  const { onShowInFullView, ...frame } = host
  return buildContextForWidget(w, e, {
    frame,
    contributions: [
      { id: 'dock/show', group: 'object', priority: -50, fold: 3, label: SHOW_IN_FULL_VIEW_LABEL, icon: 'center_focus_strong', onSelect: onShowInFullView }
    ]
  })
}

/** A row in the desk jump list (DeskJumpList, E-11): the standard menu, Rename first, then Go there. */
export function jumpListRowContext(w: Widget, e: ClickPoint, host: { onRename: () => void; onJump: () => void }): MenuContext {
  return buildContextForWidget(w, e, {
    frame: { onRename: host.onRename },
    renameFirst: true,
    contributions: [
      { id: 'jump/go', group: 'object', priority: -1500, fold: -1, label: SHOW_ON_CANVAS_LABEL, icon: 'my_location', onSelect: host.onJump }
    ]
  })
}

/** A card in the columns view (ColumnsView): open it, find it on the canvas, move it to another column. */
export function columnCardContext(
  w: Widget,
  e: ClickPoint,
  host: { onOpen: () => void; onReveal: () => void; moveTo: Array<{ title: string; onMove: () => void }> }
): MenuContext {
  const rows: MenuContribution[] = [
    { id: 'columns/open', group: 'object', priority: -50, fold: 3, label: SHOW_IN_FULL_VIEW_LABEL, icon: 'open_in_full', onSelect: host.onOpen },
    { id: 'columns/reveal', group: 'object', priority: -49, fold: 6, label: SHOW_ON_CANVAS_LABEL, icon: 'my_location', onSelect: host.onReveal }
  ]
  if (host.moveTo.length) {
    rows.push({
      id: 'columns/move',
      group: 'object',
      priority: -48,
      fold: 5,
      label: 'Move to',
      icon: 'drive_file_move',
      children: host.moveTo.map((m, i) => ({ id: `columns/move/${i}`, priority: i, label: m.title, onSelect: m.onMove }))
    })
  }
  return buildContextForWidget(w, e, { contributions: rows })
}
