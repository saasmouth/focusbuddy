// Universal-section providers. AI Assist lives in aiAssist.ts; this file builds
// Create, Convert, Organise, Share, Advanced, and Destructive. Each returns the
// contributions for its section given the context, or an empty array when the
// section does not apply, so the resolver can collapse empty sections to
// nothing rather than show a greyed parent.

import type { WidgetKind } from '@shared/types'
import { MenuSection, type MenuContribution, type MenuContext } from './types'
import { CREATE_AND_CONNECT_MENU } from '../createConnectedTool'
import { presetForWidget, presetForMulti, presetForSelection, browserMarkUrl } from '../attentionPresets'
import { workItemsEnabled } from '../workItemsCapability'
import {
  createWidget,
  hasWorkableText,
  convertWidget,
  bringToFront,
  ejectFromSection,
  copyText,
  duplicateWidget,
  archiveWidget,
  deleteWidget,
  flagAsDecision,
  automateWithAgent,
  sourceWidget,
  workingText,
  pinWidgetToZone,
  unpinWidget,
  recolorWidget,
  PIN_ZONES,
  RECOLOR_SWATCHES
} from './actions'

// Kinds the Convert / Turn-into menu offers. Only kinds that actually exist as
// widgets, gated per the critic: no Calendar event, no Desk, until those
// receiving surfaces exist.
// DEC-041 — only kinds that can actually RECEIVE the source's text.
//
// Table, Mind map and Diagram used to be offered here and never once carried
// anything across: the copy only happens between text kinds, so "turn this
// into a Mind map" produced an EMPTY mind map every time, from every source.
// A menu entry that never does what it says is worse than a missing one.
const CONVERT_TARGETS: Array<{ kind: WidgetKind; label: string; icon: string }> = [
  { kind: 'sticky', label: 'Sticky', icon: 'sticky_note_2' },
  { kind: 'note', label: 'Note', icon: 'description' },
  { kind: 'markdown', label: 'Markdown', icon: 'subject' },
  { kind: 'page', label: 'Page', icon: 'article' }
]

const seedText = (ctx: MenuContext): string => workingText(ctx).text

// ── Attention (CR-09 D-A) ───────────────────────────────────────────────────
// The FIRST row on every object menu, by operator ruling: marking a thing is
// the most common reason to open this menu at all. Deterministic — a preset
// table names it and picks its class, the standard confirm card (DEC-028)
// takes it from there, and the filed item POINTS at the object
// (sourceType/sourceRef) rather than copying it.
export function buildAttention(ctx: MenuContext): MenuContribution | null {
  if (!workItemsEnabled()) return null
  const obj = ctx.object
  if (obj.type === 'empty-canvas') return null

  const openMark = (
    text: string,
    intentClass: string,
    ref: string,
    type: string,
    notes?: string,
    sourceUrl?: string | null
  ): void => {
    window.dispatchEvent(
      new CustomEvent('fb:command-new-work-item', {
        detail: {
          captureText: text,
          notes,
          source: {
            sourceType: type,
            sourceRef: ref,
            intentClass,
            deskId: ctx.taskId,
            // DEC-091 — a mark made ON a browser widget (incl. a highlighted
            // Slack message) freezes the page URL onto the item.
            sourceUrl: sourceUrl ?? null
          }
        }
      })
    )
  }

  if (obj.type === 'multi') {
    const n = obj.widgets.length
    return {
      id: 'core/attention',
      section: MenuSection.Context,
      priority: -1000, // above every other Context row
      label: `Add ${n} to Attention…`,
      icon: 'notifications',
      onSelect: () => {
        const p = presetForMulti(n)
        openMark(p.text, p.intentClass, obj.widgets.map((w) => w.id).join(','), 'widgets')
      }
    }
  }

  const w = obj.widget
  return {
    id: 'core/attention',
    section: MenuSection.Context,
    priority: -1000,
    label: 'Add to Attention…',
    icon: 'notifications',
    shortcut: undefined,
    onSelect: () => {
      // DEC-044: a HIGHLIGHT is the capture — its first line titles the item
      // and the whole selection rides the notes, so nothing highlighted is
      // dropped. No selection = the widget-level preset, as before.
      const sel = ctx.selection?.text?.trim()
      const url = browserMarkUrl(w.kind, w.content)
      if (sel) {
        const p = presetForSelection(w.kind, sel)
        openMark(p.text, p.intentClass, w.id, 'widget', p.notes || undefined, url)
        return
      }
      const p = presetForWidget(w.kind, w.title ?? '', seedText(ctx))
      openMark(p.text, p.intentClass, w.id, 'widget', undefined, url)
    }
  }
}


