// Transform preferences, shared by the Transform panel, the selection handles,
// Free Transform, the transform tools and their dialogs -- Illustrator keeps
// these as application preferences, so they persist (per device) and apply
// to every drawing: Scale Strokes & Effects, Scale Corners, the panel's
// reference point and its constrain-proportions link, Transform Objects /
// Patterns, and the last values each dialog was used with.

import { createStore } from 'zustand/vanilla'
import { isRefPoint, type RefPoint } from '@shared/draw/geometry/transform'
import { TRANSFORM_EACH_DEFAULTS, type TransformEachParams } from '@shared/draw/ops'

export interface DialogMemory {
  move: { h: number; v: number }
  rotate: { angle: number }
  reflect: { axis: 'horizontal' | 'vertical' | 'angle'; angle: number }
  scale: { uniform: boolean; percent: number; h: number; v: number }
  shear: { angle: number; axis: 'horizontal' | 'vertical' | 'angle'; axisAngle: number }
  each: TransformEachParams
}

export interface TransformPrefs {
  scaleStrokes: boolean
  scaleCorners: boolean
  refPoint: RefPoint
  constrain: boolean
  /** Transform the objects themselves (the only thing there is to transform until pattern fills exist). */
  transformObjects: boolean
  preview: boolean
  dialogs: DialogMemory
}

export const TRANSFORM_PREF_DEFAULTS: TransformPrefs = {
  // Illustrator's defaults: both off, reference point in the centre.
  scaleStrokes: false,
  scaleCorners: false,
  refPoint: 'c',
  constrain: false,
  transformObjects: true,
  preview: false,
  dialogs: {
    move: { h: 0, v: 0 },
    rotate: { angle: 0 },
    reflect: { axis: 'vertical', angle: 90 },
    scale: { uniform: true, percent: 100, h: 100, v: 100 },
    shear: { angle: 0, axis: 'horizontal', axisAngle: 0 },
    each: TRANSFORM_EACH_DEFAULTS
  }
}

const KEY = 'plexii.draw.transformPrefs'

function load(): TransformPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return TRANSFORM_PREF_DEFAULTS
    const v = JSON.parse(raw) as Partial<TransformPrefs>
    const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d)
    const d = TRANSFORM_PREF_DEFAULTS
    const dialogs = (v.dialogs && typeof v.dialogs === 'object' ? v.dialogs : {}) as Partial<DialogMemory>
    // Each remembered dialog is merged over its defaults, field by field, so a
    // value from an older build never leaves a field undefined.
    const merged = {} as DialogMemory
    for (const k of Object.keys(d.dialogs) as Array<keyof DialogMemory>) {
      const saved = dialogs[k] && typeof dialogs[k] === 'object' ? dialogs[k] : {}
      const out: Record<string, unknown> = { ...d.dialogs[k] }
      for (const [f, dv] of Object.entries(d.dialogs[k])) {
        const sv = (saved as Record<string, unknown>)[f]
        if (typeof sv === typeof dv && (typeof sv !== 'number' || Number.isFinite(sv))) out[f] = sv
      }
      ;(merged as unknown as Record<string, unknown>)[k] = out
    }
    if (!isRefPoint(merged.each.ref)) merged.each = { ...merged.each, ref: 'c' }
    return {
      scaleStrokes: bool(v.scaleStrokes, d.scaleStrokes),
      scaleCorners: bool(v.scaleCorners, d.scaleCorners),
      refPoint: isRefPoint(v.refPoint) ? v.refPoint : d.refPoint,
      constrain: bool(v.constrain, d.constrain),
      transformObjects: true,
      preview: bool(v.preview, d.preview),
      dialogs: merged
    }
  } catch {
    return TRANSFORM_PREF_DEFAULTS
  }
}

export const transformPrefs = createStore<TransformPrefs>(() => load())

transformPrefs.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage unavailable (a private window, a test): the preference lasts for the session.
  }
})

export function setTransformPrefs(patch: Partial<TransformPrefs>): void {
  transformPrefs.setState(patch)
}

export function rememberDialog<K extends keyof DialogMemory>(k: K, v: DialogMemory[K]): void {
  transformPrefs.setState((s) => ({ dialogs: { ...s.dialogs, [k]: v } }))
}

/** Back to the defaults (tests, and a "reset preferences" one day). */
export function resetTransformPrefs(): void {
  transformPrefs.setState(TRANSFORM_PREF_DEFAULTS, true)
}
