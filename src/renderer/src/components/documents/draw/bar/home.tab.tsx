// Home: the selection's appearance -- Fill, Stroke (paint, width, dash, ends
// and corners), Opacity and Blend -- or, with nothing selected, the fill and
// stroke the NEXT shape is drawn with (Illustrator's "set the fill, then
// draw"). It was the top of the right-hand inspector.

import { BarGroup, BarNumber, BarSelect, BarSep } from '../../../office/shell'
import { DRAW_BLEND_MODES, type DrawBlend } from '@shared/draw'
import type { DrawDocStroke } from '@shared/draw/model'
import { getObjects } from '@shared/draw/ops'
import type { DrawBarTab, EditorCtx } from '../editor/types'
import { BarLabel, PaintButton, useEditor } from './controls'

const NONE_SELECTED = 'select an object first'
const NO_STROKE = 'choose a stroke paint first'

function Home({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const selected = getObjects(s.doc, s.selection)
  const one = selected.length === 1 ? selected[0] : null
  const painted = one && (one.type === 'path' || one.type === 'text') ? one : null
  const fill = painted ? painted.fill : s.fill
  const stroke = painted ? painted.stroke : s.stroke
  const setStroke = (next: DrawDocStroke | undefined): void => ctx.run('object.stroke', next)
  const what = selected.length ? (selected.length > 1 ? ` (${selected.length} selected)` : '') : ' (next shape)'
  const dashed = !!stroke?.dash?.length
  return (
    <>
      <BarGroup label="Fill and stroke">
        <PaintButton label={`Fill${what}`} value={fill} swatches={s.doc.swatches} onChange={(p) => ctx.run('object.fill', p)} testid="draw-fill" />
        <PaintButton
          label={`Stroke${what}`}
          value={stroke?.paint ?? { type: 'none' }}
          swatches={s.doc.swatches}
          stroke
          onChange={(paint) => setStroke(paint.type === 'none' ? undefined : { width: stroke?.width ?? 2, cap: stroke?.cap, join: stroke?.join, dash: stroke?.dash, ...stroke, paint })}
          testid="draw-stroke"
        />
      </BarGroup>
      <BarSep />
      <BarGroup label="Stroke">
        <BarLabel>Width</BarLabel>
        <BarNumber
          label="Stroke width"
          value={stroke?.width}
          min={0.1}
          step={0.5}
          suffix="px"
          width={46}
          disabled={!stroke}
          disabledReason={NO_STROKE}
          onChange={(w) => stroke && setStroke({ ...stroke, width: Math.max(0.1, w) })}
          testid="draw-stroke-width"
        />
        <BarSelect
          label="Dashes"
          value={dashed ? 'dashed' : 'solid'}
          width={76}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'dashed', label: 'Dashed' }
          ]}
          disabled={!stroke}
          disabledReason={NO_STROKE}
          onChange={(v) => stroke && setStroke({ ...stroke, dash: v === 'dashed' ? [stroke.width * 3, stroke.width * 2] : [] })}
          testid="draw-stroke-dash"
        />
        <BarSelect
          label="Ends (cap)"
          value={stroke?.cap ?? 'butt'}
          width={70}
          options={[
            { value: 'butt', label: 'Flat' },
            { value: 'round', label: 'Round' },
            { value: 'square', label: 'Square' }
          ]}
          disabled={!stroke}
          disabledReason={NO_STROKE}
          onChange={(cap) => stroke && setStroke({ ...stroke, cap })}
          testid="draw-stroke-cap"
        />
        <BarSelect
          label="Corners (join)"
          value={stroke?.join ?? 'miter'}
          width={70}
          options={[
            { value: 'miter', label: 'Sharp' },
            { value: 'round', label: 'Round' },
            { value: 'bevel', label: 'Bevel' }
          ]}
          disabled={!stroke}
          disabledReason={NO_STROKE}
          onChange={(join) => stroke && setStroke({ ...stroke, join })}
          testid="draw-stroke-join"
        />
      </BarGroup>
      <BarSep />
      <BarGroup label="Appearance">
        <BarLabel>Opacity</BarLabel>
        <BarNumber
          label="Opacity"
          value={selected.length ? Math.round((one?.opacity ?? 1) * 100) : undefined}
          min={0}
          max={100}
          suffix="%"
          width={40}
          disabled={!selected.length}
          disabledReason={NONE_SELECTED}
          onChange={(v) => ctx.run('object.opacity', v / 100)}
          testid="draw-object-opacity"
        />
        <BarSelect<DrawBlend>
          label="Blend mode"
          value={one?.blend ?? 'normal'}
          width={96}
          options={DRAW_BLEND_MODES.map((b) => ({ value: b, label: b[0].toUpperCase() + b.slice(1).replace('-', ' ') }))}
          disabled={!selected.length}
          disabledReason={NONE_SELECTED}
          onChange={(b) => ctx.run('object.blend', b)}
          testid="draw-object-blend"
        />
      </BarGroup>
    </>
  )
}

const home: DrawBarTab = { id: 'home', label: 'Home', role: 'home', order: 10, component: Home }

export default home
