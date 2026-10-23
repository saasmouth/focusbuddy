// Insert: what Draw can put on the canvas from outside it — Place… (an
// image, the rail's Image item runs the same command), Place as template…,
// Insert snippet… and New Artboard. Every office app has an Insert tab second
// (SPEC §3.9). Each button IS its command: label, icon, key and enabled state
// come from the command registry, so this tab adds no wording of its own.

import { BarSep } from '../../../office/shell'
import type { DrawBarTab, EditorCtx } from '../editor/types'
import { CmdButton, useEditor } from './controls'

function InsertTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  useEditor(ctx) // re-render when enabled states change
  return (
    <>
      <CmdButton ctx={ctx} id="file.place" showLabel testid="draw-insert-place" />
      <CmdButton ctx={ctx} id="file.placeTemplate" showLabel testid="draw-insert-template" />
      <BarSep />
      <CmdButton ctx={ctx} id="edit.insertSnippet" showLabel testid="draw-insert-snippet" />
      <BarSep />
      <CmdButton ctx={ctx} id="artboard.new" showLabel testid="draw-insert-artboard" />
    </>
  )
}

const insert: DrawBarTab = { id: 'insert', label: 'Insert', role: 'insert', order: 15, component: InsertTab }

export default insert
