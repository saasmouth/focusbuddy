// Shape (contextual, one live shape with parameters selected): a polygon's
// or star's points, a star's inset, a rounded rectangle's corner radius. It
// was the inspector's Shape section.

import { BarGroup, BarNumber } from '../../../office/shell'
import { getObjects } from '@shared/draw/ops'
import type { DrawPathNode } from '@shared/draw/model'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { useEditor } from './controls'

/** The one selected live shape that has parameters to edit, or null. */
export function selectedLiveShape(s: Pick<EditorState, 'doc' | 'selection'>): DrawPathNode | null {
  if (s.selection.length !== 1) return null
  const o = getObjects(s.doc, s.selection)[0]
  return o && o.type === 'path' && (o.shapeKind === 'polygon' || o.shapeKind === 'star' || o.shapeKind === 'roundRect') ? o : null
}

function ShapeTab({ ctx }: { ctx: EditorCtx }): JSX.Element | null {
  const s = useEditor(ctx)
  const shape = selectedLiveShape(s)
  if (!shape) return null
  const reshape = (patch: { cornerRadius?: number; sides?: number; innerRatio?: number }): void => ctx.run('object.reshape', patch)
  return (
    <BarGroup label="Shape">
      {(shape.shapeKind === 'polygon' || shape.shapeKind === 'star') && (
        <BarNumber
          label={shape.shapeKind === 'star' ? 'Points' : 'Sides'}
          value={shape.sides ?? (shape.shapeKind === 'star' ? 5 : 6)}
          min={3}
          max={60}
          width={44}
          onChange={(v) => reshape({ sides: Math.round(v) })}
          testid="draw-shape-sides"
        />
      )}
      {shape.shapeKind === 'star' && (
        <BarNumber label="Inset (inner radius)" value={Math.round((shape.innerRatio ?? 0.5) * 100)} min={5} max={95} suffix="%" width={44} onChange={(v) => reshape({ innerRatio: v / 100 })} testid="draw-shape-inner" />
      )}
      {shape.shapeKind === 'roundRect' && (
        <BarNumber label="Corner radius" value={Math.round(shape.cornerRadius ?? 0)} min={0} suffix="px" width={48} onChange={(v) => reshape({ cornerRadius: Math.max(0, v) })} testid="draw-shape-radius" />
      )}
    </BarGroup>
  )
}

const shape: DrawBarTab = { id: 'shape', label: 'Shape', order: 110, when: (s) => selectedLiveShape(s) !== null, component: ShapeTab }

export default shape
