// Object: Illustrator's Transform panel in one row (the 9-point reference,
// X, Y, W, H with Constrain, Rotate, Shear, Flip, Scale Corners and Scale
// Strokes & Effects), Arrange, Transform Again and the Transform dialogs.
// X, Y, W and H are measured at the reference point, in the document's units
// and relative to the artboard; every field takes expressions ("100+20",
// "50%", "2in", "*2") and commits one undo step on Enter or blur. Everything
// applies through transform/apply.ts, so Transform Again repeats an edit
// made here too.

import { useStore } from 'zustand'
import { BarCustom, BarGroup, BarMenu, BarSep, BarToggle, READ_ONLY_REASON } from '../../../office/shell'
import type { Matrix } from '@shared/drawGeometry'
import { about, boxToBox, refPointOf, translation } from '@shared/draw/geometry/transform'
import { primaryArtboard } from '@shared/draw/ops'
import { commandById } from '../commands/registry'
import type { DrawBarTab, EditorCtx } from '../editor/types'
import { applyTransform } from '../transform/apply'
import { NumField, RefLocator } from '../transform/fields'
import { setTransformPrefs, transformPrefs } from '../transform/prefs'
import { orientationDelta, resizedAt, transformReadout } from '../transform/readout'
import { CmdButton, canRun, keyOf, useBarReadOnly, useEditor } from './controls'

const NOTHING = 'select an object first'