export function buildCreate(ctx: MenuContext): MenuContribution[] {
  const seed = seedText(ctx)
  // The create + connect menu is a deliberately CURATED quick-create set kept two
  // levels deep (Create -> targets); the resolver reserves the third level for AI
  // Assist alone. The full consolidated core/Advanced catalog lives in the palette
  // and the bare-canvas "Add object" menu. Capability gating happens in
  // createWidget (actions.ts), so a Pro-locked kind here also prompts to upgrade.
  return [
    {
      id: 'core/create',
      section: MenuSection.Create,
      priority: 0,
      label: 'Create & link',
      icon: 'add',
      children: CREATE_AND_CONNECT_MENU.map<MenuContribution>((entry) => ({
        id: `core/create/${entry.kind}`,
        section: MenuSection.Create,
        priority: 0,
        label: entry.label,
        icon: entry.icon,
        onSelect: (c) => createWidget(c, entry.kind, entry.seedContent ?? seed)
      }))
    }
  ]
}

// Convert only makes sense from an existing object with content to reinterpret.
export function buildConvert(ctx: MenuContext): MenuContribution[] {
  if (ctx.object.type === 'empty-canvas') return []
  // DEC-041: no text, no copy. Without this the submenu appeared on a browser
  // or a table and silently degraded into "spawn an empty widget and wire it"
  // — which is exactly what Create already does, under an honest name.
  if (!hasWorkableText(ctx)) return []
  const src = sourceWidget(ctx)
  return [
    {
      id: 'core/convert',
      section: MenuSection.Convert,
      priority: 0,
      label: 'Copy into',
      icon: 'sync_alt',
      children: CONVERT_TARGETS.filter((t) => t.kind !== src?.kind).map<MenuContribution>((t) => ({
        id: `core/convert/${t.kind}`,
        section: MenuSection.Convert,
        priority: 0,
        label: t.label,
        icon: t.icon,
        onSelect: (c) => convertWidget(c, t.kind)
      }))
    }
  ]
}

export function buildOrganise(ctx: MenuContext): MenuContribution[] {
  if (ctx.object.type === 'multi') {
    return [
      {
        // Wire every selected widget into one new agent — the multi-select
        // counterpart to the single-widget "Automate with an agent". Listed
        // first because turning a selection into an automation is the headline
        // action here, not a housekeeping one.
        id: 'core/organise/automate-many',
        section: MenuSection.Organise,
        priority: 0,
        label: `Automate ${ctx.object.widgets.length} with an agent`,
        icon: 'smart_toy',
        onSelect: (c) => void automateWithAgent(c)
      },
      {
        id: 'core/organise/front-many',
        section: MenuSection.Organise,
        priority: 1,
        label: 'Bring all to front',
        icon: 'flip_to_front',
        onSelect: (c) => bringToFront(c)
      }
    ]
  }
  if (ctx.object.type !== 'widget') return []
  const w = ctx.object.widget
  const out: MenuContribution[] = [
    {
      id: 'core/organise/front',
      section: MenuSection.Organise,
      priority: 0,
      label: 'Bring to front',
      icon: 'flip_to_front',
      onSelect: (c) => bringToFront(c)
    },
    {
      // Flag as a Decision: the entry point that activates the decision-risk
      // surface. A later material change to this widget then lights its red frame.
      id: 'core/organise/flag-decision',
      section: MenuSection.Organise,
      priority: 6,
      label: 'Flag as a decision',
      icon: 'gavel',
      onSelect: (c) => void flagAsDecision(c)
    }
  ]
  if (w.parentSectionId) {
    // Prefer the frame's full eject (which repositions the widget below the
    // section and avoids overlap) when available; otherwise the plain detach.
    out.push({
      id: 'core/organise/eject',
      section: MenuSection.Organise,
      priority: 1,
      label: 'Move out of section',
      icon: 'logout',
      onSelect: (c) =>
        c.frame?.onEjectFromSection ? c.frame.onEjectFromSection() : ejectFromSection(c)
    })
  }
  // Pin ▸ dock the widget to a screen corner. When already pinned, offer Unpin.
  const isPinned = w.pinnedZone != null
  out.push({
    id: 'core/organise/pin',
    section: MenuSection.Organise,
    priority: 2,
    label: 'Pin to corner',
    icon: 'push_pin',
    children: [
      ...PIN_ZONES.map((z) => ({
        id: `core/organise/pin/${z.zone}`,
        section: MenuSection.Organise,
        priority: 0,
        label: z.label,
        icon: z.icon,
        // Mark the current corner so it reads as selected.
        ...(w.pinnedZone === z.zone ? { shortcut: '✓' } : {}),
        onSelect: (c: MenuContext) => pinWidgetToZone(c, z.zone)
      })),
      ...(isPinned
        ? [
            {
              id: 'core/organise/pin/off',
              section: MenuSection.Organise,
              priority: 1,
              label: 'Unpin',
              icon: 'close',
              onSelect: (c: MenuContext) => unpinWidget(c)
            }
          ]
        : [])
    ]
  })
  // Recolor ▸ swatches + clear.
  out.push({
    id: 'core/organise/recolor',
    section: MenuSection.Organise,
    priority: 3,
    label: 'Recolor',
    icon: 'palette',
    children: [
      ...RECOLOR_SWATCHES.map((s) => ({
        id: `core/organise/recolor/${s.color}`,
        section: MenuSection.Organise,
        priority: 0,
        label: s.label,
        icon: 'circle',
        ...(w.color === s.color ? { shortcut: '✓' } : {}),
        onSelect: (c: MenuContext) => recolorWidget(c, s.color)
      })),
      {
        id: 'core/organise/recolor/clear',
        section: MenuSection.Organise,
        priority: 1,
        label: 'Clear color',
        icon: 'format_color_reset',
        onSelect: (c: MenuContext) => recolorWidget(c, null)
      }
    ]
  })
  return out
}

