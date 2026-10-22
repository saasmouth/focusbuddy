// Group (contextual): grouping, isolation mode and clipping masks -- shown
// while a group or clipping group is selected, two or more objects are
// selected (to group or mask them), or a group is isolated. The isolation
// breadcrumb stays on the canvas (render/IsolationBar.tsx).

import { BarGroup, BarSep } from '../../../office/shell'
import { getObject } from '@shared/draw/ops'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { isolationChain } from '../editor/isolation'
import { v2BlockedReason, v2Writable } from '../editor/v2gate'
import { CmdButton, useEditor } from './controls'

export function groupContext(s: EditorState): boolean {
  if (isolationChain(s).length > 0) return true
  if (s.selection.length >= 2) return true
  return s.selection.some((id) => getObject(s.doc, id)?.type === 'group')
}

function GroupTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const v2 = v2Writable(s)
  const needsV2 = `groups and clipping masks need the newer drawing format: ${v2BlockedReason(s)}`
  return (
    <>
      <BarGroup label="Group">
        <CmdButton ctx={ctx} id="object.group" icon="group_work" reason={v2 ? 'select two or more objects' : needsV2} testid="draw-group" />
        <CmdButton ctx={ctx} id="object.ungroup" icon="workspaces" reason="select a group" testid="draw-ungroup" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Isolation mode">
        <CmdButton ctx={ctx} id="object.isolate" icon="center_focus_strong" reason="select one group to isolate" testid="draw-isolate" />
        <CmdButton ctx={ctx} id="object.exitIsolation" icon="filter_center_focus" reason="no group is isolated" testid="draw-exit-isolation" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Clipping mask">
        <CmdButton ctx={ctx} id="object.clip.make" icon="crop" reason={v2 ? 'select the artwork and, on top, the shape to mask it with' : needsV2} testid="draw-clip-make" />
        <CmdButton ctx={ctx} id="object.clip.release" icon="crop_free" reason="select a clipping group" testid="draw-clip-release" />
        <CmdButton ctx={ctx} id="object.clip.editMask" icon="select" reason="select a clipping group" testid="draw-clip-edit-mask" />
        <CmdButton ctx={ctx} id="object.clip.editContents" icon="photo_library" reason="select a clipping group" testid="draw-clip-edit-contents" />
      </BarGroup>
    </>
  )
}

const group: DrawBarTab = { id: 'group', label: 'Group', order: 150, when: groupContext, component: GroupTab }

export default group
