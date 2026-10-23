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

/** The two endpoints a ⌘J with anchors picked would join, or null. */
function pickedEndpoints(ctx: EditorCtx): [EndpointRef, EndpointRef] | null {
  const s = ctx.get()
  const ends = partialAnchors(s)
    .map((r) => anchorAsEndpoint(s.doc, r))
    .filter((e): e is EndpointRef => !!e)
  return ends.length === 2 ? [ends[0], ends[1]] : null
}

/** Why ⌘J (and Average & Join) cannot join now, or null. */
const joinWhy: Why = firstOf(notReadOnly, (ctx) => {
  const s = ctx.get()
  if (partialAnchors(s).length) {
    const pair = pickedEndpoints(ctx)
    const ok = !!pair && !(pair[0].id === pair[1].id && pair[0].si === pair[1].si && pair[0].end === pair[1].end)
    return ok ? null : 'Select two open end points to join them.'
  }
  return openEndpoints(s.doc, wholeSelection(s)).length > 0 ? null : 'Select open paths, or two of their end points, to join them.'
})

const oneAnchor = unless((ctx) => selectedAnchors(ctx.get()).length > 0, 'Select anchor points first.')
const twoAnchors = unless((ctx) => selectedAnchors(ctx.get()).length >= 2, 'Select two or more anchor points to average them.')
const aPath = (reason: string): Why => unless((ctx) => selectedPathIds(ctx).length > 0, reason)
const pickedAnchors = (reason: string): Why => unless((ctx) => partialAnchors(ctx.get()).length > 0, reason)

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
    ...gate(firstOf(notReadOnly, twoAnchors)),
    run: (ctx) => {
      if (selectedAnchors(ctx.get()).length < 2) return
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
    ...gate(firstOf(notReadOnly, twoAnchors)),
    run: (ctx, axis) => {
      const refs = selectedAnchors(ctx.get())
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
    ...gate(firstOf(notReadOnly, pickedAnchors('Select anchor points with the Direct Selection tool to remove them.'))),
    run: (ctx) => {
      const s = ctx.get()
      const refs = partialAnchors(s)
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
    ...gate(firstOf(notReadOnly, pickedAnchors('Select anchor points with the Direct Selection tool to cut the path there.'))),
    run: (ctx) => {
      const s = ctx.get()
      const { doc, ids } = cutAtAnchors(s.doc, partialAnchors(s))
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
    ...gate(firstOf(notReadOnly, oneAnchor)),
    run: (ctx) => {
      const next = convertAnchors(ctx.doc(), selectedAnchors(ctx.get()), 'corner')
      if (next !== ctx.doc()) ctx.history.commit(next, 'Convert to corner')
    }
  },
  {
    id: 'path.convertSmooth',
    label: 'Convert selected anchor points to smooth',
    icon: 'radio_button_unchecked',
    ...gate(firstOf(notReadOnly, oneAnchor)),
    run: (ctx) => {
      const next = convertAnchors(ctx.doc(), selectedAnchors(ctx.get()), 'smooth')
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
      ...gate(firstOf(notReadOnly, unless((ctx) => selectedAnchors(ctx.get()).length >= 2, 'Select two or more anchor points to align them.'))),
      run: (ctx) => {
        const next = alignAnchors(ctx.doc(), selectedAnchors(ctx.get()), a.edge)
        if (next !== ctx.doc()) ctx.history.commit(next, 'Align anchor points')
      }
    })
  ),
  {
    id: 'path.cornerRadius',
    label: 'Round corners',
    ...gate(firstOf(notReadOnly, oneAnchor)),
    run: (ctx, r) => {
      const radius = Number(r)
      if (!(radius > 0)) return
      const res = roundAnchorCorners(ctx.doc(), selectedAnchors(ctx.get()), radius)
      if (res.doc === ctx.doc()) {
        ctx.status('Only corner points (no handles, two neighbours) can be rounded.')
        return
      }
      ctx.history.commit(res.doc, 'Round corners')
      selectAnchors(ctx, res.refs)
    }
  }
]
