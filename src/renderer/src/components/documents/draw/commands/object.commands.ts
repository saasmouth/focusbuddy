// Object menu (Pathfinder, Arrange, Align, Group, Lock, Hide, Clipping Mask,
// Compound Path, isolation mode) and the object edits the inspector runs:
// appearance, live-shape parameters, type, path tools.
//
// Groups and clipping masks exist only in the v2 drawing format. v2 writes are
// on, so a v1 drawing becomes v2 when grouped; only where a drawing must stay
// v1 (a live session with someone on an older version, editor/v2gate.ts) are
// Group and Make Clipping Mask disabled, and they say why -- never a silent
// no-op. Compound paths, Lock and Hide need nothing v1 lacks.

import type { DrawBlend } from '@shared/draw'
import type { BooleanOp } from '@shared/drawGeometry'
import type { DrawDocPaint, DrawDocStroke, DrawNode, DrawTextNode } from '@shared/draw/model'
import {
  arrangeNodes,
  booleanObjects,
  artworkAboveIds,
  canArrange,
  canMakeCompound,
  clearFlagAll,
  clipGroupsFor,
  clipShapeOf,
  compoundPathIds,
  editContentsTargets,
  editMaskTarget,
  fillRuleOf,
  fillRuleTargets,
  flagLayers,
  flagNodes,
  flaggedIds,
  getObject,
  groupNodes,
  isClipPathPlace,
  makeClipMask,
  makeClipProblem,
  makeCompoundPath,
  otherLayerIds,
  outermostIds,
  pickForGrouping,
  releaseClipMask,
  releaseCompoundPath,
  setFillRule,
  ungroupNodes,
  type FillRule,
  type MakeClipProblem,
  type NodePlace,
  distributeObjects,
  editableIds,
  joinPaths,
  mapObjects,
  reshape,
  reversePath,
  setPathClosed,
  type AlignEdge,
  type ArrangeDir
} from '@shared/draw/ops'
import type { Command, EditorCtx, EditorState, MenuSpec } from '../editor/types'
import { enterIsolation, exitIsolation, isIsolated, isolatedGroup, scopeNodes } from '../editor/isolation'
import { v2BlockedReason, v2Writable } from '../editor/v2gate'
import { alignSelection, canAlign } from './align.commands'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

export const menus: MenuSpec[] = [
  { path: 'object', label: 'Object', order: 30 },
  { path: 'object/Pathfinder', label: 'Pathfinder', icon: 'join_full', order: 100 },
  { path: 'object/Arrange', label: 'Arrange', icon: 'layers', order: 110 },
  { path: 'object/Align', label: 'Align', icon: 'align_horizontal_center', order: 120 },
  { path: 'object/Lock', label: 'Lock', icon: 'lock', order: 300 },
  { path: 'object/Hide', label: 'Hide', icon: 'visibility_off', order: 320 },
  { path: 'object/Clipping Mask', label: 'Clipping Mask', icon: 'crop', order: 400 },
  { path: 'object/Compound Path', label: 'Compound Path', icon: 'join_left', order: 410 }
]

/** Combine the selected paths (Pathfinder); one undo step. */
export function runBoolean(ctx: EditorCtx, op: BooleanOp): void {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  const { doc, newId } = booleanObjects(s.doc, ids, op)
  if (doc === s.doc) return
  ctx.history.commit(doc, 'Pathfinder')
  ctx.select(newId ? [newId] : [])
  if (!newId) ctx.status('The subtraction removed the shape entirely.')
}

/** Change the selected objects that may be edited; one undo step. */
export function patchSelected(ctx: EditorCtx, fn: (o: DrawNode) => DrawNode, label = 'Edit'): void {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  if (!ids.length) return
  ctx.history.commit(mapObjects(s.doc, ids, fn), label)
}

/**
 * Change paths and type in the selection -- and, for a selected group, every
 * path and type inside it (but never a clipping group's clip path), which is
 * what applying a colour to a group does in Illustrator.
 */
export function patchSelectedDeep(ctx: EditorCtx, fn: (o: DrawNode) => DrawNode, label: string): void {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  if (!ids.length) return
  const deep = (o: DrawNode): DrawNode => {
    if (o.type !== 'group') return fn(o)
    const clip = clipShapeOf(o)
    const children = o.children.map((c) => (c === clip || c.locked ? c : deep(c)))
    return children.every((c, i) => c === o.children[i]) ? o : { ...o, children }
  }
  ctx.history.commit(mapObjects(s.doc, ids, deep), label)
}

