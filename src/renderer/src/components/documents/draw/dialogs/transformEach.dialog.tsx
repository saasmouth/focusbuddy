// Object › Transform › Transform Each… (⌥⇧⌘D): scale, move, rotate and
// reflect EACH selected object about its own reference point, optionally by a
// random amount each (between "unchanged" and the value entered). The preview
// shows the very random draw that OK applies.

import { useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { transformEach } from '@shared/draw/ops'
import type { DrawDialog } from '../editor/types'
import DialogFrame from '../transform/DialogFrame'
import { applyEach, editableSelection, transformOptions, frameMatrixRefusal } from '../transform/apply'
import { Check, NumField, RefLocator } from '../transform/fields'
import { rememberDialog, setTransformPrefs, transformPrefs } from '../transform/prefs'
import { selectionNeedsFrameMatrix, transformEachMatrix, nodesBounds } from '@shared/draw/ops'

/** A seeded generator, so the preview and OK draw the same random amounts. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const each: DrawDialog = {
  id: 'transform-each',
  title: 'Transform Each',
  component: function TransformEachDialog({ ctx, close }) {
    const prefs = useStore(transformPrefs)
    const settings = ctx.doc().settings
    const [p, setP] = useState(prefs.dialogs.each)
    const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31))
    const zero = p.scaleH === 0 || p.scaleV === 0
    const key = JSON.stringify(p)
    const sel = useMemo(() => editableSelection(ctx.get()), [ctx])
    return (
      <DialogFrame
        ctx={ctx}
        close={close}
        label="Transform Each"
        testId="draw-each-dialog"
        deps={[key, seed, prefs.scaleStrokes, prefs.scaleCorners]}
        plan={(from) => {
          if (zero) return { doc: from, error: 'A scale of 0% would flatten the artwork to nothing.' }
          const opts = transformOptions({ doc: from, storedSchema: ctx.get().storedSchema, v2Writes: ctx.get().v2Writes })
          if (!opts.frameMatrix && selectionNeedsFrameMatrix(from, sel, (n) => transformEachMatrix(nodesBounds([n]), p, () => 1))) return { doc: from, error: frameMatrixRefusal(ctx.get()) }
          return { doc: transformEach(from, sel, p, opts, false, seeded(seed)).doc }
        }}
        apply={(copy) => {
          rememberDialog('each', p)
          return applyEach(ctx, p, copy, seeded(seed))
        }}
        options={
          <>
            <Check label="Scale Corners" checked={prefs.scaleCorners} onChange={(b) => setTransformPrefs({ scaleCorners: b })} testId="draw-each-corners" />
            <Check label="Scale Strokes & Effects" checked={prefs.scaleStrokes} onChange={(b) => setTransformPrefs({ scaleStrokes: b })} testId="draw-each-strokes" />
          </>
        }
      >
        <fieldset className="grid grid-cols-2 gap-1.5">
          <legend className="text-[11px] text-[var(--ink-50)]">Scale</legend>
          <NumField label="Horizontal scale" prefix="H" kind="pct" value={p.scaleH} onCommit={(scaleH) => setP({ ...p, scaleH })} testId="draw-each-scale-h" live />
          <NumField label="Vertical scale" prefix="V" kind="pct" value={p.scaleV} onCommit={(scaleV) => setP({ ...p, scaleV })} testId="draw-each-scale-v" live />
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-1.5">
          <legend className="text-[11px] text-[var(--ink-50)]">Move</legend>
          <NumField label="Horizontal move" prefix="H" kind="length" settings={settings} value={p.moveH} onCommit={(moveH) => setP({ ...p, moveH })} testId="draw-each-move-h" live />
          <NumField label="Vertical move" prefix="V" kind="length" settings={settings} value={p.moveV} onCommit={(moveV) => setP({ ...p, moveV })} testId="draw-each-move-v" live />
        </fieldset>
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1.5">
            <NumField label="Rotate angle" prefix="∠" kind="deg" value={p.rotate} onCommit={(rotate) => setP({ ...p, rotate })} testId="draw-each-rotate" live />
            <Check label="Reflect X" checked={p.reflectX} onChange={(reflectX) => setP({ ...p, reflectX })} testId="draw-each-reflect-x" />
            <Check label="Reflect Y" checked={p.reflectY} onChange={(reflectY) => setP({ ...p, reflectY })} testId="draw-each-reflect-y" />
            <Check
              label="Random"
              checked={p.random}
              onChange={(random) => {
                setP({ ...p, random })
                setSeed(Math.floor(Math.random() * 2 ** 31))
              }}
              testId="draw-each-random"
            />
          </div>
          <RefLocator value={p.ref} onChange={(ref) => setP({ ...p, ref })} testId="draw-each-ref" />
        </div>
      </DialogFrame>
    )
  }
}

export default each
