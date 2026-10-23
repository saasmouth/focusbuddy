// Object > Path (WP-PATH): Join, Average, Simplify, Add Anchor Points, Remove
// Anchor Points, Cut Path at Selected Anchor Points, and the anchor commands
// the Anchor points panel runs (convert, handles, align, corner radius), plus
// the keymap chords that pick the Anchor Point (⇧C) and Curvature (⇧~) tools.

import {
  addMidpointAnchors,
  alignAnchors,
  anchorAsEndpoint,
  averageAnchors,
  convertAnchors,
  cutAtAnchors,
  editableIds,
  getObject,
  joinEndpoints,
  joinPathsByEnds,
  openEndpoints,
  removeAnchorsJoined,
  roundAnchorCorners,
  type AnchorAlignEdge,
  type AnchorRef,
  type AverageAxis,
  type EndpointRef
} from '@shared/draw/ops'
import type { Command, EditorCtx, MenuSpec, PathPrefs } from '../editor/types'
import { partialAnchors, selectAnchors, selectedAnchors, wholeSelection } from '../editor/anchorSelection'
import { firstOf, gate, notReadOnly, unless, type Why } from './gate'


export const menus: MenuSpec[] = [{ path: 'object/Path', label: 'Path', icon: 'timeline', order: 125 }]

/** Selected path ids that may be edited (wholly or partly selected). */
export function selectedPathIds(ctx: EditorCtx): string[] {
  const s = ctx.get()
  return editableIds(s.doc, s.selection).filter((id) => getObject(s.doc, id)?.type === 'path')
}

/** Only anchors on paths that may be edited: never on a locked or hidden path, nor on a locked or hidden layer. */
function editableRefs<R extends { id: string }>(ctx: EditorCtx, refs: R[]): R[] {
  const ok = new Set(editableIds(ctx.get().doc, [...new Set(refs.map((r) => r.id))]))
  return refs.filter((r) => ok.has(r.id))
}
/** The anchors the anchor commands act on (whole selected paths count as all their anchors). */
export const editableAnchors = (ctx: EditorCtx): AnchorRef[] => editableRefs(ctx, selectedAnchors(ctx.get()))
/** The anchors picked with Direct Selection that may be edited. */
const editablePicked = (ctx: EditorCtx): AnchorRef[] => editableRefs(ctx, partialAnchors(ctx.get()))

const LOCKED_ANCHORS = 'Those anchor points are on a locked or hidden path.'

/**
 * Why an anchor command cannot act: fewer than `min` editable anchors. When
 * there are enough anchors but some sit on locked or hidden art, it says so
 * rather than asking for a selection that is already there.
 */
function anchorsWhy(all: (ctx: EditorCtx) => AnchorRef[], min: number, reason: string): Why {
  return firstOf(notReadOnly, (ctx) => {
    const refs = all(ctx)
    if (editableRefs(ctx, refs).length >= min) return null
    return refs.length >= min ? LOCKED_ANCHORS : reason
  })
}

/** The two endpoints a ⌘J with anchors picked would join, or null. */
function pickedEndpoints(ctx: EditorCtx): [EndpointRef, EndpointRef] | null {
  const s = ctx.get()
  const ends = editablePicked(ctx)
    .map((r) => anchorAsEndpoint(s.doc, r))
    .filter((e): e is EndpointRef => !!e)
  return ends.length === 2 ? [ends[0], ends[1]] : null
}

/** Why ⌘J (and Average & Join) cannot join now, or null. */
const joinWhy: Why = firstOf(notReadOnly, (ctx) => {
  const s = ctx.get()
  if (partialAnchors(s).length) {
    if (!editablePicked(ctx).length) return LOCKED_ANCHORS
    const pair = pickedEndpoints(ctx)
    const ok = !!pair && !(pair[0].id === pair[1].id && pair[0].si === pair[1].si && pair[0].end === pair[1].end)
    return ok ? null : 'Select two open end points to join them.'
  }
  return openEndpoints(s.doc, wholeSelection(s)).length > 0 ? null : 'Select open paths, or two of their end points, to join them.'
})