const BOOLEANS: Array<{ op: BooleanOp; label: string; id: string }> = [
  { op: 'union', label: 'Unite', id: 'unite' },
  { op: 'subtract', label: 'Minus front', id: 'minusFront' },
  { op: 'intersect', label: 'Intersect', id: 'intersect' },
  { op: 'exclude', label: 'Exclude', id: 'exclude' }
]

const ARRANGE: Array<{ dir: ArrangeDir; label: string }> = [
  { dir: 'front', label: 'Bring to front' },
  { dir: 'forward', label: 'Bring forward' },
  { dir: 'backward', label: 'Send backward' },
  { dir: 'back', label: 'Send to back' }
]

const ALIGN: AlignEdge[] = ['left', 'center', 'right', 'top', 'middle', 'bottom']

// ── Group, Lock, Hide, Clipping Mask, Compound Path, isolation ───────────────

/**
 * Can this drawing hold groups and clipping masks? Only once it is written in
 * the v2 format: v2 writes are switched on, or it was stored as v2, or it
 * already holds something only v2 can carry.
 */
export function holdsV2Content(s: EditorState): boolean {
  return v2Writable(s)
}

const v2Needed = (s: EditorState): string => `Groups and clipping masks need the newer PlexiiDraw drawing format: ${v2BlockedReason(s)}.`

/** Run `go` when `ok`, otherwise say why nothing happened (a key press reaches a command even when its menu item is greyed). */
/** Runs made by guarded(): they say why they cannot work, so a key may run them while disabled. */
const explaining = new WeakSet<Command['run']>()

function guarded(ok: (ctx: EditorCtx) => boolean, why: (ctx: EditorCtx) => string, go: (ctx: EditorCtx) => void): Command['run'] {
  const run: Command['run'] = (ctx) => {
    if (ctx.get().readOnly) return
    if (!ok(ctx)) {
      ctx.status(why(ctx))
      return
    }
    go(ctx)
  }
  explaining.add(run)
  return run
}

const editableSel = (ctx: EditorCtx): string[] => editableIds(ctx.doc(), ctx.get().selection)

function groupPicks(ctx: EditorCtx): NodePlace[] {
  return pickForGrouping(ctx.doc(), ctx.get().selection, editableIds)
}

const canGroup = (ctx: EditorCtx): boolean => {
  const picks = groupPicks(ctx)
  return writable(ctx) && holdsV2Content(ctx.get()) && picks.length > 0 && !picks.some(isClipPathPlace)
}

const selectedGroups = (ctx: EditorCtx): string[] => {
  const doc = ctx.doc()
  return editableSel(ctx).filter((id) => getObject(doc, id)?.type === 'group')
}

/** The isolated group's id when isolated, so Unlock All / Show All stay inside it. */
const isolatedId = (ctx: EditorCtx): string | undefined => isolatedGroup(ctx.get())?.id ?? undefined

/** After Unlock All / Show All: select what came back, as Illustrator does (only what can be selected now). */
function selectRestored(ctx: EditorCtx, ids: string[]): void {
  const doc = ctx.doc()
  ctx.select(outermostIds(doc, editableIds(doc, ids)))
}

const CLIP_PROBLEM: Record<Exclude<MakeClipProblem, null>, string> = {
  nothing: 'Select the artwork to mask and, on top of it, the shape to mask it with.',
  'one-object': 'Select at least two objects: the topmost one becomes the clipping path.',
  'top-not-a-shape': 'The topmost selected object must be a path, a compound path or type to clip with.',
  'clip-path-picked': 'That is already a clipping path. Release the mask first.'
}

const RULES: Array<{ rule: FillRule; label: string }> = [
  { rule: 'nonzero', label: 'Non-zero winding fill rule' },
  { rule: 'evenodd', label: 'Even-odd fill rule' }
]

