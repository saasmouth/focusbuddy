// The inspector: appearance and structure for the selection, or the defaults
// the next shape is drawn with when nothing is selected. Every change runs a
// command, so the same edit is available to the menu, the keyboard and any
// future caller.

import { useStore } from 'zustand'
import DrawInspector from '../DrawInspector'
import { getObjects } from '@shared/draw/ops'
import type { DrawPanel, EditorCtx } from '../editor/types'
import { toolById } from '../tools/registry'

function Inspector({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const store = ctx.store
  const doc = useStore(store, (s) => s.doc)
  const selection = useStore(store, (s) => s.selection)
  const fill = useStore(store, (s) => s.fill)
  const stroke = useStore(store, (s) => s.stroke)
  const brush = useStore(store, (s) => s.brush)
  const tool = useStore(store, (s) => s.tool)
  const selected = getObjects(doc, selection)
  const one = selected.length === 1 && (selected[0].type === 'path' || selected[0].type === 'text') ? selected[0] : null
  return (
    <DrawInspector
      selected={selected}
      fill={one ? one.fill : fill}
      stroke={one ? one.stroke : stroke}
      onFill={(p) => ctx.run('object.fill', p)}
      onStroke={(s) => ctx.run('object.stroke', s)}
      onOpacity={(v) => ctx.run('object.opacity', v)}
      onBlend={(b) => ctx.run('object.blend', b)}
      onReshape={(patch) => ctx.run('object.reshape', patch)}
      onBoolean={(op) => ctx.run('object.boolean', op)}
      onAlign={(edge) => ctx.run(`object.align.${edge}`)}
      onDistribute={(axis) => ctx.run('object.distribute', axis)}
      onArrange={(dir) => ctx.run(`object.arrange.${dir}`)}
      onReverse={() => ctx.run('object.reverse')}
      onSetClosed={(closed) => ctx.run('object.setClosed', closed)}
      onJoin={() => ctx.run('object.join')}
      onTextPatch={(patch) => ctx.run('object.textPatch', patch)}
      brush={brush}
      onBrush={(patch) => ctx.run('brush.set', patch)}
      showBrush={toolById(tool)?.paint === true}
    />
  )
}

const inspector: DrawPanel = { id: 'inspector', title: 'Inspector', dock: 'right', order: 10, component: Inspector }

export default inspector