export function buildShare(ctx: MenuContext): MenuContribution[] {
  const out: MenuContribution[] = []
  const multiHasText =
    ctx.object.type === 'multi' && ctx.object.widgets.some((w) => w.content.trim())
  if (multiHasText || workingText(ctx).text.trim()) {
    out.push({
      id: 'core/share/copy',
      section: MenuSection.Share,
      priority: 0,
      label: ctx.object.type === 'multi' ? 'Copy all text' : 'Copy text',
      icon: 'content_copy',
      shortcut: '⌘C',
      onSelect: (c) => copyText(c)
    })
  }
  if (ctx.frame) {
    out.push({
      id: 'core/share/share-dialog',
      section: MenuSection.Share,
      priority: 1,
      label: 'Share...',
      icon: 'share',
      onSelect: (c) => c.frame?.onShare()
    })
  }
  return out
}

export function buildAdvanced(ctx: MenuContext): MenuContribution[] {
  if (ctx.object.type !== 'widget') return []
  const out: MenuContribution[] = []
  if (ctx.frame) {
    // Use the frame's existing, tested actions so make-task / synced duplicate /
    // unlink behave exactly as they did in the old header menu.
    out.push({
      id: 'core/advanced/make-task',
      section: MenuSection.Advanced,
      priority: 0,
      label: 'Make this a Desk...',
      icon: 'task_alt',
      onSelect: (c) => c.frame?.onMakeTask()
    })
    out.push({
      id: 'core/advanced/duplicate-synced',
      section: MenuSection.Advanced,
      priority: 1,
      label: 'Duplicate (keep synced)',
      icon: 'link',
      onSelect: (c) => c.frame?.onDuplicateSynced()
    })
    out.push({
      id: 'core/advanced/duplicate-independent',
      section: MenuSection.Advanced,
      priority: 2,
      label: 'Duplicate (independent copy)',
      icon: 'content_copy',
      onSelect: (c) => c.frame?.onDuplicateIndependent()
    })
    if (ctx.frame.onDuplicateToFolder) {
      out.push({
        id: 'core/advanced/duplicate-folder',
        section: MenuSection.Advanced,
        priority: 3,
        label: 'Duplicate into another Room / Desk...',
        icon: 'drive_file_move',
        onSelect: (c) => c.frame?.onDuplicateToFolder?.()
      })
    }
    if (ctx.frame.onSaveAsFile) {
      out.push({
        id: 'core/advanced/save-as-file',
        section: MenuSection.Advanced,
        priority: 3.5,
        label: 'Save as file',
        icon: 'note_add',
        onSelect: (c) => c.frame?.onSaveAsFile?.()
      })
    }
    if (ctx.frame.onOpenFile) {
      out.push({
        id: 'core/advanced/open-file',
        section: MenuSection.Advanced,
        priority: 3.5,
        label: 'Open file',
        icon: 'open_in_full',
        onSelect: (c) => c.frame?.onOpenFile?.()
      })
    }
    if (ctx.frame.onUnlinkSynced) {
      out.push({
        id: 'core/advanced/unlink',
        section: MenuSection.Advanced,
        priority: 4,
        label: 'Unlink from synced copies',
        icon: 'link_off',
        onSelect: (c) => c.frame?.onUnlinkSynced?.()
      })
    }
    return out
  }
  // No frame (e.g. a content-body menu): the generic duplicate.
  out.push({
    id: 'core/advanced/duplicate',
    section: MenuSection.Advanced,
    priority: 0,
    label: 'Duplicate',
    icon: 'content_copy',
    onSelect: (c) => duplicateWidget(c)
  })
  return out
}

export function buildDestructive(ctx: MenuContext): MenuContribution[] {
  if (ctx.object.type === 'empty-canvas') return []
  if (ctx.object.type === 'multi') {
    const n = ctx.object.widgets.length
    return [
      {
        id: 'core/destructive/delete-many',
        section: MenuSection.Destructive,
        priority: 1,
        label: `Delete ${n} widgets`,
        icon: 'delete',
        danger: true,
        onSelect: (c) => deleteWidget(c)
      }
    ]
  }
  return [
    {
      id: 'core/destructive/archive',
      section: MenuSection.Destructive,
      priority: 0,
      label: 'Archive',
      icon: 'archive',
      danger: true,
      onSelect: (c) => archiveWidget(c)
    },
    {
      id: 'core/destructive/delete',
      section: MenuSection.Destructive,
      priority: 1,
      label: 'Delete',
      icon: 'delete',
      danger: true,
      onSelect: (c) => deleteWidget(c)
    }
  ]
}
