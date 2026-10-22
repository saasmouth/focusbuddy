// Several artboards (WP-ARTBOARD): Object › Artboards, the Artboards panel's
// actions, artboard navigation in the View menu, and Select › All on Active
// Artboard. The document work is pure (@shared/draw/ops artboards.ts); the
// editor side is editor/artboards.ts.

import type { Box } from '@shared/drawGeometry'
import type { DrawArtboard } from '@shared/draw/model'
import {
  addArtboard,
  artboardById,
  artworkBounds,
  convertibleRectangles,
  convertToArtboards,
  deleteArtboards,
  duplicateArtboard,
  fitArtboardTo,
  newArtboardRect,
  nodeBounds,
  nodesWorldBounds,
  getObject,
  patchArtboard,
  primaryArtboard,
  rearrangeArtboards,
  renameArtboard,
  reorderArtboard,
  selectableObjectIds,
  type RearrangeOptions
} from '@shared/draw/ops'
import {
  activateArtboard,
  allArtboardsBox,
  artboardsBlockedReason,
  artboardsEditable,
  changeArtboardWithPaint,
  copyNode,
  guardArtboards,
  hasArtboard,
  moveArtWithArtboard,
  newArtboardId,
  steppedArtboard
} from '../editor/artboards'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'

export const menus: MenuSpec[] = [{ path: 'object/Artboards', label: 'Artboards', icon: 'dashboard_customize', order: 900 }]

const editable = (ctx: EditorCtx): boolean => artboardsEditable(ctx.get())
const several = (ctx: EditorCtx): boolean => ctx.get().doc.artboards.length > 1
const hasSelection = (ctx: EditorCtx): boolean => ctx.get().selection.length > 0

/** The artboard a command acts on: the one named in its args, else the active one. */
function target(ctx: EditorCtx, args: unknown): DrawArtboard {
  const doc = ctx.doc()
  const id = (args as { id?: unknown } | undefined)?.id
  return (hasArtboard(doc, id) ? artboardById(doc, id) : undefined) ?? primaryArtboard(doc)
}

/** Show an artboard: make it active and fit it in the window. */
export function goToArtboard(ctx: EditorCtx, id: string): void {
  const a = artboardById(ctx.doc(), id)
  if (!a) return
  activateArtboard(ctx, id)
  if (ctx.viewport.fitBox) ctx.viewport.fitBox(a)
  else ctx.viewport.fit()
  const i = ctx.doc().artboards.findIndex((x) => x.id === id)
  ctx.status(`Artboard ${i + 1} of ${ctx.doc().artboards.length}: ${a.name}`)
}

/** Top-level, selectable objects that overlap a box. */
function objectsTouching(ctx: EditorCtx, box: Box): string[] {
  const doc = ctx.doc()
  return selectableObjectIds(doc).filter((id) => {
    const n = getObject(doc, id)
    if (!n) return false
    const b = nodeBounds(n)
    return b.x <= box.x + box.w && b.x + b.w >= box.x && b.y <= box.y + box.h && b.y + b.h >= box.y
  })
}