const objectCommands: Command[] = [
  {
    id: 'object.group',
    label: 'Group',
    icon: 'group_work',
    menu: { path: 'object', order: 200 },
    enabled: canGroup,
    run: guarded(
      canGroup,
      (ctx) => (!holdsV2Content(ctx.get()) ? v2Needed(ctx.get()) : groupPicks(ctx).some(isClipPathPlace) ? CLIP_PROBLEM['clip-path-picked'] : 'Select the objects to group first.'),
      (ctx) => {
        const { doc, groupId } = groupNodes(ctx.doc(), groupPicks(ctx))
        if (!groupId) return
        ctx.history.commit(doc, 'Group')
        ctx.select([groupId])
      }
    )
  },
  {
    id: 'object.ungroup',
    label: 'Ungroup',
    icon: 'workspaces',
    menu: { path: 'object', order: 201 },
    enabled: (ctx) => writable(ctx) && selectedGroups(ctx).length > 0,
    run: guarded(
      (ctx) => selectedGroups(ctx).length > 0,
      () => 'Select a group to ungroup.',
      (ctx) => {
        const { doc, ids, droppedEffects } = ungroupNodes(ctx.doc(), selectedGroups(ctx))
        ctx.history.commit(doc, 'Ungroup')
        ctx.select(ids)
        if (droppedEffects) ctx.status('The group’s own effects were removed with it.')
      }
    )
  },
  // Lock
  {
    id: 'object.lock.selection',
    label: 'Selection',
    menu: { path: 'object/Lock', order: 0 },
    enabled: (ctx) => writable(ctx) && editableSel(ctx).length > 0,
    run: guarded(
      (ctx) => editableSel(ctx).length > 0,
      () => 'Select the objects to lock.',
      (ctx) => {
        ctx.history.commit(flagNodes(ctx.doc(), editableSel(ctx), 'locked'), 'Lock')
        ctx.select([])
      }
    )
  },
  {
    id: 'object.lock.above',
    label: 'All artwork above',
    menu: { path: 'object/Lock', order: 1 },
    enabled: (ctx) => writable(ctx) && artworkAboveIds(ctx.doc(), editableSel(ctx), 'locked').length > 0,
    run: guarded(
      (ctx) => artworkAboveIds(ctx.doc(), editableSel(ctx), 'locked').length > 0,
      () => 'Nothing overlaps the selection from above.',
      (ctx) => ctx.history.commit(flagNodes(ctx.doc(), artworkAboveIds(ctx.doc(), editableSel(ctx), 'locked'), 'locked'), 'Lock')
    )
  },
  {
    id: 'object.lock.otherLayers',
    label: 'Other layers',
    menu: { path: 'object/Lock', order: 2 },
    enabled: (ctx) => writable(ctx) && editableSel(ctx).length > 0 && otherLayerIds(ctx.doc(), editableSel(ctx), 'locked').length > 0,
    run: guarded(
      (ctx) => editableSel(ctx).length > 0 && otherLayerIds(ctx.doc(), editableSel(ctx), 'locked').length > 0,
      () => 'There are no other unlocked layers.',
      (ctx) => ctx.history.commit(flagLayers(ctx.doc(), otherLayerIds(ctx.doc(), editableSel(ctx), 'locked'), 'locked'), 'Lock other layers')
    )
  },
  {
    id: 'object.unlockAll',
    label: 'Unlock all',
    icon: 'lock_open',
    menu: { path: 'object', order: 310 },
    enabled: (ctx) => writable(ctx) && flaggedIds(ctx.doc(), 'locked', isolatedId(ctx)).length > 0,
    run: guarded(
      (ctx) => flaggedIds(ctx.doc(), 'locked', isolatedId(ctx)).length > 0,
      () => 'Nothing is locked.',
      (ctx) => {
        const { doc, ids } = clearFlagAll(ctx.doc(), 'locked', isolatedId(ctx))
        ctx.history.commit(doc, 'Unlock all')
        selectRestored(ctx, ids)
      }
    )
  },
  // Hide
  {
    id: 'object.hide.selection',
    label: 'Selection',
    menu: { path: 'object/Hide', order: 0 },
    enabled: (ctx) => writable(ctx) && editableSel(ctx).length > 0,
    run: guarded(
      (ctx) => editableSel(ctx).length > 0,
      () => 'Select the objects to hide.',
      (ctx) => {
        ctx.history.commit(flagNodes(ctx.doc(), editableSel(ctx), 'hidden'), 'Hide')
        ctx.select([])
      }
    )
  },
  {
    id: 'object.hide.above',
    label: 'All artwork above',
    menu: { path: 'object/Hide', order: 1 },
    enabled: (ctx) => writable(ctx) && artworkAboveIds(ctx.doc(), editableSel(ctx), 'hidden').length > 0,
    run: guarded(
      (ctx) => artworkAboveIds(ctx.doc(), editableSel(ctx), 'hidden').length > 0,
      () => 'Nothing overlaps the selection from above.',
      (ctx) => ctx.history.commit(flagNodes(ctx.doc(), artworkAboveIds(ctx.doc(), editableSel(ctx), 'hidden'), 'hidden'), 'Hide')
    )
  },
  {
    id: 'object.hide.otherLayers',
    label: 'Other layers',
    menu: { path: 'object/Hide', order: 2 },
    enabled: (ctx) => writable(ctx) && editableSel(ctx).length > 0 && otherLayerIds(ctx.doc(), editableSel(ctx), 'hidden').length > 0,
    run: guarded(
      (ctx) => editableSel(ctx).length > 0 && otherLayerIds(ctx.doc(), editableSel(ctx), 'hidden').length > 0,
      () => 'There are no other visible layers.',
      (ctx) => ctx.history.commit(flagLayers(ctx.doc(), otherLayerIds(ctx.doc(), editableSel(ctx), 'hidden'), 'hidden'), 'Hide other layers')
    )
  },
  {
    id: 'object.showAll',
    label: 'Show all',
    icon: 'visibility',
    menu: { path: 'object', order: 330 },
    enabled: (ctx) => writable(ctx) && flaggedIds(ctx.doc(), 'hidden', isolatedId(ctx)).length > 0,
    run: guarded(
      (ctx) => flaggedIds(ctx.doc(), 'hidden', isolatedId(ctx)).length > 0,
      () => 'Nothing is hidden.',
      (ctx) => {
        const { doc, ids } = clearFlagAll(ctx.doc(), 'hidden', isolatedId(ctx))
        ctx.history.commit(doc, 'Show all')
        selectRestored(ctx, ids)
      }
    )
  },
  // Clipping Mask
  {
    id: 'object.clip.make',
    label: 'Make',
    menu: { path: 'object/Clipping Mask', order: 0 },
    enabled: (ctx) => writable(ctx) && holdsV2Content(ctx.get()) && makeClipProblem(ctx.doc(), ctx.get().selection) === null,
    run: guarded(
      (ctx) => holdsV2Content(ctx.get()) && makeClipProblem(ctx.doc(), ctx.get().selection) === null,
      (ctx) => (!holdsV2Content(ctx.get()) ? v2Needed(ctx.get()) : CLIP_PROBLEM[makeClipProblem(ctx.doc(), ctx.get().selection) ?? 'nothing']),
      (ctx) => {
        const { doc, groupId } = makeClipMask(ctx.doc(), ctx.get().selection)
        if (!groupId) return
        ctx.history.commit(doc, 'Make clipping mask')
        ctx.select([groupId])
      }
    )
  },
  {
    id: 'object.clip.release',
    label: 'Release',
    menu: { path: 'object/Clipping Mask', order: 1 },
    enabled: (ctx) => writable(ctx) && clipGroupsFor(ctx.doc(), ctx.get().selection).length > 0,
    run: guarded(
      (ctx) => clipGroupsFor(ctx.doc(), ctx.get().selection).length > 0,
      () => 'Select a clipping group to release.',
      (ctx) => {
        const { doc, groupIds } = releaseClipMask(ctx.doc(), ctx.get().selection)
        ctx.history.commit(doc, 'Release clipping mask')
        ctx.select(groupIds)
      }
    )
  },
  {
    id: 'object.clip.editMask',
    label: 'Edit mask',
    menu: { path: 'object/Clipping Mask', order: 100 },
    enabled: (ctx) => editMaskTarget(ctx.doc(), ctx.get().selection) !== null,
    run: guarded(
      (ctx) => editMaskTarget(ctx.doc(), ctx.get().selection) !== null,
      () => 'Select one clipping group.',
      (ctx) => ctx.select([editMaskTarget(ctx.doc(), ctx.get().selection)!])
    )
  },
  {
    id: 'object.clip.editContents',
    label: 'Edit contents',
    menu: { path: 'object/Clipping Mask', order: 101 },
    enabled: (ctx) => editContentsTargets(ctx.doc(), ctx.get().selection).length > 0,
    run: guarded(
      (ctx) => editContentsTargets(ctx.doc(), ctx.get().selection).length > 0,
      () => 'Select one clipping group with something in it.',
      (ctx) => ctx.select(editContentsTargets(ctx.doc(), ctx.get().selection))
    )
  },
  // Compound Path
  {
    id: 'object.compound.make',
    label: 'Make',
    menu: { path: 'object/Compound Path', order: 0 },
    enabled: (ctx) => writable(ctx) && canMakeCompound(ctx.doc(), ctx.get().selection),
    run: guarded(
      (ctx) => canMakeCompound(ctx.doc(), ctx.get().selection),
      () => 'Select two or more paths (or groups of paths) to make a compound path.',
      (ctx) => {
        const { doc, newId } = makeCompoundPath(ctx.doc(), ctx.get().selection)
        if (!newId) return
        ctx.history.commit(doc, 'Make compound path')
        ctx.select([newId])
      }
    )
  },
  {
    id: 'object.compound.release',
    label: 'Release',
    menu: { path: 'object/Compound Path', order: 1 },
    enabled: (ctx) => writable(ctx) && compoundPathIds(ctx.doc(), ctx.get().selection).length > 0,
    run: guarded(
      (ctx) => compoundPathIds(ctx.doc(), ctx.get().selection).length > 0,
      () => 'Select a compound path to release.',
      (ctx) => {
        const { doc, ids } = releaseCompoundPath(ctx.doc(), ctx.get().selection)
        ctx.history.commit(doc, 'Release compound path')
        ctx.select(ids)
      }
    )
  },
  ...RULES.map(
    (r, i): Command => ({
      id: `object.fillRule.${r.rule}`,
      label: r.label,
      menu: { path: 'object/Compound Path', order: 100 + i },
      enabled: (ctx) => writable(ctx) && fillRuleTargets(ctx.doc(), ctx.get().selection).length > 0,
      checked: (ctx) => fillRuleOf(ctx.doc(), ctx.get().selection) === r.rule,
      run: guarded(
        (ctx) => fillRuleTargets(ctx.doc(), ctx.get().selection).length > 0,
        () => 'Select a path to set its fill rule.',
        (ctx) => ctx.history.commit(setFillRule(ctx.doc(), ctx.get().selection, r.rule), 'Fill rule')
      )
    })
  ),
  // Isolation mode
  {
    id: 'object.isolate',
    label: 'Isolate selected group',
    icon: 'center_focus_strong',
    menu: { path: 'object', order: 500 },
    enabled: (ctx) => isolatableSelection(ctx) !== null,
    run: guarded(
      (ctx) => isolatableSelection(ctx) !== null,
      () => 'Select one group to isolate.',
      (ctx) => void enterIsolation(ctx, isolatableSelection(ctx)!)
    )
  },
  {
    id: 'object.exitIsolation',
    label: 'Exit isolation mode',
    icon: 'filter_center_focus',
    menu: { path: 'object', order: 501 },
    enabled: (ctx) => isIsolated(ctx.get()),
    run: (ctx) => exitIsolation(ctx)
  }
]

