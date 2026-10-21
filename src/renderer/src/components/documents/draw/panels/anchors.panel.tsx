// Anchor points: Illustrator's Properties-panel anchor controls, shown while
// an anchor tool is active with a path selected -- convert to corner or
// smooth, show handles for several anchors, remove anchors, cut the path at
// them, align them, round corners -- plus the Join / Average / Simplify path
// commands, and the Smooth and Path Eraser tool options. Every control runs a
// command, so the menu, the keyboard and this panel do exactly the same thing.

import { useState } from 'react'
import { useStore } from 'zustand'
import Icon from '../../../Icon'
import { commandById } from '../commands/registry'
import type { DrawPanel, EditorCtx, EditorState } from '../editor/types'
import { selectedAnchors } from '../editor/anchorSelection'
import { toolById } from '../tools/registry'
import { getObject } from '@shared/draw/ops'

const TRAIL_TOOLS = new Set(['smooth', 'pathEraser'])

function hasPath(s: EditorState): boolean {
  return s.selection.some((id) => getObject(s.doc, id)?.type === 'path')
}

function Btn({ ctx, id, icon, label, args, testid }: { ctx: EditorCtx; id: string; icon: string; label?: string; args?: unknown; testid: string }): JSX.Element {
  const c = commandById(id)
  // Subscribing to the document and selection keeps enabled() current.
  useStore(ctx.store, (s) => s.doc)
  useStore(ctx.store, (s) => s.selection)
  useStore(ctx.store, (s) => s.anchors)
  const on = !!c && (!c.enabled || c.enabled(ctx))
  return (
    <button
      onClick={() => ctx.run(id, args)}
      disabled={!on}
      title={c?.label}
      aria-label={c?.label}
      data-testid={testid}
      className="h-7 min-w-7 px-1.5 rounded inline-flex items-center justify-center gap-1 text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] disabled:opacity-30 disabled:cursor-not-allowed"
    >
      <Icon name={icon} size={16} />
      {label && <span className="text-[11px]">{label}</span>}
    </button>
  )
}

function AnchorsPanel({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const tool = useStore(ctx.store, (s) => s.tool)
  const prefs = useStore(ctx.store, (s) => s.pathPrefs)
  const count = useStore(ctx.store, (s) => selectedAnchors(s).length)
  const [radius, setRadius] = useState(10)
  const trail = TRAIL_TOOLS.has(tool)
  return (
    <div className="h-full overflow-y-auto px-2 py-1.5 space-y-2 text-[12px]" data-testid="draw-anchors-panel">
      <div className="flex items-center justify-between">
        <span className="font-medium text-[var(--ink-70)]">Anchor points</span>
        <span className="fb-tabular text-[11px] text-[var(--ink-40)]" data-testid="draw-anchors-count">
          {count} selected
        </span>
      </div>

      <div className="flex items-center gap-1">
        <span className="w-14 text-[var(--ink-50)]">Convert</span>
        <Btn ctx={ctx} id="path.convertCorner" icon="change_history" testid="draw-anchor-corner" />
        <Btn ctx={ctx} id="path.convertSmooth" icon="radio_button_unchecked" testid="draw-anchor-smooth" />
        <button
          onClick={() => ctx.run('path.toggleHandles')}
          title="Show handles for multiple selected anchor points"
          aria-pressed={prefs.showHandles}
          data-testid="draw-anchor-handles"
          className={`h-7 w-7 rounded inline-flex items-center justify-center ${prefs.showHandles ? 'bg-accent/15 text-accent' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'}`}
        >
          <Icon name="linear_scale" size={16} />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <span className="w-14 text-[var(--ink-50)]">Anchors</span>
        <Btn ctx={ctx} id="path.removeAnchors" icon="remove" testid="draw-anchor-remove" />
        <Btn ctx={ctx} id="path.cutAtAnchors" icon="content_cut" testid="draw-anchor-cut" />
      </div>

      <div className="flex items-center gap-0.5 flex-wrap">
        <span className="w-14 text-[var(--ink-50)]">Align</span>
        <Btn ctx={ctx} id="path.alignAnchors.left" icon="align_horizontal_left" testid="draw-anchor-align-left" />
        <Btn ctx={ctx} id="path.alignAnchors.hcenter" icon="align_horizontal_center" testid="draw-anchor-align-hcenter" />
        <Btn ctx={ctx} id="path.alignAnchors.right" icon="align_horizontal_right" testid="draw-anchor-align-right" />
        <Btn ctx={ctx} id="path.alignAnchors.top" icon="align_vertical_top" testid="draw-anchor-align-top" />
        <Btn ctx={ctx} id="path.alignAnchors.vcenter" icon="align_vertical_center" testid="draw-anchor-align-vcenter" />
        <Btn ctx={ctx} id="path.alignAnchors.bottom" icon="align_vertical_bottom" testid="draw-anchor-align-bottom" />
      </div>

      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          ctx.run('path.cornerRadius', radius)
        }}
      >
        <span className="w-14 text-[var(--ink-50)]">Corner</span>
        <input
          type="number"
          min={0}
          step={1}
          value={radius}
          onChange={(e) => setRadius(Math.max(0, Number(e.target.value) || 0))}
          className="fb-field w-16 px-1.5 py-0.5"
          aria-label="Corner radius"
          data-testid="draw-anchor-radius"
        />
        <span className="text-[var(--ink-40)]">px</span>
        <Btn ctx={ctx} id="path.cornerRadius" icon="rounded_corner" args={radius} testid="draw-anchor-round" />
      </form>

      <div className="flex items-center gap-1">
        <span className="w-14 text-[var(--ink-50)]">Path</span>
        <Btn ctx={ctx} id="path.join" icon="link" testid="draw-path-join" />
        <Btn ctx={ctx} id="path.average" icon="vertical_align_center" testid="draw-path-average" />
        <Btn ctx={ctx} id="path.simplify" icon="auto_fix_high" testid="draw-path-simplify" />
      </div>

      {trail && (
        <div className="space-y-1.5 border-t border-[var(--edge-soft)] pt-1.5" data-testid="draw-trail-options">
          <span className="font-medium text-[var(--ink-70)]">{toolById(tool)?.label} options</span>
          {tool === 'smooth' && (
            <label className="block">
              <span className="flex justify-between text-[var(--ink-50)]">
                <span>Fidelity</span>
                <span className="fb-tabular">{prefs.smoothFidelity}</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={prefs.smoothFidelity}
                onChange={(e) => ctx.run('path.prefs', { smoothFidelity: Number(e.target.value) })}
                className="w-full"
                data-testid="draw-smooth-fidelity"
              />
              <span className="flex justify-between text-[11px] text-[var(--ink-40)]">
                <span>Accurate</span>
                <span>Smooth</span>
              </span>
            </label>
          )}
          <label className="flex items-center justify-between text-[var(--ink-50)]">
            <span>Size</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={2}
                max={200}
                value={prefs.brushSize}
                onChange={(e) => ctx.run('path.prefs', { brushSize: Math.max(2, Math.min(200, Number(e.target.value) || 2)) })}
                className="fb-field w-16 px-1.5 py-0.5"
                data-testid="draw-trail-size"
              />
              px
            </span>
          </label>
        </div>
      )}
    </div>
  )
}

const anchors: DrawPanel = {
  id: 'anchors',
  title: 'Anchor points',
  dock: 'right',
  order: 15,
  height: 236,
  when: (s) => !!toolById(s.tool)?.anchorTool && (hasPath(s) || TRAIL_TOOLS.has(s.tool)),
  component: AnchorsPanel
}

export default anchors