const anySelected = (ctx: EditorCtx): AnchorRef[] => selectedAnchors(ctx.get())
const anyPicked = (ctx: EditorCtx): AnchorRef[] => partialAnchors(ctx.get())
const oneAnchor = anchorsWhy(anySelected, 1, 'Select anchor points first.')
const twoAnchors = anchorsWhy(anySelected, 2, 'Select two or more anchor points to average them.')
const aPath = (reason: string): Why => unless((ctx) => selectedPathIds(ctx).length > 0, reason)
const pickedAnchors = (reason: string): Why => anchorsWhy(anyPicked, 1, reason)

/** ⌘J: join the two picked endpoints, or chain the selected open paths by their nearest ends. */
export function runJoin(ctx: EditorCtx, average: boolean): void {
  const s = ctx.get()
  let result: { doc: typeof s.doc; id: string } | null = null
  if (partialAnchors(s).length) {
    const pair = pickedEndpoints(ctx)
    if (pair) result = joinEndpoints(s.doc, pair[0], pair[1], average)
    if (!result) {
      ctx.status('To join, select two open end points (or whole open paths).')
      return
    }
  } else {
    result = joinPathsByEnds(s.doc, wholeSelection(s), average)
    if (!result) {
      ctx.status('Nothing to join: the selection has no open path ends.')
      return
    }
  }
  ctx.history.commit(result.doc, average ? 'Average & Join' : 'Join')
  ctx.select([result.id])
}

const ALIGN: Array<{ edge: AnchorAlignEdge; label: string }> = [
  { edge: 'left', label: 'Align anchors left' },
  { edge: 'hcenter', label: 'Align anchors to horizontal centre' },
  { edge: 'right', label: 'Align anchors right' },
  { edge: 'top', label: 'Align anchors top' },
  { edge: 'vcenter', label: 'Align anchors to vertical centre' },
  { edge: 'bottom', label: 'Align anchors bottom' }
]