/** How many paths are selected (a path the commands above can act on). */
function selectedPathCount(ctx: EditorCtx): number {
  const doc = ctx.doc()
  return ctx.get().selection.filter((id) => getObject(doc, id)?.type === 'path').length
}

/** The one selected group that sits at the current level (top level, or in the isolated group), or null. */
function isolatableSelection(ctx: EditorCtx): string | null {
  const s = ctx.get()
  if (s.readOnly || s.selection.length !== 1) return null
  const id = s.selection[0]
  const here = scopeNodes(s).find(({ node }) => node.id === id)
  return here && here.node.type === 'group' && !here.node.locked && !here.node.hidden ? id : null
}

export const commands: Command[] = [
  ...BOOLEANS.map(
    (b, i): Command => ({
      id: `object.${b.id}`,
      label: b.label,
      menu: { path: 'object/Pathfinder', order: i },
      enabled: writable,
      run: (ctx) => runBoolean(ctx, b.op)
    })
  ),
  { id: 'object.boolean', label: 'Pathfinder', enabled: writable, run: (ctx, op) => runBoolean(ctx, op as BooleanOp) },
  ...ARRANGE.map(
    (a, i): Command => ({
      id: `object.arrange.${a.dir}`,
      label: a.label,
      menu: { path: 'object/Arrange', order: i },
      // Within each object's own layer or group (inside groups too).
      enabled: (ctx) => writable(ctx) && canArrange(ctx.doc(), editableIds(ctx.doc(), ctx.get().selection), a.dir),
      run: (ctx) => {
        const s = ctx.get()
        ctx.history.commit(arrangeNodes(s.doc, editableIds(s.doc, s.selection), a.dir), a.label)
      }
    })
  ),
  ...ALIGN.map(
    (edge, i): Command => ({
      id: `object.align.${edge}`,
      // Display spelling is the owner's (centre); the edge id stays `center`.
      label: edge === 'center' ? 'Centre' : edge[0].toUpperCase() + edge.slice(1),
      menu: { path: 'object/Align', order: i },
      // To the selection, the key object or the artboard (align.commands.ts).
      enabled: canAlign,
      run: (ctx) => alignSelection(ctx, edge)
    })
  ),
  {
    id: 'object.distribute',
    label: 'Distribute',
    enabled: writable,
    run: (ctx, axis) => ctx.history.commit(distributeObjects(ctx.doc(), ctx.get().selection, axis as 'h' | 'v'), 'Distribute')
  },
  // Close, Open and Reverse lived only in the old inspector; they are in the
  // Path tab and here in Object › Path too (the menu is the whole command index).
  {
    id: 'object.closePath',
    label: 'Close path',
    menu: { path: 'object/Path', order: 300 },
    enabled: (ctx) => writable(ctx) && selectedPathCount(ctx) > 0,
    run: (ctx) => ctx.run('object.setClosed', true)
  },
  {
    id: 'object.openPath',
    label: 'Open path',
    menu: { path: 'object/Path', order: 301 },
    enabled: (ctx) => writable(ctx) && selectedPathCount(ctx) > 0,
    run: (ctx) => ctx.run('object.setClosed', false)
  },
  {
    id: 'object.reverse',
    label: 'Reverse path direction',
    menu: { path: 'object/Path', order: 302 },
    enabled: (ctx) => writable(ctx) && selectedPathCount(ctx) > 0,
    run: (ctx) => {
      let next = ctx.doc()
      for (const id of ctx.get().selection) next = reversePath(next, id)
      ctx.history.commit(next, 'Reverse path')
    }
  },
  {
    id: 'object.setClosed',
    label: 'Open or close path',
    enabled: writable,
    run: (ctx, closed) => {
      let next = ctx.doc()
      for (const id of ctx.get().selection) next = setPathClosed(next, id, closed === true)
      ctx.history.commit(next, closed ? 'Close path' : 'Open path')
    }
  },
  {
    id: 'object.join',
    label: 'Join into one path',
    menu: { path: 'object/Path', order: 303 },
    enabled: (ctx) => writable(ctx) && selectedPathCount(ctx) > 1,
    run: (ctx) => {
      const { doc, newId } = joinPaths(ctx.doc(), ctx.get().selection)
      if (doc === ctx.doc()) return
      ctx.history.commit(doc, 'Join paths')
      ctx.select(newId ? [newId] : [])
    }
  },
  {
    id: 'object.reshape',
    label: 'Shape parameters',
    enabled: writable,
    run: (ctx, patch) => {
      const id = ctx.get().selection[0]
      if (id) ctx.history.commit(reshape(ctx.doc(), id, patch as { cornerRadius?: number; sides?: number; innerRatio?: number }), 'Shape')
    }
  },
  {
    id: 'object.fill',
    label: 'Fill',
    run: (ctx, paint) => {
      // With nothing selected this sets the fill the NEXT shape is drawn with.
      ctx.set({ fill: paint as DrawDocPaint })
      patchSelectedDeep(ctx, (o) => (o.type === 'path' || o.type === 'text' ? { ...o, fill: paint as DrawDocPaint } : o), 'Fill')
    }
  },
  {
    id: 'object.stroke',
    label: 'Stroke',
    run: (ctx, stroke) => {
      const s = stroke as DrawDocStroke | undefined
      ctx.set({ stroke: s })
      patchSelectedDeep(ctx, (o) => (o.type === 'path' || o.type === 'text' ? (s ? { ...o, stroke: s } : { ...o, stroke: undefined }) : o), 'Stroke')
    }
  },
  {
    id: 'object.opacity',
    label: 'Opacity',
    run: (ctx, v) => patchSelected(ctx, (o) => ({ ...o, opacity: v as number }), 'Opacity')
  },
  {
    id: 'object.blend',
    label: 'Blend mode',
    run: (ctx, b) => patchSelected(ctx, (o) => ({ ...o, blend: b as DrawBlend }), 'Blend mode')
  },
  {
    id: 'object.textPatch',
    label: 'Type settings',
    run: (ctx, patch) => patchSelected(ctx, (o) => (o.type === 'text' ? ctx.text.measure({ ...o, ...(patch as Partial<DrawTextNode>) }) : o), 'Type')
  },
  ...objectCommands.map((c) => (explaining.has(c.run) ? { ...c, explainsWhenDisabled: true } : c))
]
