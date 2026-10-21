// The layers panel: vector and paint layers in one stack.

import { useStore } from 'zustand'
import DrawLayersPanel from '../DrawLayersPanel'
import type { DrawPanel, EditorCtx } from '../editor/types'

function Layers({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const store = ctx.store
  const layers = useStore(store, (s) => s.doc.layers)
  const activeLayerId = useStore(store, (s) => s.doc.activeLayerId)
  return (
    <DrawLayersPanel
      layers={layers}
      activeLayerId={activeLayerId}
      onSelect={(id) => ctx.run('layer.activate', id)}
      onPatch={(id, patch) => ctx.run('layer.patch', { id, patch })}
      onAdd={(kind) => ctx.run(kind === 'vector' ? 'layer.newVector' : 'layer.newRaster')}
      onDuplicate={(id) => ctx.run('layer.duplicate', id)}
      onDelete={(id) => ctx.run('layer.delete', id)}
      onMove={(id, delta) => ctx.run('layer.move', { id, delta })}
      onMergeDown={(id) => ctx.run('layer.mergeDown', id)}
      onRasterize={(id) => ctx.run('layer.rasterize', id)}
    />
  )
}

const layers: DrawPanel = { id: 'layers', title: 'Layers', dock: 'right', order: 20, height: 260, component: Layers }

export default layers
