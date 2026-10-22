// The top bar's right slot (what the OptionsBar row held): zoom out, the zoom
// level, zoom in, fit, grid, snap, the active artboard's size and the status
// line. Every button runs the same command as its menu item and key.

import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { BarCustom } from '../../../office/shell'
import { primaryArtboard } from '@shared/draw/ops'
import { CmdButton, CmdToggle } from '../bar/controls'
import type { EditorCtx } from '../editor/types'

export default function RightSlot({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const zoom = useStore(ctx.store, (s) => s.zoom)
  const showGrid = useStore(ctx.store, (s) => s.showGrid)
  const snapOn = useStore(ctx.store, (s) => s.snapOn)
  const busy = useStore(ctx.store, (s) => s.busy)
  const status = useStore(ctx.store, (s) => s.status)
  const board = useStore(ctx.store, (s) => primaryArtboard(s.doc))
  return (
    <>
      {(busy || status) && (
        <span className="text-[11px] text-[var(--ink-50)] inline-flex items-center gap-1 max-w-[200px] min-w-0" data-testid="draw-status" title={busy ?? status ?? undefined}>
          {busy && <Icon name="autorenew" size={12} className="animate-spin" />}
          <span className="truncate">{busy ?? status}</span>
          {status && !busy && (
            <button type="button" onClick={() => ctx.status(null)} aria-label="Dismiss" className="shrink-0 text-[var(--ink-40)] hover:text-[var(--ink-70)]" data-testid="draw-status-dismiss">
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      )}
      <span className="shrink-0 fb-tabular text-[11px] text-[var(--ink-40)] px-1" data-testid="draw-artboard-size" title="Active artboard size">
        {board.w} × {board.h}
      </span>
      <CmdToggle ctx={ctx} id="view.grid" icon="grid_4x4" label="Show grid" pressed={showGrid} readOnlySafe testid="draw-grid-toggle" />
      <CmdToggle ctx={ctx} id="view.snap" icon="straighten" label="Snap to edges and centres" pressed={snapOn} readOnlySafe testid="draw-snap-toggle" />
      <CmdButton ctx={ctx} id="view.zoomOut" icon="zoom_out" label="Zoom out" readOnlySafe testid="draw-zoom-out" />
      <BarCustom label="Zoom">
        <span className="fb-tabular text-[11px] w-10 text-center text-[var(--ink-60)]" data-testid="draw-zoom">
          {Math.round(zoom * 100)}%
        </span>
      </BarCustom>
      <CmdButton ctx={ctx} id="view.zoomIn" icon="zoom_in" label="Zoom in" readOnlySafe testid="draw-zoom-in" />
      <CmdButton ctx={ctx} id="view.fit" icon="fit_screen" label="Fit artboard in window" readOnlySafe testid="draw-fit" />
    </>
  )
}
