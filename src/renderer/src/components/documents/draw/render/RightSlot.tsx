// The top bar's right slot (what the OptionsBar row held): zoom out, the zoom
// level (a menu of the View zoom commands), zoom in, fit, grid, snap, the
// active artboard's size and the status line. Every button and menu item runs
// the same command as its View menu item and key.

import { useRef, useState } from 'react'
import { useStore } from 'zustand'
import Icon from '../../../Icon'
import Tooltip from '../../../Tooltip'
import { BarCustom, BarPopover } from '../../../office/shell'
import { primaryArtboard } from '@shared/draw/ops'
import { commandById } from '../commands/registry'
import { CmdButton, CmdToggle, canRun, keyOf, useEditor } from '../bar/controls'
import type { EditorCtx } from '../editor/types'

/** The zoom menu's entries: View commands by id, then preset levels. */
export const ZOOM_MENU_COMMANDS = ['view.zoomIn', 'view.zoomOut', 'sep', 'view.fit', 'view.fitAll', 'view.zoomToSelection', 'view.actualSize'] as const
export const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4] as const

/**
 * The zoom level, as a menu: Zoom In / Out, Fit Artboard, Fit All, Zoom to
 * Selection, Actual Size and preset levels. A command that cannot run shows
 * greyed with its reason under it, as in the View menu. Looking, not
 * editing, so it works on a read-only drawing too.
 */
function ZoomMenu({ ctx, zoom }: { ctx: EditorCtx; zoom: number }): JSX.Element {
  useEditor(ctx) // enabled states follow the selection
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = (): void => setOpen(false)
  const run = (id: string, args?: unknown): void => {
    close()
    ctx.run(id, args)
  }
  return (
    <span className="relative inline-flex">
      <Tooltip content="Zoom" placement="bottom">
        <button
          ref={btn}
          type="button"
          aria-label="Zoom"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="draw-zoom-menu"
          onClick={() => setOpen((v) => !v)}
          className="h-7 px-1 inline-flex items-center gap-0.5 rounded text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
        >
          <span className="fb-tabular text-[11px] w-10 text-center" data-testid="draw-zoom">
            {Math.round(zoom * 100)}%
          </span>
          <Icon name="expand_more" size={14} />
        </button>
      </Tooltip>
      {open && (
        <BarPopover anchor={btn.current} onClose={close} role="menu" label="Zoom" testid="draw-zoom-menu-list" minWidth={220}>
          <div className="py-1">
            {ZOOM_MENU_COMMANDS.map((id, i) => {
              if (id === 'sep') return <div key={`s${i}`} className="my-1 h-px bg-[var(--edge-soft)]" />
              const c = commandById(id)
              if (!c) return null
              const on = canRun(ctx, id)
              const why = on ? null : (c.disabledReason?.(ctx) ?? null)
              const key = keyOf(id)
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  disabled={!on}
                  title={why ?? undefined}
                  data-testid={`draw-zoom-item-${id.slice('view.'.length)}`}
                  onClick={() => run(id)}
                  className="w-full flex items-start gap-2 px-2.5 py-1 text-[12px] text-left text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-45 disabled:cursor-not-allowed"
                >
                  <span className="min-w-4 inline-flex justify-center pt-px">{c.icon ? <Icon name={c.icon} size={15} /> : null}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block">{c.label}</span>
                    {why && <span className="block text-[11px] text-[var(--ink-40)]">{why[0].toUpperCase() + why.slice(1)}</span>}
                  </span>
                  {key && <span className="text-[var(--ink-40)] fb-tabular">{key}</span>}
                </button>
              )
            })}
            <div className="my-1 h-px bg-[var(--edge-soft)]" />
            {ZOOM_PRESETS.map((z) => (
              <button
                key={z}
                type="button"
                role="menuitemradio"
                aria-checked={Math.abs(zoom - z) < 1e-6}
                data-testid={`draw-zoom-preset-${Math.round(z * 100)}`}
                onClick={() => run('view.zoomTo', z)}
                className="w-full flex items-center gap-2 px-2.5 py-1 text-[12px] text-left text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
              >
                <span className="min-w-4 inline-flex justify-center">{Math.abs(zoom - z) < 1e-6 ? <Icon name="check" size={14} /> : null}</span>
                <span className="flex-1 fb-tabular">{Math.round(z * 100)}%</span>
              </button>
            ))}
          </div>
        </BarPopover>
      )}
    </span>
  )
}

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
        <ZoomMenu ctx={ctx} zoom={zoom} />
      </BarCustom>
      <CmdButton ctx={ctx} id="view.zoomIn" icon="zoom_in" label="Zoom in" readOnlySafe testid="draw-zoom-in" />
      <CmdButton ctx={ctx} id="view.fit" icon="fit_screen" label="Fit artboard in window" readOnlySafe testid="draw-fit" />
    </>
  )
}
