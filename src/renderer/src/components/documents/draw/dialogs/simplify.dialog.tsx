// Object > Path > Simplify…: fewer anchor points, same shape. Simplify Curve
// runs from Minimum to Maximum points; Corner Point Angle Threshold keeps
// corners sharper than it as corners; Convert to Straight Lines drops every
// curve; Auto-Simplify picks the fewest points that stay within half a pixel
// of the original. Preview shows the result live; Cancel puts the paths back.
// The whole dialog is ONE undo step.

import { useEffect, useMemo, useRef, useState } from 'react'
import { pathBounds, pathToSvgD, transformPath, unionBox } from '@shared/drawGeometry'
import { maxDeviation } from '@shared/draw/geometry/bezier'
import { SIMPLIFY_DEFAULTS, type SimplifyOptions } from '@shared/draw/geometry/fit'
import type { DrawDoc, DrawPathNode } from '@shared/draw/model'
import { anchorCount, editableIds, getObject, nodeMatrix, simplifyPaths } from '@shared/draw/ops'
import type { DrawDialog, Txn } from '../editor/types'

/** The fewest-points precision whose result stays within `maxError` px of every original path. */
export function autoSimplifyPrecision(doc: DrawDoc, ids: string[], opts: Omit<SimplifyOptions, 'precision'>, maxError = 0.5): number {
  const ok = (p: number): boolean => {
    const out = simplifyPaths(doc, ids, { ...opts, precision: p })
    return ids.every((id) => {
      const a = getObject(doc, id) as DrawPathNode | undefined
      const b = getObject(out, id) as DrawPathNode | undefined
      return !a || !b || maxDeviation(a.path, b.path, 12) <= maxError
    })
  }
  if (ok(0)) return 0
  let lo = 0
  let hi = 100
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2
    if (ok(mid)) hi = mid
    else lo = mid
  }
  return Math.round(hi)
}

/** The original outline (grey) under the simplified one (accent), fitted to a small box. */
function Compare({ base, result, ids }: { base: DrawDoc; result: DrawDoc; ids: string[] }): JSX.Element | null {
  const shapes = ids
    .map((id) => ({ a: getObject(base, id), b: getObject(result, id), m: nodeMatrix(base, id) }))
    .filter((x): x is { a: DrawPathNode; b: DrawPathNode; m: ReturnType<typeof nodeMatrix> } => x.a?.type === 'path' && x.b?.type === 'path')
  if (!shapes.length) return null
  const box = unionBox(shapes.map((x) => pathBounds(transformPath(x.a.path, x.m))))
  const pad = Math.max(box.w, box.h) * 0.05 + 1
  const k = Math.max(box.w, box.h) / 300
  return (
    <svg viewBox={`${box.x - pad} ${box.y - pad} ${box.w + 2 * pad} ${box.h + 2 * pad}`} className="w-full h-40 rounded bg-[var(--surface-sunken)]" data-testid="draw-simplify-compare">
      {shapes.map((x) => (
        <g key={x.a.id}>
          <path d={pathToSvgD(transformPath(x.a.path, x.m))} fill="none" stroke="#a8a29e" strokeWidth={3 * k} />
          <path d={pathToSvgD(transformPath(x.b.path, x.m))} fill="none" stroke="#6d5dfc" strokeWidth={1.2 * k} />
        </g>
      ))}
    </svg>
  )
}

const simplify: DrawDialog = {
  id: 'simplify',
  title: 'Simplify',
  component: function SimplifyDialog({ ctx, close }) {
    const base = useMemo(() => ctx.doc(), [])
    const ids = useMemo(() => {
      const s = ctx.get()
      return editableIds(base, s.selection).filter((id) => getObject(base, id)?.type === 'path')
    }, [])
    const [opts, setOpts] = useState<SimplifyOptions>(SIMPLIFY_DEFAULTS)
    const [preview, setPreview] = useState(true)
    const [showOriginal, setShowOriginal] = useState(false)
    const txn = useRef<Txn | null>(null)
    const done = useRef(false)
    const result = useMemo(() => simplifyPaths(base, ids, opts), [base, ids, opts])
    const before = anchorCount(base, ids)
    const after = anchorCount(result, ids)

    // One streamed undo step for the dialog's life; closing without OK undoes it.
    useEffect(() => {
      done.current = false
      txn.current = ctx.history.begin('Simplify')
      return () => {
        if (!done.current) {
          txn.current?.preview(base)
          txn.current?.cancel()
        }
        txn.current = null
      }
    }, [])
    useEffect(() => {
      txn.current?.preview(preview ? result : base)
    }, [result, preview])

    const field = (label: string, key: 'precision' | 'angleThreshold', min: number, max: number, unit: string, testid: string, hint?: [string, string]): JSX.Element => (
      <label className="block">
        <span className="flex justify-between text-[var(--ink-50)]">
          <span>{label}</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={min}
              max={max}
              value={opts[key]}
              onChange={(e) => setOpts((o) => ({ ...o, [key]: Math.max(min, Math.min(max, Number(e.target.value) || 0)) }))}
              className="fb-field w-16 px-1.5 py-0.5 text-right"
              data-testid={`${testid}-value`}
            />
            {unit}
          </span>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          value={opts[key]}
          onChange={(e) => setOpts((o) => ({ ...o, [key]: Number(e.target.value) }))}
          className="w-full"
          data-testid={testid}
        />
        {hint && (
          <span className="flex justify-between text-[11px] text-[var(--ink-40)]">
            <span>{hint[0]}</span>
            <span>{hint[1]}</span>
          </span>
        )}
      </label>
    )

    return (
      <div className="space-y-3 text-[13px] w-[340px] max-w-full" data-testid="draw-simplify-dialog">
        {field('Simplify Curve', 'precision', 0, 100, '%', 'draw-simplify-precision', ['Minimum points', 'Maximum points'])}
        {field('Corner Point Angle Threshold', 'angleThreshold', 0, 180, '°', 'draw-simplify-angle', ['Smooth', 'Sharp'])}
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={opts.straightLines} onChange={(e) => setOpts((o) => ({ ...o, straightLines: e.target.checked }))} data-testid="draw-simplify-straight" />
            Convert to Straight Lines
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} data-testid="draw-simplify-original" />
            Show Original Path
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} data-testid="draw-simplify-preview" />
            Preview
          </label>
        </div>
        {showOriginal && <Compare base={base} result={result} ids={ids} />}
        <p className="fb-tabular text-[12px] text-[var(--ink-60)]" data-testid="draw-simplify-counts">
          Original: {before} points · Current: {after} points
        </p>
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            onClick={() => setOpts((o) => ({ ...o, precision: autoSimplifyPrecision(base, ids, o) }))}
            className="fb-btn-surface px-3 py-1.5"
            data-testid="draw-simplify-auto"
            title="The fewest points that stay within half a pixel of the original"
          >
            Auto-Simplify
          </button>
          <div className="flex gap-2">
            <button onClick={close} className="fb-btn-surface px-3 py-1.5" data-testid="draw-simplify-cancel">
              Cancel
            </button>
            <button
              onClick={() => {
                txn.current?.preview(result)
                if (result === base) txn.current?.cancel()
                else txn.current?.commit()
                done.current = true
                ctx.set({ anchors: {} })
                close()
              }}
              data-testid="draw-simplify-apply"
              className="btn-primary px-3 py-1.5"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default simplify
