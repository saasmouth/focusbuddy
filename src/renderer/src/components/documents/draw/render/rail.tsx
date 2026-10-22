// The tool rail: the office shell's ToolRail, built from the tool registry
// (tools/*.tool.ts) and the panel registry (panels/*.panel.tsx). Tools keep
// their sections and order, their keys (the LIVE keymap, so a remapped key
// and the ⌘/Ctrl glyphs show), read-only safety and options (double-click:
// Rotate, Scale, Reflect, Shear, Smooth, Path Eraser...); tools sharing a
// flyout (`flyout` on the tool) show as one button. The overlay panels sit
// at the bottom, and the current fill and stroke under everything.

import type { RailItem } from '../../../office/shell'
import { docPaintToCss } from '@shared/draw/svg'
import { commandShortcutLabel, toolShortcutLabel } from '../commands/keys'
import { drawPanels } from '../panels/registry'
import { chooseTool, cycleFlyout } from '../tools/flyouts'
import { drawTools } from '../tools/registry'
import type { DrawTool, EditorCtx, EditorState } from '../editor/types'

export interface RailCtx {
  ctx: EditorCtx
  s: EditorState
  /** Option/Alt is held (an Alt-click on a flyout button steps through its tools, as in Illustrator). */
  altHeld: () => boolean
}

/**
 * Rail sections in toolbox order: a tool's `group` is its section, and
 * sections are ordered by their first tool (README: "sections are ordered by
 * their first tool"), so the rail keeps exactly the toolbox's order.
 */
export function sectionRanks(tools: DrawTool[]): Map<number, number> {
  const first = new Map<number, number>()
  for (const t of tools) if (!first.has(t.group) || t.order < first.get(t.group)!) first.set(t.group, t.order)
  const ranked = [...first.entries()].sort((a, b) => a[1] - b[1]).map(([g]) => g)
  const out = new Map<number, number>()
  let rank = -1
  for (const g of ranked) {
    // The office shell's "Create" group (SPEC §3.1): the pen and path tools,
    // the shapes and Type share one rail section, with no divider between them.
    if (!(CREATE.has(g) && [...out.keys()].some((k) => CREATE.has(k)))) rank++
    out.set(g, rank)
  }
  return out
}

/** Toolbox sections that make up the rail's Create group: paths (1), shapes (2), type (3). */
const CREATE = new Set([1, 2, 3])

/** The modal state a tool is in, shown as a dot on its button: the Pen or Curvature tool continuing a path. */
export function toolBadge(t: DrawTool, s: Pick<EditorState, 'pen' | 'penTarget' | 'curvature'>): 'dot' | undefined {
  if (t.id === 'pen' && (s.pen || s.penTarget)) return 'dot'
  if (t.id === 'curvature' && s.curvature?.points.length) return 'dot'
  return undefined
}

/** The rail's items (pure but for the key labels, which read the live keymap). */
export function drawRailItems(): RailItem<RailCtx>[] {
  const tools = drawTools().filter((t) => !t.hidden)
  const rank = sectionRanks(tools)
  const items: RailItem<RailCtx>[] = tools.map((t) => ({
    id: t.id,
    label: t.label,
    icon: t.icon,
    kind: 'tool',
    group: rank.get(t.group) ?? 99,
    order: t.order,
    shortcut: toolShortcutLabel(t.id) ?? undefined,
    readOnlySafe: t.readOnlySafe,
    flyout: t.flyout,
    badge: undefined,
    onSelect: ({ ctx, altHeld }) => {
      if (t.flyout && altHeld()) cycleFlyout(ctx, t.flyout)
      else chooseTool(ctx, t.id)
    },
    onOptions: t.onOptions
      ? ({ ctx }) => {
          // Illustrator: double-click a tool for its options dialog.
          chooseTool(ctx, t.id)
          t.onOptions!(ctx)
        }
      : undefined,
    testid: `draw-tool-${t.id}`
  }))
  for (const p of drawPanels())
    items.push({
      id: p.id,
      label: p.title,
      icon: p.icon,
      kind: 'panel',
      group: 1000,
      order: p.order,
      pinned: 'bottom',
      shortcut: commandShortcutLabel(p.command) ?? undefined,
      readOnlySafe: true,
      onSelect: ({ ctx }) => ctx.run(p.command),
      testid: `draw-rail-${p.id}`
    })
  return items
}

/** Items with this moment's badges (the Pen continuing a path). */
export function withBadges(items: RailItem<RailCtx>[], s: EditorState): RailItem<RailCtx>[] {
  return items.map((i) => {
    if (i.kind !== 'tool') return i
    const t = drawTools().find((x) => x.id === i.id)
    const badge = t ? toolBadge(t, s) : undefined
    return badge === i.badge ? i : { ...i, badge, label: badge ? `${i.label} — continuing a path` : i.label }
  })
}

/**
 * The tool the rail shows as active: the editor's tool, or the one borrowed
 * for now -- Space (or the Hand) pans; ⌘/Ctrl with the Pen borrows Direct
 * Selection, as does a Direct Selection drag started that way.
 */
export function activeRailId(s: Pick<EditorState, 'tool' | 'spaceDown' | 'gesture'>, modHeld: boolean): string {
  if (s.spaceDown) return 'hand'
  if (s.gesture?.toolId === 'direct' && s.tool !== 'direct') return 'direct'
  if (modHeld && s.tool === 'pen') return 'direct'
  return s.tool
}

/**
 * The current fill and stroke under the rail, overlapped as in Illustrator's
 * toolbar (fill in front, top left; stroke behind, bottom right): the
 * selection's, or what the next shape is drawn with. A click opens Home.
 */
export function RailFooter({ s, onOpen }: { s: EditorState; onOpen: () => void }): JSX.Element {
  const swatches = s.doc.swatches
  return (
    <button type="button" onClick={onOpen} aria-label="Fill and stroke: open Home" title="Fill and stroke (Home tab)" className="relative w-8 h-8 rounded hover:bg-[var(--surface-sunken)]">
      <span
        className="absolute right-1 bottom-1 w-[17px] h-[17px] rounded-sm border-[4px] bg-[var(--surface-raised)]"
        style={{ borderColor: s.stroke ? docPaintToCss({ swatches }, s.stroke.paint) : 'var(--edge-firm)' }}
        data-testid="draw-current-stroke"
      />
      <span className="absolute left-1 top-1 w-[17px] h-[17px] rounded-sm border border-[var(--edge-firm)]" style={{ background: docPaintToCss({ swatches }, s.fill) }} data-testid="draw-current-fill" />
    </button>
  )
}
