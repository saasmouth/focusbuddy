// Path (contextual, a path selected): Illustrator's path commands -- Join,
// Average…, Simplify…, Cut at anchors, Close, Open, Reverse -- then
// Pathfinder (two or more paths) and Compound Path (⌘8 / ⌥⇧⌘8). Its Merge
// button ran "Join into one path", a second, weaker Make Compound Path; it is
// gone, and Compound Path › Make is the one. It was the
// inspector's Path and Pathfinder sections plus the anchor panel's Path row.

import { BarGroup, BarSep } from '../../../office/shell'
import { getObject } from '@shared/draw/ops'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { BarLabel, CmdButton, useEditor } from './controls'

/** The selected paths (top level or inside the isolated group). */
export function selectedPaths(s: Pick<EditorState, 'doc' | 'selection'>): string[] {
  return s.selection.filter((id) => getObject(s.doc, id)?.type === 'path')
}

const BOOLEANS = [
  { op: 'union', icon: 'join_full', label: 'Unite' },
  { op: 'subtract', icon: 'join_left', label: 'Minus front' },
  { op: 'intersect', icon: 'join_inner', label: 'Intersect' },
  { op: 'exclude', icon: 'join_right', label: 'Exclude' }
] as const

function PathTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  // Re-render with the editor: each button's state and reason are read from it.
  useEditor(ctx)
  return (
    <>
      <BarGroup label="Path">
        <CmdButton ctx={ctx} id="path.join" icon="link" testid="draw-path-join" />
        <CmdButton ctx={ctx} id="path.average" icon="vertical_align_center" testid="draw-path-average" />
        <CmdButton ctx={ctx} id="path.simplify" icon="auto_fix_high" testid="draw-path-simplify" />
        <CmdButton ctx={ctx} id="path.cutAtAnchors" icon="content_cut" testid="draw-path-cut" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Open and close">
        <CmdButton ctx={ctx} id="object.closePath" icon="pentagon" testid="draw-path-close" />
        <CmdButton ctx={ctx} id="object.openPath" icon="polyline" testid="draw-path-open" />
        <CmdButton ctx={ctx} id="object.reverse" icon="swap_horiz" testid="draw-path-reverse" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Pathfinder">
        <BarLabel>Pathfinder</BarLabel>
        {BOOLEANS.map((b) => (
          <CmdButton key={b.op} ctx={ctx} id="object.boolean" args={b.op} icon={b.icon} label={b.label} testid={`draw-bool-${b.op}`} />
        ))}
      </BarGroup>
      <BarSep />
      <BarGroup label="Compound path">
        <CmdButton ctx={ctx} id="object.compound.make" icon="join" testid="draw-compound-make" />
        <CmdButton ctx={ctx} id="object.compound.release" icon="call_split" testid="draw-compound-release" />
      </BarGroup>
    </>
  )
}

const path: DrawBarTab = { id: 'path', label: 'Path', order: 140, when: (s) => selectedPaths(s).length > 0, component: PathTab }

export default path