export const commands: Command[] = [
  {
    id: 'artboard.new',
    label: 'New Artboard',
    icon: 'add_box',
    menu: { path: 'object/Artboards', order: 0 },
    enabled: editable,
    run: (ctx) => {
      if (!guardArtboards(ctx)) return
      const doc = ctx.doc()
      const r = newArtboardRect(doc)
      ctx.history.commit(addArtboard(doc, newArtboardId(), r), 'New Artboard')
      goToArtboard(ctx, primaryArtboard(ctx.doc()).id)
    }
  },
  {
    id: 'artboard.duplicate',
    label: 'Duplicate Artboard',
    icon: 'library_add',
    menu: { path: 'object/Artboards', order: 1 },
    enabled: editable,
    run: (ctx, args) => {
      if (!guardArtboards(ctx)) return
      const a = target(ctx, args)
      const doc = ctx.doc()
      // Beside the whole set, so the copy never lands on another artboard.
      const right = newArtboardRect(doc)
      const r = duplicateArtboard(doc, a.id, newArtboardId(), right.x - a.x, 0, { withArt: moveArtWithArtboard(ctx.get()), copyNode })
      ctx.history.commit(r.doc, 'Duplicate Artboard')
      goToArtboard(ctx, primaryArtboard(ctx.doc()).id)
    }
  },
  {
    id: 'artboard.delete',
    label: 'Delete Artboard',
    icon: 'delete',
    menu: { path: 'object/Artboards', order: 2 },
    // A drawing always keeps one artboard; the art on a deleted one stays.
    enabled: (ctx) => editable(ctx) && several(ctx),
    run: (ctx, args) => {
      if (!guardArtboards(ctx) || !several(ctx)) return
      const a = target(ctx, args)
      ctx.history.commit(deleteArtboards(ctx.doc(), [a.id]), 'Delete Artboard')
      ctx.status(`Deleted ${a.name}. Its artwork is still in the drawing.`)
    }
  },
  {
    id: 'artboard.rename',
    label: 'Rename…',
    icon: 'edit',
    menu: { path: 'object/Artboards', order: 3 },
    enabled: editable,
    run: (ctx, args) => {
      const a = target(ctx, args)
      const name = (args as { name?: unknown } | undefined)?.name
      if (typeof name === 'string') {
        if (!guardArtboards(ctx)) return
        const next = renameArtboard(ctx.doc(), a.id, name)
        if (next !== ctx.doc()) ctx.history.commit(next, 'Rename Artboard')
        else if (!name.trim()) ctx.status('An artboard needs a name.')
        return
      }
      ctx.set({ dialog: { id: 'artboard-options', props: { id: a.id, focus: 'name' } } })
    }
  },
  {
    id: 'artboard.options',
    label: 'Artboard Options…',
    icon: 'tune',
    menu: { path: 'object/Artboards', order: 4 },
    enabled: editable,
    run: (ctx, args) => ctx.set({ dialog: { id: 'artboard-options', props: { id: target(ctx, args).id } } })
  },
  {
    id: 'artboard.patch',
    label: 'Change artboard',
    enabled: editable,
    run: (ctx, args) => {
      if (!guardArtboards(ctx)) return
      const { id, patch, label } = (args ?? {}) as { id?: string; patch?: Partial<DrawArtboard>; label?: string }
      if (!patch || !hasArtboard(ctx.doc(), id)) return
      const { id: _drop, ...rest } = patch as DrawArtboard
      void _drop
      // A new size carries the artboard's page-sized paint layers (re-laid, never stretched).
      return changeArtboardWithPaint(ctx, id, (d) => patchArtboard(d, id, rest), label ?? 'Artboard Options')
    }
  },
  {
    id: 'artboard.fitToArtwork',
    label: 'Fit to Artwork Bounds',
    icon: 'fit_screen',
    menu: { path: 'object/Artboards', order: 100 },
    enabled: (ctx) => editable(ctx) && artworkBounds(ctx.doc()) !== null,
    run: (ctx, args) => {
      if (!guardArtboards(ctx)) return
      const b = artworkBounds(ctx.doc())
      if (!b) return ctx.status('There is no artwork to fit the artboard to.')
      const id = target(ctx, args).id
      return changeArtboardWithPaint(ctx, id, (d) => fitArtboardTo(d, id, b), 'Fit Artboard to Artwork')
    }
  },
  {
    id: 'artboard.fitToSelection',
    label: 'Fit to Selected Art',
    icon: 'crop_free',
    menu: { path: 'object/Artboards', order: 101 },
    enabled: (ctx) => editable(ctx) && hasSelection(ctx),
    run: (ctx, args) => {
      if (!guardArtboards(ctx)) return
      const b = nodesWorldBounds(ctx.doc(), ctx.get().selection)
      if (!b) return ctx.status('Select the artwork to fit the artboard to.')
      const id = target(ctx, args).id
      return changeArtboardWithPaint(ctx, id, (d) => fitArtboardTo(d, id, b), 'Fit Artboard to Selected Art')
    }
  },
  {
    // Illustrator's Object › Artboards › Convert to Artboards: the selected
    // rectangles become artboards (named in reading order) and the shapes go.
    id: 'artboard.convert',
    label: 'Convert to Artboards',
    icon: 'transform',
    menu: { path: 'object/Artboards', order: 102 },
    enabled: (ctx) => editable(ctx) && convertibleRectangles(ctx.doc(), ctx.get().selection).length > 0,
    disabledReason: (ctx) => artboardsBlockedReason(ctx.get()) ?? (convertibleRectangles(ctx.doc(), ctx.get().selection).length ? null : 'select one or more rectangles'),
    explainsWhenDisabled: true,
    run: (ctx) => {
      if (!guardArtboards(ctx)) return
      const r = convertToArtboards(ctx.doc(), ctx.get().selection, newArtboardId)
      if (!r.created.length) return ctx.status('Select one or more rectangles to convert to artboards.')
      ctx.history.commit(r.doc, r.created.length === 1 ? 'Convert to Artboard' : 'Convert to Artboards')
      ctx.select(ctx.get().selection.filter((id) => !r.removed.includes(id)))
      const names = r.created.map((id) => artboardById(ctx.doc(), id)?.name).filter(Boolean)
      ctx.status(`${names.length === 1 ? 'Made artboard' : `Made ${names.length} artboards`}: ${names.join(', ')}.`)
    }
  },
  {
    id: 'artboard.rearrange',
    label: 'Rearrange All Artboards…',
    icon: 'grid_view',
    menu: { path: 'object/Artboards', order: 200 },
    enabled: (ctx) => editable(ctx) && several(ctx),
    run: (ctx, args) => {
      if (args && typeof args === 'object' && 'layout' in (args as object)) {
        if (!guardArtboards(ctx)) return
        const next = rearrangeArtboards(ctx.doc(), args as RearrangeOptions)
        if (next !== ctx.doc()) ctx.history.commit(next, 'Rearrange Artboards')
        if (ctx.viewport.fitBox) ctx.viewport.fitBox(allArtboardsBox(ctx.doc()))
        return
      }
      ctx.set({ dialog: { id: 'artboard-rearrange' } })
    }
  },
  {
    id: 'artboard.reorder',
    label: 'Move artboard in the list',
    enabled: editable,
    run: (ctx, args) => {
      if (!guardArtboards(ctx)) return
      const { id, index } = (args ?? {}) as { id?: string; index?: number }
      if (!hasArtboard(ctx.doc(), id) || typeof index !== 'number') return
      const next = reorderArtboard(ctx.doc(), id, index)
      if (next !== ctx.doc()) ctx.history.commit(next, 'Reorder Artboards')
    }
  },
  {
    id: 'artboard.activate',
    label: 'Go to artboard',
    // Looking, not editing: works on a read-only drawing too.
    run: (ctx, args) => {
      const id = typeof args === 'string' ? args : (args as { id?: string } | undefined)?.id
      if (hasArtboard(ctx.doc(), id)) goToArtboard(ctx, id)
    }
  },
  {
    id: 'artboard.toggleMoveArt',
    label: 'Move/Copy Artwork with Artboard',
    checked: (ctx) => moveArtWithArtboard(ctx.get()),
    run: (ctx) => ctx.set((s) => ({ toolState: { ...s.toolState, artboard: { ...(s.toolState.artboard as object | undefined), withArt: !moveArtWithArtboard(s) } } }))
  },
  // View: artboard navigation.
  {
    id: 'view.fitAll',
    label: 'Fit All in Window',
    icon: 'zoom_out_map',
    menu: { path: 'view', order: 101 },
    run: (ctx) => {
      if (ctx.viewport.fitBox) ctx.viewport.fitBox(allArtboardsBox(ctx.doc()))
      else ctx.viewport.fit()
    }
  },
  {
    id: 'view.nextArtboard',
    label: 'Next Artboard',
    icon: 'navigate_next',
    menu: { path: 'view', order: 150 },
    enabled: several,
    run: (ctx) => {
      const id = steppedArtboard(ctx.doc(), 1)
      if (id) goToArtboard(ctx, id)
    }
  },
  {
    id: 'view.previousArtboard',
    label: 'Previous Artboard',
    icon: 'navigate_before',
    menu: { path: 'view', order: 151 },
    enabled: several,
    run: (ctx) => {
      const id = steppedArtboard(ctx.doc(), -1)
      if (id) goToArtboard(ctx, id)
    }
  },
  {
    id: 'edit.selectAllOnArtboard',
    label: 'Select all on active artboard',
    icon: 'select_all',
    menu: { path: 'edit', order: 302 },
    run: (ctx) => {
      const ids = objectsTouching(ctx, primaryArtboard(ctx.doc()))
      ctx.select(ids)
      if (!ids.length) ctx.status('Nothing on the active artboard can be selected.')
    }
  }
]
