// The universal rows: what every work widget menu offers whatever its kind,
// each placed in its §9.3 group (types.ts). AI assist lives in aiAssist.ts.
// Every builder returns the rows that apply to the context, or none, so an
// action that cannot happen here is absent rather than greyed (SPEC §9.5).
//
// Labels for shared actions come from MENU (src/shared/menus/lexicon.ts); the
// few MENU does not carry yet are in ./labels.ts. Shortcut hints are shown only
// for keys that are actually bound, formatted by shortcutLabel():
//   ⌘V  paste into the focused widget (useWidgetSnippets onTextareaPaste /
//       onBodyPaste: the same conversion as this row)
//   ⌘C  only on a text selection, which the platform copies natively
// Nothing binds ⌘D, ⇧⌘] or ⌫ to these rows' actions on a widget (Canvas's ⌘]
// and ⌘[ zoom; ⌫ asks remove-or-delete for the whole selection), so those rows
// carry no hint.

import type { WidgetKind } from '@shared/types'
import { MENU, removeFromLabel } from '@shared/menus/lexicon'
import { isWidgetFilePaneId } from '@shared/widgetFiles'
import { shortcutLabel } from '@shared/menus/shortcuts'
import type { MenuContribution, MenuContext, UniversalKey } from './types'
import { CREATE_AND_CONNECT_MENU } from '../createConnectedTool'
import { presetForWidget, presetForMulti, presetForSelection, browserMarkUrl } from '../attentionPresets'
import {
  createWidget,
  hasWorkableText,
  convertWidget,
  bringToFront,
  ejectFromSection,
  copyText,
  duplicateWidget,
  archiveWidget,
  flagAsDecision,
  automateWithAgent,
  sourceWidget,
  workingText,
  pinWidgetToZone,
  unpinWidget,
  recolorWidget,
  linkedFileId,
  removeFromThisDesk,
  moveWidgetToTrash,
  deleteDeskOnlyWidget,
  removeOrDeleteMany,
  canAskAssist,
  askAssistAbout,
  menuPlatform,
  PIN_ZONES,
  RECOLOR_SWATCHES
} from './actions'
import {
  COPY_ALL_TEXT_LABEL,
  CREATE_AND_LINK_LABEL,
  addManyToFocusLabel,
  removeOrDeleteManyLabel
} from './labels'

type Suppress = Partial<Record<UniversalKey, boolean>>

// Kinds the "Copy into" rows offer. DEC-041: only kinds that can actually
// RECEIVE the source's text (Table, Mind map and Diagram never carried any).
const CONVERT_TARGETS: Array<{ kind: WidgetKind; label: string; icon: string }> = [
  { kind: 'sticky', label: 'Sticky', icon: 'sticky_note_2' },
  { kind: 'note', label: 'Note', icon: 'description' },
  { kind: 'markdown', label: 'Markdown', icon: 'subject' },
  { kind: 'page', label: 'Page', icon: 'article' }
]

const seedText = (ctx: MenuContext): string => workingText(ctx).text
const hint = (keys: Parameters<typeof shortcutLabel>[0]): string => shortcutLabel(keys, menuPlatform())

