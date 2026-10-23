// Anchors (contextual): Illustrator's Properties-panel anchor controls, while
// an anchor tool is active with a path selected or anchors are selected --
// convert to corner or smooth, show handles for several anchors, remove
// anchors, cut the path at them, align them, round corners -- plus the Smooth
// and Path Eraser tool options. It was the Anchor points panel. Every control
// runs a command, so the menu, the keyboard and this tab do the same thing.

import { useState } from 'react'
import { BarCustom, BarGroup, BarNumber, BarSep } from '../../../office/shell'
import { getObject } from '@shared/draw/ops'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { partialAnchors, selectedAnchors } from '../editor/anchorSelection'
import { toolById } from '../tools/registry'
import { BarLabel, CmdButton, CmdToggle, useEditor } from './controls'

const TRAIL_TOOLS = new Set(['smooth', 'pathEraser'])

function hasPath(s: Pick<EditorState, 'doc' | 'selection'>): boolean {
  return s.selection.some((id) => getObject(s.doc, id)?.type === 'path')
}

/**
 * Shown while an anchor tool is active on a path (or a trail tool), or while
 * particular anchors are selected (a path picked out anchor by anchor with
 * Direct Selection or Lasso), whatever tool is active then.
 */
export function anchorsContext(s: EditorState): boolean {
  return (!!toolById(s.tool)?.anchorTool && (hasPath(s) || TRAIL_TOOLS.has(s.tool))) || partialAnchors(s).length > 0
}

function AnchorsTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const prefs = s.pathPrefs
  const count = selectedAnchors(s).length
  const [radius, setRadius] = useState(10)
  const trail = TRAIL_TOOLS.has(s.tool)
  return (
    <>
      <span className="shrink-0 px-1 fb-tabular text-[11px] text-[var(--ink-50)]" data-testid="draw-anchors-count">
        {count} selected
      </span>
      <BarSep />
      <BarGroup label="Convert">
        <BarLabel>Convert</BarLabel>
        <CmdButton ctx={ctx} id="path.convertCorner" icon="change_history" testid="draw-anchor-corner" />
        <CmdButton ctx={ctx} id="path.convertSmooth" icon="radio_button_unchecked" testid="draw-anchor-smooth" />
        <CmdToggle ctx={ctx} id="path.toggleHandles" icon="linear_scale" label="Show handles for multiple selected anchor points" pressed={prefs.showHandles} readOnlySafe testid="draw-anchor-handles" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Anchors">
        <CmdButton ctx={ctx} id="path.removeAnchors" icon="remove" testid="draw-anchor-remove" />
        <CmdButton ctx={ctx} id="path.cutAtAnchors" icon="content_cut" testid="draw-anchor-cut" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Align anchors">
        <CmdButton ctx={ctx} id="path.alignAnchors.left" icon="align_horizontal_left" testid="draw-anchor-align-left" />
        <CmdButton ctx={ctx} id="path.alignAnchors.hcenter" icon="align_horizontal_center" testid="draw-anchor-align-hcenter" />
        <CmdButton ctx={ctx} id="path.alignAnchors.right" icon="align_horizontal_right" testid="draw-anchor-align-right" />
        <CmdButton ctx={ctx} id="path.alignAnchors.top" icon="align_vertical_top" testid="draw-anchor-align-top" />
        <CmdButton ctx={ctx} id="path.alignAnchors.vcenter" icon="align_vertical_center" testid="draw-anchor-align-vcenter" />
        <CmdButton ctx={ctx} id="path.alignAnchors.bottom" icon="align_vertical_bottom" testid="draw-anchor-align-bottom" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Corner">
        <BarNumber label="Corner radius" value={radius} min={0} suffix="px" width={44} onChange={(v) => setRadius(Math.max(0, v))} testid="draw-anchor-radius" />
        <CmdButton ctx={ctx} id="path.cornerRadius" icon="rounded_corner" args={radius} testid="draw-anchor-round" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Path">
        <CmdButton ctx={ctx} id="path.join" icon="link" testid="draw-path-join" />
        <CmdButton ctx={ctx} id="path.average" icon="vertical_align_center" testid="draw-path-average" />
        <CmdButton ctx={ctx} id="path.simplify" icon="auto_fix_high" testid="draw-path-simplify" />
      </BarGroup>
      {trail && (
        <>
          <BarSep />
          <BarCustom label={`${toolById(s.tool)?.label} options`} testid="draw-trail-options">
            <BarLabel>{toolById(s.tool)?.label}</BarLabel>
            {s.tool === 'smooth' && (
              <BarNumber label="Fidelity (0 accurate, 100 smooth)" value={prefs.smoothFidelity} min={0} max={100} width={40} onChange={(v) => ctx.run('path.prefs', { smoothFidelity: Math.round(v) })} testid="draw-smooth-fidelity" />
            )}
            <BarNumber label="Size" value={prefs.brushSize} min={2} max={200} suffix="px" width={44} onChange={(v) => ctx.run('path.prefs', { brushSize: Math.round(v) })} testid="draw-trail-size" />
          </BarCustom>
        </>
      )}
    </>
  )
}

const anchors: DrawBarTab = { id: 'anchors', label: 'Anchors', order: 130, when: anchorsContext, component: AnchorsTab }

export default anchors
