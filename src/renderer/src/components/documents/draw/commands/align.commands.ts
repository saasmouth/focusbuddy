// The Align panel's commands: Align To (selection, key object, artboard), the
// key object itself, Distribute Objects by six edges and centres, and
// Distribute Spacing (even, or an exact value from the key object). Object ›
// Align › Left… (object.commands.ts) runs through alignSelection here, so the
// menu and the panel always agree on what "align" is aligned to.

import { DISTRIBUTE_EDGES, alignTo, distributeEdges, distributeMinimum, distributeSpacing, validKey, type AlignEdgeId, type AlignTarget, type DistributeEdge } from '@shared/draw/ops'
import type { Command, EditorCtx, EditorState, MenuSpec } from '../editor/types'
import { editableSelection } from '../transform/apply'

export type AlignToMode = 'selection' | 'key' | 'artboard'

export interface AlignState {
  to: AlignToMode
  keyId: string | null
  /** Distribute Spacing value in px; null = Auto (even). */
  spacing: number | null
}

const KEY = 'align'
const DEFAULT: AlignState = { to: 'selection', keyId: null, spacing: null }

export function alignState(s: Pick<EditorState, 'toolState'>): AlignState {
  return { ...DEFAULT, ...((s.toolState[KEY] as Partial<AlignState> | undefined) ?? {}) }
}

export function setAlignState(ctx: EditorCtx, patch: Partial<AlignState>): void {
  ctx.set((s) => ({ toolState: { ...s.toolState, [KEY]: { ...alignState(s), ...patch } } }))
}

/** The key object, when aligning to one and it is still part of the editable selection. */
export function activeKey(s: Pick<EditorState, 'toolState' | 'doc' | 'selection'>): string | null {
  const a = alignState(s)
  return a.to === 'key' ? validKey(s.doc, s.selection, a.keyId) : null
}

function target(s: EditorState): AlignTarget {
  const a = alignState(s)
  if (a.to === 'artboard') return { kind: 'artboard' }
  const key = activeKey(s)
  return key ? { kind: 'key', id: key } : { kind: 'selection' }
}

/** Align the selection's `edge` to whatever Align To says. One undo step. */
export function alignSelection(ctx: EditorCtx, edge: AlignEdgeId): void {
  const s = ctx.get()
  const next = alignTo(s.doc, s.selection, edge, target(s))
  if (next !== s.doc) ctx.history.commit(next, 'Align')
}

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly
const editableCount = (ctx: EditorCtx): number => editableSelection(ctx.get()).length

/** Is an exact spacing in force (a value, and a key object to measure from)? */
function exact(s: EditorState): boolean {
  return alignState(s).spacing !== null && activeKey(s) !== null
}

export function canAlign(ctx: EditorCtx): boolean {
  if (!writable(ctx)) return false
  const s = ctx.get()
  const n = editableCount(ctx)
  // A lone object aligns to the artboard; aligning to the key object needs something besides the key.
  return alignState(s).to === 'key' && activeKey(s) ? n >= 2 : n >= 1
}

export function canDistribute(ctx: EditorCtx): boolean {
  return writable(ctx) && editableCount(ctx) >= distributeMinimum(exact(ctx.get()))
}

const EDGE_LABEL: Record<DistributeEdge, string> = {
  top: 'Vertical distribute top',
  vcenter: 'Vertical distribute center',
  bottom: 'Vertical distribute bottom',
  left: 'Horizontal distribute left',
  hcenter: 'Horizontal distribute center',
  right: 'Horizontal distribute right'
}

export const menus: MenuSpec[] = []

export const commands: Command[] = [
  ...DISTRIBUTE_EDGES.map(
    (edge, i): Command => ({
      id: `object.distribute.${edge}`,
      label: EDGE_LABEL[edge],
      menu: { path: 'object/Align', order: 100 + i },
      enabled: canDistribute,
      run: (ctx) => {
        const s = ctx.get()
        const a = alignState(s)
        const next = distributeEdges(s.doc, s.selection, edge, { keyId: activeKey(s), spacing: a.spacing ?? undefined })
        if (next !== s.doc) ctx.history.commit(next, 'Distribute')
      }
    })
  ),
  ...(['v', 'h'] as const).map(
    (axis, i): Command => ({
      id: `object.distributeSpacing.${axis}`,
      label: axis === 'h' ? 'Horizontal distribute space' : 'Vertical distribute space',
      menu: { path: 'object/Align', order: 200 + i },
      enabled: canDistribute,
      run: (ctx) => {
        const s = ctx.get()
        const a = alignState(s)
        const next = distributeSpacing(s.doc, s.selection, axis, { keyId: activeKey(s), spacing: a.spacing ?? undefined })
        if (next !== s.doc) ctx.history.commit(next, 'Distribute spacing')
      }
    })
  ),
  ...(
    [
      ['selection', 'Align to selection'],
      ['key', 'Align to key object'],
      ['artboard', 'Align to artboard']
    ] as const
  ).map(
    ([mode, label], i): Command => ({
      id: `object.alignTo.${mode}`,
      label,
      menu: { path: 'object/Align', order: 300 + i },
      checked: (ctx) => alignState(ctx.get()).to === mode,
      run: (ctx) => {
        const s = ctx.get()
        // Choosing "key object" with nothing picked yet takes the topmost
        // selected object as the key, as Illustrator does; clicking another
        // selected object with the Selection tool makes that the key instead.
        const editable = editableSelection(s)
        const keyId = mode === 'key' ? (validKey(s.doc, s.selection, alignState(s).keyId) ?? editable[editable.length - 1] ?? null) : alignState(s).keyId
        setAlignState(ctx, { to: mode, keyId })
      }
    })
  ),
  {
    id: 'object.alignKey',
    label: 'Make key object',
    enabled: (ctx) => editableCount(ctx) > 1,
    run: (ctx, id) => {
      const s = ctx.get()
      const key = validKey(s.doc, s.selection, typeof id === 'string' ? id : null)
      if (!key) {
        ctx.status('The key object has to be one of the selected objects.')
        return
      }
      setAlignState(ctx, { to: 'key', keyId: key })
    }
  },
  {
    id: 'object.alignSpacing',
    label: 'Distribute spacing value',
    run: (ctx, v) => setAlignState(ctx, { spacing: typeof v === 'number' && Number.isFinite(v) ? v : null })
  }
]