// ── Attention (E-1, owner ruling) ───────────────────────────────────────────
// Right after the object's Open row (first when there is none); the order is
// resolve.ts OBJECT_LEAD. Deterministic: a
// preset names it and picks its class, the standard confirm card (DEC-028)
// takes it from there, and the filed item POINTS at the object.
export function buildAttention(ctx: MenuContext): MenuContribution | null {
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
      group: 'object',
      priority: -1000,
      label: addManyToFocusLabel(n),
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
    group: 'object',
    priority: -1000,
    label: MENU.addToFocus.label,
    icon: 'notifications',
    onSelect: () => {
      // DEC-044: a HIGHLIGHT is the capture — its first line titles the item
      // and the whole selection rides the notes. No selection = the
      // widget-level preset.
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

// ── Group 1, object: Rename, Open file, Share… ──────────────────────────────
export function buildObject(ctx: MenuContext, s: Suppress): MenuContribution[] {
  if (ctx.object.type !== 'widget') return []
  const out: MenuContribution[] = []
  const f = ctx.frame
  if (f?.onRename && !s.rename) {
    out.push({
      id: 'core/rename',
      group: 'object',
      // E-11: first of all on the jump list; elsewhere after Add to Focus… and the kind's rows.
      priority: ctx.renameFirst ? -2000 : 40,
      fold: ctx.renameFirst ? -1 : undefined,
      label: MENU.rename.label,
      icon: 'edit',
      onSelect: (c) => c.frame?.onRename?.()
    })
  }
  if (f?.onOpenFile) {
    out.push({
      id: 'core/open-file',
      group: 'object',
      opens: true,
      priority: 30,
      label: 'Open file',
      icon: 'open_in_full',
      onSelect: (c) => c.frame?.onOpenFile?.()
    })
  }
  if (f?.onShare && !s.share) {
    out.push({
      id: 'core/share',
      group: 'object',
      priority: 50,
      label: MENU.share.label,
      icon: 'share',
      onSelect: (c) => c.frame?.onShare?.()
    })
  }
  return out
}

// ── Group 2, clipboard ──────────────────────────────────────────────────────
export function buildClipboard(ctx: MenuContext, s: Suppress): MenuContribution[] {
  const out: MenuContribution[] = []
  const f = ctx.frame
  const multi = ctx.object.type === 'multi'
  if (!s.copy) {
    const multiHasText = ctx.object.type === 'multi' && ctx.object.widgets.some((w) => w.content.trim())
    const hasSelection = !!ctx.selection?.text?.trim()
    if (multiHasText || workingText(ctx).text.trim()) {
      out.push({
        id: 'core/copy',
        group: 'clipboard',
        priority: 10,
        // "Copy" is the selection (the platform's own ⌘C); copying the whole
        // object's text says so (AUDIT §4.2).
        label: hasSelection && !multi ? MENU.copy.label : COPY_ALL_TEXT_LABEL,
        icon: 'content_copy',
        shortcut: hasSelection && !multi ? hint(MENU.copy.keys) : undefined,
        onSelect: (c) => copyText(c)
      })
    }
  }
  if (multi) return out
  if (f?.onPaste && !s.paste) {
    out.push({
      id: 'core/paste',
      group: 'clipboard',
      priority: 20,
      label: MENU.paste.label,
      icon: 'content_paste',
      shortcut: hint(MENU.paste.keys),
      onSelect: (c) => c.frame?.onPaste?.()
    })
  }
  if (f?.onInsertSnippet && !s.snippet) {
    out.push({
      id: 'core/insert-snippet',
      group: 'clipboard',
      priority: 25,
      label: MENU.insertSnippet.label,
      icon: 'bookmarks',
      onSelect: (c) => c.frame?.onInsertSnippet?.()
    })
  }
  if (!s.duplicate && ctx.object.type === 'widget') {
    // Duplicate = an independent copy (§9.4). Without a host, the generic one.
    out.push({
      id: 'core/duplicate',
      group: 'clipboard',
      priority: 30,
      label: MENU.duplicate.label,
      icon: 'control_point_duplicate',
      onSelect: (c) => (c.frame?.onDuplicateIndependent ? c.frame.onDuplicateIndependent() : void duplicateWidget(c))
    })
    if (f?.onDuplicateSynced) {
      out.push({
        id: 'core/duplicate-synced',
        group: 'clipboard',
        priority: 31,
        label: MENU.duplicateKeepSynced.label,
        icon: 'link',
        onSelect: (c) => c.frame?.onDuplicateSynced?.()
      })
    }
  }
  return out
}

// ── Group 3, arrange ────────────────────────────────────────────────────────
export function buildArrange(ctx: MenuContext, s: Suppress): MenuContribution[] {
  if (s.arrange || s.organise) return []
  if (ctx.object.type === 'empty-canvas') return []
  return [
    {
      id: 'core/front',
      group: 'arrange',
      priority: 0,
      label: ctx.object.type === 'multi' ? 'Bring all to front' : MENU.bringToFront.label,
      icon: 'flip_to_front',
      onSelect: (c) => bringToFront(c)
    }
  ]
}

// ── Group 4, Plexii (AI assist ▸ is added by the resolver from aiAssist.ts) ─
export function buildPlexii(ctx: MenuContext, s: Suppress): MenuContribution[] {
  if (ctx.object.type !== 'widget') return []
  const out: MenuContribution[] = []
  if (ctx.frame?.onSaveAsSnippet && !s.snippet) {
    out.push({
      id: 'core/save-snippet',
      group: 'plexii',
      priority: 10,
      label: MENU.saveAsSnippet.label,
      icon: 'bookmark_add',
      onSelect: (c) => c.frame?.onSaveAsSnippet?.()
    })
  }
  if (!s['ask-assist'] && canAskAssist(ctx)) {
    out.push({
      id: 'core/ask-assist',
      group: 'plexii',
      priority: 20,
      label: ctx.selection?.text?.trim() ? MENU.askAssistAboutThis.label : MENU.askAssist.label,
      icon: 'forum',
      onSelect: (c) => askAssistAbout(c)
    })
  }
  return out
}

// ── Group 5, More actions ▸ (rows that never take a top-level place) ─────────
export function buildCreate(ctx: MenuContext, s: Suppress): MenuContribution | null {
  if (ctx.object.type !== 'widget') return null
  const seed = seedText(ctx)
  const children: MenuContribution[] = []
  if (!s.create) {
    for (const entry of CREATE_AND_CONNECT_MENU) {
      children.push({
        id: `core/create/${entry.kind}`,
        priority: 0,
        label: entry.label,
        icon: entry.icon,
        onSelect: (c) => createWidget(c, entry.kind, entry.seedContent ?? seed)
      })
    }
  }
  // DEC-041: "Copy into" only when there is text to copy; the source is never
  // replaced — a NEW widget appears beside it carrying a copy of the text.
  if (!s.convert && hasWorkableText(ctx)) {
    const src = sourceWidget(ctx)
    CONVERT_TARGETS.filter((t) => t.kind !== src?.kind).forEach((t, i) => {
      children.push({
        id: `core/convert/${t.kind}`,
        separatorBefore: i === 0 && children.length > 0,
        priority: 0,
        label: `Copy into ${t.label.toLowerCase()}`,
        icon: t.icon,
        onSelect: (c) => convertWidget(c, t.kind)
      })
    })
  }
  if (!children.length) return null
  return {
    id: 'core/create',
    group: 'more',
    priority: 0,
    label: CREATE_AND_LINK_LABEL,
    icon: 'add',
    children
  }
}

export function buildMore(ctx: MenuContext, s: Suppress): MenuContribution[] {
  if (ctx.object.type === 'multi') {
    return [
      {
        // Wire every selected widget into one new agent — the multi-select
        // counterpart to "Automate with an agent".
        id: 'core/automate-many',
        group: 'more',
        priority: 0,
        label: `Automate ${ctx.object.widgets.length} with an agent`,
        icon: 'smart_toy',
        onSelect: (c) => void automateWithAgent(c)
      }
    ]
  }
  if (ctx.object.type !== 'widget') return []
  const w = ctx.object.widget
  const f = ctx.frame
  const out: MenuContribution[] = []
  if (f?.onMakeTask && !s.advanced) {
    // E-7: one row for the MakeTaskDialog. "Duplicate into another Room /
    // Desk…" opened the same dialog and is gone; this is the route.
    out.push({
      id: 'core/make-desk',
      group: 'more',
      priority: 10,
      label: MENU.makeThisADesk.label,
      icon: 'task_alt',
      onSelect: (c) => c.frame?.onMakeTask?.()
    })
  }
  if (w.parentSectionId && !s.organise) {
    out.push({
      id: 'core/eject',
      group: 'more',
      priority: 20,
      label: 'Move out of section',
      icon: 'logout',
      // The frame's eject repositions below the section and avoids overlap.
      onSelect: (c) => (c.frame?.onEjectFromSection ? c.frame.onEjectFromSection() : ejectFromSection(c))
    })
  }
  if (!s.pin && !s.organise) {
    out.push({
      id: 'core/pin',
      group: 'more',
      priority: 30,
      label: 'Pin to corner',
      icon: 'push_pin',
      children: [
        ...PIN_ZONES.map<MenuContribution>((z) => ({
          id: `core/pin/${z.zone}`,
          priority: 0,
          label: z.label,
          icon: z.icon,
          // A choice among siblings: the kit's check, never "✓" as text (F-13).
          checked: w.pinnedZone === z.zone,
          onSelect: (c) => pinWidgetToZone(c, z.zone)
        })),
        ...(w.pinnedZone != null
          ? [{ id: 'core/pin/off', priority: 1, label: 'Unpin', icon: 'close', onSelect: (c: MenuContext) => unpinWidget(c) }]
          : [])
      ]
    })
  }
  if (!s.recolor && !s.organise) {
    out.push({
      id: 'core/recolor',
      group: 'more',
      priority: 31,
      label: 'Recolor',
      icon: 'palette',
      children: [
        ...RECOLOR_SWATCHES.map<MenuContribution>((sw) => ({
          id: `core/recolor/${sw.color}`,
          priority: 0,
          label: sw.label,
          checked: w.color === sw.color,
          onSelect: (c) => recolorWidget(c, sw.color)
        })),
        {
          id: 'core/recolor/clear',
          separatorBefore: true,
          priority: 1,
          label: 'Clear color',
          icon: 'format_color_reset',
          onSelect: (c) => recolorWidget(c, null)
        }
      ]
    })
  }
  if (!s.flag && !s.organise) {
    // The entry point that activates the decision-risk surface: a later
    // material change to this widget lights its red frame.
    out.push({
      id: 'core/flag-decision',
      group: 'more',
      priority: 32,
      label: 'Flag as a decision',
      icon: 'gavel',
      onSelect: (c) => void flagAsDecision(c)
    })
  }
  if (f?.onSaveAsFile && !s.advanced) {
    out.push({
      id: 'core/save-as-file',
      group: 'more',
      priority: 40,
      label: 'Save as file',
      icon: 'note_add',
      onSelect: (c) => c.frame?.onSaveAsFile?.()
    })
  }
  if (f?.onUnlinkSynced && !s.advanced) {
    out.push({
      id: 'core/unlink',
      group: 'more',
      priority: 41,
      label: 'Unlink from synced copies',
      icon: 'link_off',
      onSelect: (c) => c.frame?.onUnlinkSynced?.()
    })
  }
  return out
}

// ── Group 6, destructive (E-2, owner ruling: Remove from this desk · Archive · Move to Trash, by priority 0·1·2) ──────────────────────────────────────────────
export function buildDestructive(ctx: MenuContext, s: Suppress): MenuContribution[] {
  if (s.destructive || ctx.object.type === 'empty-canvas') return []
  const mode = ctx.frame?.removal ?? 'full'
  if (mode === 'none') return []
  if (ctx.object.type === 'multi') {
    return [
      {
        id: 'core/remove-many',
        group: 'destructive',
        priority: 0,
        label: removeOrDeleteManyLabel(ctx.object.widgets.length),
        icon: 'delete',
        danger: true,
        onSelect: (c) => removeOrDeleteMany(c)
      }
    ]
  }
  const w = ctx.object.widget
  const out: MenuContribution[] = []
  const pane = isWidgetFilePaneId(w.id)
  if (!pane) {
    out.push({
      id: 'core/archive',
      group: 'destructive',
      priority: 1,
      label: MENU.archive.label,
      icon: 'archive',
      danger: true,
      onSelect: (c) => archiveWidget(c)
    })
  }
  if (mode === 'archive-only') return out
  if (pane || linkedFileId(w)) {
    // A work widget file: this placement, or the file itself (to Trash).
    if (!pane) {
      out.push({
        id: 'core/remove-from-desk',
        group: 'destructive',
        priority: 0,
        label: removeFromLabel('desk'),
        icon: 'remove_circle_outline',
        danger: true,
        onSelect: (c) => removeFromThisDesk(c)
      })
    }
    out.push({
      id: 'core/move-to-trash',
      group: 'destructive',
      priority: 2,
      label: MENU.moveToTrash.label,
      icon: 'delete',
      danger: true,
      onSelect: (c) => moveWidgetToTrash(c)
    })
  } else {
    // A desk-only kind has no file and no Trash entry: removing it from the
    // desk IS deleting it, so the row says Delete and keeps its confirm.
    out.push({
      id: 'core/delete',
      group: 'destructive',
      priority: 2,
      label: MENU.delete.label,
      icon: 'delete',
      danger: true,
      onSelect: (c) => deleteDeskOnlyWidget(c)
    })
  }
  return out
}
