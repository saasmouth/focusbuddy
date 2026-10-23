import { MENU, NEW_DOCUMENT_LABEL, actionKeys, type MenuAction, type MenuActionId } from '@shared/menus/lexicon'
import { shortcutLabel, type ShortcutKeys } from '@shared/menus/shortcuts'
import type { MenuItem } from '../../components/documents/editor/menuBarKit'
import type { CtxMenuItem } from '../../components/CanvasContextMenu'
import type { EditorCommand } from '../../stores/editorCommands'
import { menuPlatform } from './menuAction'
import type { DocumentOps } from '../../components/documents/editor/documentOps'

// One definition per office action (SPEC §9, "no repeats"): label, key, icon,
// enabled state with its reason, and what it does. The menu bar, the ribbon,
// the right-click menu and the command palette render FROM it through the
// adapters below, so one action cannot read, hint or behave differently on two
// surfaces. Thin on purpose: an app's existing command objects (Diagrams'
// `cmd`, Draw's registry) adapt into it; ids are the existing code ids.

export interface OfficeCommand {
  /** The existing code id (the palette's, where it had one). Never renamed. */
  id: string
  label: string
  /** The key it is bound to. The hint is formatted per platform (⌘ on macOS, Ctrl elsewhere); no key, no hint. */
  keys?: ShortcutKeys
  /** Non-macOS key, where the platform binds a different one. */
  otherKeys?: ShortcutKeys
  icon?: string
  /** Palette row hint ("Format", "Insert") and extra words its fuzzy match should know. */
  group?: string
  keywords?: string
  enabled?: () => boolean
  /** Why it is off (SPEC §9.5). Required whenever `enabled` can be false. */
  reason?: () => string | undefined
  /** A toggle's state. */
  checked?: () => boolean
  danger?: boolean
  run: () => void
}

/** A shared lexicon action as a command: its label, key and icon come from MENU. */
export function sharedCommand(id: string, action: MenuActionId, run: () => void, extra: Partial<OfficeCommand> = {}): OfficeCommand {
  const a = MENU[action] as MenuAction
  return { id, label: a.label, keys: a.keys, otherKeys: a.otherKeys, icon: a.icon, run, ...extra }
}

/** The command's key hint on this platform, if it has a key. */
export function commandHint(c: OfficeCommand, platform: string = menuPlatform()): string | undefined {
  const keys = actionKeys({ label: c.label, keys: c.keys, otherKeys: c.otherKeys }, platform)
  return keys ? shortcutLabel(keys, platform) : undefined
}

function offState(c: OfficeCommand): { off: boolean; reason?: string } {
  const off = c.enabled ? !c.enabled() : false
  return { off, reason: off ? c.reason?.() : undefined }
}

/** Menu-bar row (menuBarKit). */
export function menuItemOf(c: OfficeCommand, extra: Partial<MenuItem & { kind: 'item' }> = {}): MenuItem {
  const { off, reason } = offState(c)
  return {
    kind: 'item',
    label: c.label,
    ...(commandHint(c) ? { shortcut: commandHint(c) } : {}),
    ...(c.icon ? { icon: c.icon } : {}),
    run: c.run,
    ...(c.enabled ? { disabled: off } : {}),
    ...(reason ? { hint: reason } : {}),
    ...(c.checked ? { active: c.checked() } : {}),
    ...extra
  }
}

const strict = (): boolean => {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return !!env && (env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || !!env.VITEST)
}

/**
 * Right-click row (the kit, CanvasContextMenu). A disabled row must say why
 * (SPEC §9.5): in development and tests a command off with no reason throws
 * here, naming itself, rather than rendering a silently dead row (agreed with
 * 2e; expectMenuContract is the backstop).
 */
export function ctxRow(c: OfficeCommand, extra: Partial<CtxMenuItem> = {}): CtxMenuItem {
  const { off, reason } = offState(c)
  if (off && !reason && strict()) throw new Error(`ctxRow: "${c.id}" is disabled without a reason (SPEC §9.5)`)
  return {
    label: c.label,
    shortcut: commandHint(c),
    icon: c.icon,
    onClick: c.run,
    testid: `ctx-${c.id}`,
    ...(off ? { disabled: true, hint: reason } : {}),
    ...(c.checked ? { checked: c.checked() } : {}),
    ...(c.danger ? { danger: true } : {}),
    ...extra
  }
}

/** Command palette entry (Cmd+K). */
export function paletteEntry(c: OfficeCommand): EditorCommand {
  return {
    id: c.id,
    label: c.label,
    ...(c.icon ? { icon: c.icon } : {}),
    ...(commandHint(c) ? { shortcut: commandHint(c) } : {}),
    ...(c.group ? { group: c.group } : {}),
    ...(c.keywords ? { keywords: c.keywords } : {}),
    run: c.run
  }
}

/** The palette's rows: only commands that are live now (a palette row cannot show why it is off). */
export function paletteEntries(cs: OfficeCommand[]): EditorCommand[] {
  return cs.filter((c) => !c.enabled || c.enabled()).map(paletteEntry)
}

/** Ribbon props for BarButton / BarToggle / BarDialogButton: label, icon, hint and the off state with its reason. */
export function barProps(c: OfficeCommand): { label: string; icon?: string; shortcut?: string; disabled?: boolean; disabledReason?: string } {
  const { off, reason } = offState(c)
  return {
    label: c.label,
    ...(c.icon ? { icon: c.icon } : {}),
    ...(commandHint(c) ? { shortcut: commandHint(c) } : {}),
    ...(c.enabled ? { disabled: off } : {}),
    ...(reason ? { disabledReason: reason } : {})
  }
}

/** File's document actions, each acting on the document its host bound. */
export interface DocumentCommands {
  newDocument: OfficeCommand
  makeCopy: OfficeCommand
  rename: OfficeCommand
  versionHistory: OfficeCommand
  meeting: OfficeCommand
  moveToTrash: OfficeCommand
}

/**
 * File's document actions as commands built FROM the host-bound DocumentOps
 * (9d ruling): run() calls through the ops, so no document id and no store
 * `active` ever lives in a registry; the ops carry the binding. With no ops
 * (a snippet session) there is no document to act on, so there are no
 * commands, and the menus leave the rows out (absent, SPEC §9.5; 9d option A).
 * Ids are PlexiiDraw's existing ones, shared by every app.
 */
export function documentCommands(ops: DocumentOps | undefined, docType: string): DocumentCommands | null {
  if (!ops) return null
  return {
    newDocument: { id: 'file.new', label: NEW_DOCUMENT_LABEL[docType] ?? 'New', icon: 'note_add', run: () => void ops.newDocument() },
    makeCopy: sharedCommand('file.copy', 'makeCopy', () => void ops.makeCopy(), { icon: 'file_copy' }),
    rename: sharedCommand('file.rename', 'rename', () => void ops.rename(), { icon: 'edit' }),
    versionHistory: sharedCommand('file.history', 'versionHistory', () => ops.openHistory(), { icon: 'history' }),
    meeting: sharedCommand('document.meeting', 'meeting', () => ops.startMeeting(), { icon: 'videocam' }),
    moveToTrash: sharedCommand('file.trash', 'moveToTrash', () => void ops.moveToTrash())
  }
}
