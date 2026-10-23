// Group (contextual): grouping, isolation mode and clipping masks -- shown
// while a group or clipping group is selected, two or more objects are
// selected (to group or mask them), or a group is isolated. The isolation
// breadcrumb stays on the canvas (render/IsolationBar.tsx).

import { BarGroup, BarSep } from '../../../office/shell'
import { getObject } from '@shared/draw/ops'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { isolationChain } from '../editor/isolation'
import { CmdButton, useEditor } from './controls'

export function groupContext(s: EditorState): boolean {
  if (isolationChain(s).length > 0) return true
  if (s.selection.length >= 2) return true
  return s.selection.some((id) => getObject(s.doc, id)?.type === 'group')
}

function GroupTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  // Re-render with the editor: each button's state and reason are read from it.
  useEditor(ctx)
  return (
    <>
      <BarGroup label="Group">
        <CmdButton ctx={ctx} id="object.group" icon="group_work" testid="draw-group" />
        <CmdButton ctx={ctx} id="object.ungroup" icon="workspaces" testid="draw-ungroup" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Isolation mode">
        <CmdButton ctx={ctx} id="object.isolate" icon="center_focus_strong" testid="draw-isolate" />
        <CmdButton ctx={ctx} id="object.exitIsolation" icon="filter_center_focus" testid="draw-exit-isolation" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Clipping mask">
        <CmdButton ctx={ctx} id="object.clip.make" icon="crop" testid="draw-clip-make" />
        <CmdButton ctx={ctx} id="object.clip.release" icon="crop_free" testid="draw-clip-release" />
        <CmdButton ctx={ctx} id="object.clip.editMask" icon="select" testid="draw-clip-edit-mask" />
        <CmdButton ctx={ctx} id="object.clip.editContents" icon="photo_library" testid="draw-clip-edit-contents" />
      </BarGroup>
    </>
  )
}

const group: DrawBarTab = { id: 'group', label: 'Group', order: 150, when: groupContext, component: GroupTab }

export default group
