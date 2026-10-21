import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { primaryArtboard } from '@shared/draw/ops'
import { toolById } from '../tools/registry'
import type { EditorCtx } from '../editor/types'

/** The strip under the menu bar: active tool, zoom, grid and snap toggles, page size, status. */
export default function OptionsBar({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const tool = useStore(ctx.store, (s) => s.tool)
  const zoom = useStore(ctx.store, (s) => s.zoom)
  const showGrid = useStore(ctx.store, (s) => s.showGrid)
  const snapOn = useStore(ctx.store, (s) => s.snapOn)
  const busy = useStore(ctx.store, (s) => s.busy)
  const status = useStore(ctx.store, (s) => s.status)
  const board = useStore(ctx.store, (s) => primaryArtboard(s.doc))
  return (
    <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_50%,transparent)]">
      <span className="text-[11px] text-[var(--ink-50)] w-24 truncate">{toolById(tool)?.label}</span>
      <button onClick={() => ctx.run('view.zoomOut')} title="Zoom out" className="icon-btn !h-6 !w-6">
        <Icon name="zoom_out" size={15} />
      </button>
      <span className="fb-tabular text-[11px] w-12 text-center text-[var(--ink-60)]" data-testid="draw-zoom">
        {Math.round(zoom * 100)}%
      </span>
      <button onClick={() => ctx.run('view.zoomIn')} title="Zoom in" className="icon-btn !h-6 !w-6">
        <Icon name="zoom_in" size={15} />
      </button>
      <button onClick={() => ctx.run('view.fit')} title="Fit to window" className="icon-btn !h-6 !w-6">
        <Icon name="fit_screen" size={15} />
      </button>
      <div className="w-px h-4 bg-[var(--edge-soft)]" />
      <button onClick={() => ctx.run('view.grid')} title="Show grid" className={`icon-btn !h-6 !w-6 ${showGrid ? 'bg-accent/15 text-accent' : ''}`}>
        <Icon name="grid_4x4" size={15} />
      </button>
      <button
        onClick={() => ctx.run('view.snap')}
        title="Snap to edges and centres"
        data-testid="draw-snap-toggle"
        className={`icon-btn !h-6 !w-6 ${snapOn ? 'bg-accent/15 text-accent' : ''}`}
      >
        <Icon name="straighten" size={15} />
      </button>
      <div className="flex-1" />
      <span className="fb-tabular text-[11px] text-[var(--ink-40)]">
        {board.w} × {board.h}
      </span>
      {(busy || status) && (
        <span className="text-[11px] text-[var(--ink-50)] inline-flex items-center gap-1 max-w-[320px] truncate" data-testid="draw-status">
          {busy && <Icon name="autorenew" size={12} className="animate-spin" />}
          {busy ?? status}
          {status && !busy && (
            <button onClick={() => ctx.status(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      )}
    </div>
  )
}
