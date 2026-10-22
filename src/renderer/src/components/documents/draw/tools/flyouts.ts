// Rail flyouts: tools that share one rail button, as Illustrator's toolbar
// groups them (the Pen family; the shapes; Scissors and Knife; Rotate and
// Reflect; Scale, Shear and Reshape). A tool joins one by declaring
// `flyout: '<id>'` in its own file; nothing here lists them.

import { drawTools, toolById } from './registry'
import { rememberFlyoutTool, shellPrefs } from '../editor/shellPrefs'
import type { DrawTool, EditorCtx } from '../editor/types'

/** The tools of a flyout, in rail order (hidden tools never join one). */
export function flyoutMembers(flyout: string, tools: DrawTool[] = drawTools()): DrawTool[] {
  return tools.filter((t) => t.flyout === flyout && !t.hidden)
}

/** The tool after `id` in its flyout, wrapping round; null when it is in none (or alone in it). */
export function nextInFlyout(id: string, tools: DrawTool[] = drawTools()): DrawTool | null {
  const t = tools.find((x) => x.id === id)
  if (!t?.flyout) return null
  const members = flyoutMembers(t.flyout, tools)
  if (members.length < 2) return null
  return members[(members.findIndex((m) => m.id === id) + 1) % members.length] ?? null
}

/** The tool a flyout's rail button shows now: the active member, else the last one picked, else the first. */
export function shownInFlyout(flyout: string, activeId: string, lastUsed: Record<string, string> = shellPrefs.getState().lastUsed): DrawTool | null {
  const members = flyoutMembers(flyout)
  return members.find((m) => m.id === activeId) ?? members.find((m) => m.id === lastUsed[flyout]) ?? members[0] ?? null
}

/** Choose a tool the way the rail does: switch to it and remember it as its flyout's shown member. */
export function chooseTool(ctx: EditorCtx, id: string): void {
  const t = toolById(id)
  if (!t) return
  if (t.flyout) rememberFlyoutTool(t.flyout, t.id)
  ctx.setTool(t.id)
}

/**
 * Step to the next tool in the group of the tool on show (Illustrator: Option
 * or Alt-click a toolbar button to cycle through its hidden tools). Returns the
 * tool chosen, or null when the group has one tool.
 */
export function cycleFlyout(ctx: EditorCtx, flyout: string): DrawTool | null {
  const shown = shownInFlyout(flyout, ctx.get().tool)
  const next = shown ? nextInFlyout(shown.id) : null
  if (!next) return null
  chooseTool(ctx, next.id)
  return next
}