export const commands: Command[] = [
  {
    id: 'path.join',
    label: 'Join',
    icon: 'link',
    menu: { path: 'object/Path', order: 0 },
    ...gate(joinWhy),
    run: (ctx) => runJoin(ctx, false)
  },
  {
    id: 'path.average',
    label: 'Average…',
    menu: { path: 'object/Path', order: 1 },
    ...gate(twoAnchors),
    run: (ctx) => {
      if (editableAnchors(ctx).length < 2) return
      ctx.set({ dialog: { id: 'average' } })
    }
  },
  {
    id: 'path.averageJoin',
    label: 'Average & Join',
    menu: { path: 'object/Path', order: 2 },
    ...gate(joinWhy),
    run: (ctx) => runJoin(ctx, true)
  },
  {
    id: 'path.averageApply',
    label: 'Average anchor points',
    ...gate(twoAnchors),
    run: (ctx, axis) => {
      const refs = editableAnchors(ctx)
      const next = averageAnchors(ctx.doc(), refs, (axis as AverageAxis) ?? 'both')
      if (next !== ctx.doc()) ctx.history.commit(next, 'Average')
    }
  },
  {
    id: 'path.simplify',
    label: 'Simplify…',
    menu: { path: 'object/Path', order: 100 },
    ...gate(firstOf(notReadOnly, aPath('Select a path to simplify it.'))),
    run: (ctx) => {
      if (selectedPathIds(ctx).length) ctx.set({ dialog: { id: 'simplify' } })
    }
  },
  {
    id: 'path.addAnchorPoints',
    label: 'Add Anchor Points',
    menu: { path: 'object/Path', order: 110 },
    ...gate(firstOf(notReadOnly, aPath('Select a path to add anchor points to it.'))),
    run: (ctx) => {
      const ids = selectedPathIds(ctx)
      const next = addMidpointAnchors(ctx.doc(), ids)
      if (next === ctx.doc()) return
      ctx.history.commit(next, 'Add anchor points')
      ctx.select(ids)
    }
  },
  {
    id: 'path.removeAnchors',
    label: 'Remove Anchor Points',
    icon: 'remove',
    menu: { path: 'object/Path', order: 120 },
    ...gate(pickedAnchors('Select anchor points with the Direct Selection tool to remove them.')),
    run: (ctx) => {
      const s = ctx.get()
      const refs = editablePicked(ctx)
      if (!refs.length) return
      const next = removeAnchorsJoined(s.doc, refs)
      ctx.history.commit(next, 'Remove anchor points')
      const left = [...new Set(refs.map((r) => r.id))].filter((id) => getObject(next, id))
      selectAnchors(ctx, [], { keepEmpty: left })
    }
  },
  {
    id: 'path.cutAtAnchors',
    label: 'Cut Path at Selected Anchor Points',
    icon: 'content_cut',
    menu: { path: 'object/Path', order: 130 },
    ...gate(pickedAnchors('Select anchor points with the Direct Selection tool to cut the path there.')),
    run: (ctx) => {
      const s = ctx.get()
      const { doc, ids } = cutAtAnchors(s.doc, editablePicked(ctx))
      if (doc === s.doc) {
        ctx.status('Nothing to cut: an open path cannot be cut at its own end point.')
        return
      }
      ctx.history.commit(doc, 'Cut path')
      ctx.select(ids)
    }
  },
  {
    id: 'path.convertCorner',
    label: 'Convert selected anchor points to corner',
    icon: 'change_history',
    ...gate(oneAnchor),
    run: (ctx) => {
      const next = convertAnchors(ctx.doc(), editableAnchors(ctx), 'corner')
      if (next !== ctx.doc()) ctx.history.commit(next, 'Convert to corner')
    }
  },
  {
    id: 'path.convertSmooth',
    label: 'Convert selected anchor points to smooth',
    icon: 'radio_button_unchecked',
    ...gate(oneAnchor),
    run: (ctx) => {
      const next = convertAnchors(ctx.doc(), editableAnchors(ctx), 'smooth')
      if (next !== ctx.doc()) ctx.history.commit(next, 'Convert to smooth')
    }
  },
  {
    id: 'path.toggleHandles',
    label: 'Show handles for multiple selected anchor points',
    checked: (ctx) => ctx.get().pathPrefs.showHandles,
    run: (ctx) => ctx.set((s) => ({ pathPrefs: { ...s.pathPrefs, showHandles: !s.pathPrefs.showHandles } }))
  },
  {
    id: 'path.prefs',
    label: 'Path tool options',
    run: (ctx, patch) => ctx.set((s) => ({ pathPrefs: { ...s.pathPrefs, ...(patch as Partial<PathPrefs>) } }))
  },
  ...ALIGN.map(
    (a): Command => ({
      id: `path.alignAnchors.${a.edge}`,
      label: a.label,
      ...gate(anchorsWhy(anySelected, 2, 'Select two or more anchor points to align them.')),
      run: (ctx) => {
        const next = alignAnchors(ctx.doc(), editableAnchors(ctx), a.edge)
        if (next !== ctx.doc()) ctx.history.commit(next, 'Align anchor points')
      }
    })
  ),
  {
    id: 'path.cornerRadius',
    label: 'Round corners',
    ...gate(oneAnchor),
    run: (ctx, r) => {
      const radius = Number(r)
      if (!(radius > 0)) return
      const res = roundAnchorCorners(ctx.doc(), editableAnchors(ctx), radius)
      if (res.doc === ctx.doc()) {
        ctx.status('Only corner points (no handles, two neighbours) can be rounded.')
        return
      }
      ctx.history.commit(res.doc, 'Round corners')
      selectAnchors(ctx, res.refs)
    }
  }
]