/** The Transform cluster (X/Y/W/H, Rotate, Shear and the reference point). Also used by tests. */
export function TransformCluster({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const s = useEditor(ctx)
  const prefs = useStore(transformPrefs)
  const readOnly = useBarReadOnly() || s.readOnly
  const r = transformReadout(s.doc, s.selection)
  const board = primaryArtboard(s.doc)
  const settings = s.doc.settings
  const ref = prefs.refPoint
  const off = readOnly || !r
  const why = readOnly ? READ_ONLY_REASON : NOTHING
  const rp = r ? refPointOf(r.box, ref) : null

  const apply = (m: Matrix, label: string, linear?: Matrix): void => {
    applyTransform(ctx, m, linear ? { label, record: { kind: 'ref', ref }, linear } : { label, record: { kind: 'absolute' } })
  }
  function setPos(axis: 'x' | 'y', v: number): void {
    if (!r || !rp) return
    const now = axis === 'x' ? rp.x - board.x : rp.y - board.y
    if (Math.abs(v - now) < 1e-9) return
    apply(axis === 'x' ? translation(v - now, 0) : translation(0, v - now), 'Move')
  }
  function setSize(axis: 'w' | 'h', v: number): void {
    if (!r) return
    const b = r.box
    if (v <= 0) {
      ctx.status('Width and height have to be more than 0.')
      return
    }
    let w = axis === 'w' ? v : b.w
    let h = axis === 'h' ? v : b.h
    if (prefs.constrain) {
      if (axis === 'w' && b.w > 0) h = b.h * (v / b.w)
      if (axis === 'h' && b.h > 0) w = b.w * (v / b.h)
    }
    if (Math.abs(w - b.w) < 1e-9 && Math.abs(h - b.h) < 1e-9) return
    const m = boxToBox(b, resizedAt(b, ref, w, h), ref)
    apply(m, 'Scale', [m[0], 0, 0, m[3], 0, 0])
  }
  function setOrientation(want: { rotate?: number; shear?: number }, label: string): void {
    if (!r || !rp) return
    if (want.shear !== undefined && Math.abs(Math.cos((want.shear * Math.PI) / 180)) < 1e-3) {
      ctx.status('A shear of 90° would flatten the artwork into a line.')
      return
    }
    const d = orientationDelta(r.single, want)
    if (!d) return
    apply(about(rp, d), label, d)
  }
  const zeroW = !!r && r.box.w < 1e-9
  const zeroH = !!r && r.box.h < 1e-9
  const tip = (label: string, extra?: string): string => (off ? `${label} — ${why}` : extra ? `${label} — ${extra}` : label)

  return (
    <BarCustom label="Transform" testid="draw-transform-panel">
      <RefLocator compact value={ref} onChange={(refPoint) => setTransformPrefs({ refPoint })} disabled={readOnly} />
      <NumField label="X" prefix="X" kind="length" settings={settings} value={rp ? rp.x - board.x : null} onCommit={(v) => setPos('x', v)} disabled={off} title={tip('X')} testId="draw-transform-x" className="w-[74px]" />
      <NumField label="Y" prefix="Y" kind="length" settings={settings} value={rp ? rp.y - board.y : null} onCommit={(v) => setPos('y', v)} disabled={off} title={tip('Y')} testId="draw-transform-y" className="w-[74px]" />
      <NumField
        label="Width"
        prefix="W"
        kind="length"
        settings={settings}
        value={r ? r.box.w : null}
        onCommit={(v) => setSize('w', v)}
        disabled={off || zeroW}
        title={zeroW ? 'Width — this selection has no width to scale' : tip('Width')}
        testId="draw-transform-w"
        className="w-[74px]"
      />
      <BarToggle
        icon={prefs.constrain ? 'link' : 'link_off'}
        label="Constrain Width and Height Proportions"
        pressed={prefs.constrain}
        onChange={(constrain) => setTransformPrefs({ constrain })}
        readOnlySafe
        testid="draw-transform-constrain"
      />
      <NumField
        label="Height"
        prefix="H"
        kind="length"
        settings={settings}
        value={r ? r.box.h : null}
        onCommit={(v) => setSize('h', v)}
        disabled={off || zeroH}
        title={zeroH ? 'Height — this selection has no height to scale' : tip('Height')}
        testId="draw-transform-h"
        className="w-[74px]"
      />
      <NumField
        label="Rotate"
        prefix="⟲"
        kind="deg"
        value={r ? r.rotate : null}
        onCommit={(v) => setOrientation({ rotate: v }, 'Rotate')}
        disabled={off}
        title={tip('Rotate', 'counter-clockwise. Paths keep their geometry baked, so a path reads 0° after turning.')}
        testId="draw-transform-rotate"
        className="w-[64px]"
      />
      <NumField label="Shear" prefix="⫽" kind="deg" value={r ? r.shear : null} onCommit={(v) => setOrientation({ shear: v }, 'Shear')} disabled={off} title={tip('Shear', 'a positive angle slants clockwise')} testId="draw-transform-shear" className="w-[64px]" />
    </BarCustom>
  )
}

const ARRANGE = [
  { dir: 'front', icon: 'flip_to_front' },
  { dir: 'forward', icon: 'keyboard_arrow_up' },
  { dir: 'backward', icon: 'keyboard_arrow_down' },
  { dir: 'back', icon: 'flip_to_back' }
] as const

function ObjectTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  useEditor(ctx)
  const prefs = useStore(transformPrefs)
  const menuItem = (id: string, testid: string): { label: string; run: () => void; disabled: boolean; shortcut?: string; testid: string } => ({
    label: commandById(id)?.label ?? id,
    run: () => ctx.run(id),
    disabled: !canRun(ctx, id),
    shortcut: keyOf(id),
    testid
  })
  return (
    <>
      <TransformCluster ctx={ctx} />
      <BarGroup label="Flip">
        <CmdButton ctx={ctx} id="object.flipHorizontal" icon="flip" reason={NOTHING} testid="draw-transform-flip-h" />
        <span className="inline-flex [&_.material-symbols-outlined]:rotate-90 [&_svg]:rotate-90">
          <CmdButton ctx={ctx} id="object.flipVertical" icon="flip" reason={NOTHING} testid="draw-transform-flip-v" />
        </span>
      </BarGroup>
      <BarGroup label="Transform options">
        <BarToggle icon="rounded_corner" label="Scale Corners" pressed={prefs.scaleCorners} onChange={(scaleCorners) => setTransformPrefs({ scaleCorners })} readOnlySafe testid="draw-transform-scale-corners" />
        <BarToggle icon="line_weight" label="Scale Strokes & Effects" pressed={prefs.scaleStrokes} onChange={(scaleStrokes) => setTransformPrefs({ scaleStrokes })} readOnlySafe testid="draw-transform-scale-strokes" />
      </BarGroup>
      <BarSep />
      <BarGroup label="Arrange">
        {ARRANGE.map((a) => (
          <CmdButton key={a.dir} ctx={ctx} id={`object.arrange.${a.dir}`} icon={a.icon} reason="nothing to move in the stacking order" testid={`draw-arrange-${a.dir}`} />
        ))}
      </BarGroup>
      <BarSep />
      <CmdButton ctx={ctx} id="object.transformAgain" icon="replay" reason="transform something first" testid="draw-transform-again" />
      <BarMenu
        icon="transform"
        label="Transform"
        testid="draw-transform-menu"
        items={[
          menuItem('object.transform.move', 'draw-transform-menu-move'),
          menuItem('object.transform.rotate', 'draw-transform-menu-rotate'),
          menuItem('object.transform.reflect', 'draw-transform-menu-reflect'),
          menuItem('object.transform.scale', 'draw-transform-menu-scale'),
          menuItem('object.transform.shear', 'draw-transform-menu-shear'),
          'sep',
          menuItem('object.transform.each', 'draw-transform-menu-each'),
          menuItem('object.transform.resetBoundingBox', 'draw-transform-menu-reset')
        ]}
      />
    </>
  )
}

const object: DrawBarTab = { id: 'object', label: 'Object', order: 20, component: ObjectTab }

export default object
