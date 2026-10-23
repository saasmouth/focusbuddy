// PlexiiAssist in PlexiiDraw: describe it, see it, then apply it.
//
// The owner's report was that Diagrams can be asked for a diagram and Draw
// cannot be asked for anything. These commands are the editor half of the
// answer; the model call is src/main/ai/drawGenerate.ts and the schema is
// @shared/draw/generate.
//
// NOTHING IS APPLIED UNSEEN. The pane generates, previews, and only then runs
// one of the apply commands — so a generation someone dislikes costs them a
// glance, not an undo. Each apply is a single ctx.history.commit, so ⌘Z takes
// the whole thing back in one press, layer and all.

import { drawId } from '@shared/draw'
import {
  addGeneratedPaintLayer,
  addGeneratedVectorLayer,
  fitNodesToArtboard,
  replaceObjects,
  targetArtboard
} from '@shared/draw/generate/apply'
import { compileScene, sceneBounds } from '@shared/draw/generate/compile'
import type { Scene } from '@shared/draw/generate/scene'
import type { DrawNode } from '@shared/draw/model'
import { v2BlockedReason, v2Writable } from '../editor/v2gate'
import type { Command, EditorCtx } from '../editor/types'

export interface ApplySceneArgs {
  scene: Scene
  /** Present for "change what I have selected": the objects being replaced. */
  replaceIds?: string[]
}

export interface ApplyPaintArgs {
  dataUrl: string
  name: string
  size?: { w: number; h: number }
}

/** Why generated work cannot be applied now, as a sentence; null when it can. */
export function generateBlockedReason(ctx: EditorCtx): string | null {
  const s = ctx.get()
  if (s.readOnly) return 'This artwork is read-only.'
  if (!v2Writable(s)) return `Generated art can't be added to this drawing yet: ${v2BlockedReason(s)}.`
  return null
}

function guard(ctx: EditorCtx): boolean {
  const why = generateBlockedReason(ctx)
  if (why) ctx.status(why)
  return !why
}

/** Compile a previewed scene into this document's objects, fitted to its artboard. */
export function nodesForScene(ctx: EditorCtx, scene: Scene): DrawNode[] {
  const doc = ctx.doc()
  const { nodes } = compileScene(scene, { newId: () => drawId('nd') })
  if (!nodes.length) return []
  const board = targetArtboard(doc)
  return board ? fitNodesToArtboard(nodes, sceneBounds(scene), board) : nodes
}

export const commands: Command[] = [
  // Neither command has a `menu`, so neither appears in one: the pane runs
  // them with the scene it has already previewed, and the ContextBar button in
  // DrawStudio is what opens the pane. Nothing here reaches for UiService,
  // which is d1's shared type.
  {
    id: 'ai.applyScene',
    label: 'Apply generated art',
    icon: 'auto_awesome',
    run: (ctx, args) => {
      if (!guard(ctx)) return
      const { scene, replaceIds } = (args ?? {}) as ApplySceneArgs
      if (!scene) return
      const nodes = nodesForScene(ctx, scene)
      if (!nodes.length) {
        ctx.status('There was nothing in that result to draw.')
        return
      }
      const doc = ctx.doc()
      if (replaceIds?.length) {
        ctx.history.commit(replaceObjects(doc, replaceIds, nodes), 'Regenerate Selection')
        ctx.select(nodes.map((n) => n.id))
        ctx.status(`Replaced ${replaceIds.length} object${replaceIds.length === 1 ? '' : 's'}. Undo (⌘Z) puts them back.`)
        return
      }
      ctx.history.commit(addGeneratedVectorLayer(doc, nodes, scene.name || 'Generated art'), 'Generate Art')
      ctx.select(nodes.map((n) => n.id))
      ctx.status(`Added ${nodes.length} object${nodes.length === 1 ? '' : 's'} on a new layer. Undo (⌘Z) removes it.`)
    }
  },
  {
    id: 'ai.applyPaint',
    label: 'Apply generated paint',
    icon: 'imagesmode',
    run: (ctx, args) => {
      if (!guard(ctx)) return
      const { dataUrl, name, size } = (args ?? {}) as ApplyPaintArgs
      if (!dataUrl) return
      const doc = ctx.doc()
      const board = targetArtboard(doc)
      if (!board) {
        ctx.status('There is no artboard to paint onto.')
        return
      }
      ctx.history.commit(addGeneratedPaintLayer(doc, dataUrl, name || 'Generated paint', board, size), 'Generate Paint')
      ctx.status('Added a paint layer. Undo (⌘Z) removes it.')
    }
  }
]
