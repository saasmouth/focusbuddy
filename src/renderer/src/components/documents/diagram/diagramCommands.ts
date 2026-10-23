import { sharedCommand, writeGate, type OfficeCommand } from '../../../lib/menus/officeCommand'
import type { Commands } from './commands'

// PlexiiDiagrams' actions as OfficeCommands (SPEC §9, no repeats). Diagrams
// already has one behaviour per action, its `cmd` object (commands.ts); this
// adapts it, so the menu bar, the ribbon, the right-click menu and the zoom
// controls show one label, one icon and one hint for each, with the hint
// formatted per platform from the key commands.ts really binds. DOM-free.

export interface DiagramCommandDeps {
  cmd: Commands
  /**
   * A viewer's diagram (LiveDocEditorView's viewerOnly): every command that
   * changes it is off with the shell's READ_ONLY_REASON. Read strictly
   * (`=== true`): a stub-deps proxy answers a function for a missing key.
   */
  readOnly: boolean
  /** Selected shapes and lines, and whether any of them is locked or grouped. */
  nodes: number
  edges: number
  locked: boolean
  grouped: boolean
  openFind: () => void
}

export type DiagramCommands = ReturnType<typeof buildDiagramCommands>

export function buildDiagramCommands(d: DiagramCommandDeps) {
  const { cmd } = d
  const shapes = { enabled: () => d.nodes > 0, reason: () => 'Select a shape first.' }
  const anything = { enabled: () => d.nodes + d.edges > 0, reason: () => 'Select a shape or line first.' }
  // Changes the diagram: off for a viewer first, then the command's own gate.
  const ro = d.readOnly === true
  const w = (gate?: Pick<OfficeCommand, 'enabled' | 'reason'>): Required<Pick<OfficeCommand, 'enabled' | 'reason'>> => writeGate(ro, gate)
  return {
    cut: sharedCommand('dg-cut', 'cut', () => document.execCommand('cut'), w(anything)),
    copy: sharedCommand('dg-copy', 'copy', () => document.execCommand('copy'), anything),
    paste: sharedCommand('dg-paste', 'paste', () => void cmd.pasteFromClipboard(), w()),
    duplicate: sharedCommand('dg-duplicate', 'duplicate', cmd.duplicate, w(shapes)),
    remove: sharedCommand('dg-delete', 'delete', cmd.deleteSelection, w(anything)),
    selectAll: sharedCommand('dg-select-all', 'selectAll', cmd.selectAll),
    find: sharedCommand('dg-find', 'find', d.openFind),
    // One panel holds both (its Replace row always shows): the two rows are the E-14 keys.
    findAndReplace: sharedCommand('dg-find-replace', 'findAndReplace', d.openFind, { icon: 'find_replace', ...w() }),
    bringToFront: sharedCommand('dg-front', 'bringToFront', () => cmd.order('front'), w(shapes)),
    bringForward: { id: 'dg-forward', label: 'Bring forward', icon: 'arrow_upward', keys: ['mod', ']'], ...w(shapes), run: () => cmd.order('forward') } as OfficeCommand,
    sendBackward: { id: 'dg-backward', label: 'Send backward', icon: 'arrow_downward', keys: ['mod', '['], ...w(shapes), run: () => cmd.order('backward') } as OfficeCommand,
    sendToBack: sharedCommand('dg-back', 'sendToBack', () => cmd.order('back'), w(shapes)),
    group: sharedCommand('dg-group', 'group', cmd.group, w({ enabled: () => d.nodes >= 2, reason: () => 'Select two or more shapes.' })),
    ungroup: sharedCommand('dg-ungroup', 'ungroup', cmd.ungroup, w({ enabled: () => d.grouped, reason: () => 'Select a grouped shape.' })),
    // The label says what a click does; so does the icon (it used to show the
    // state on the ribbon and the action on the right-click menu).
    lock: {
      id: 'dg-lock',
      label: d.locked ? 'Unlock' : 'Lock',
      icon: d.locked ? 'lock_open' : 'lock',
      keys: ['shift', 'mod', 'l'],
      ...w(anything),
      checked: () => d.locked,
      run: cmd.toggleLock
    } as OfficeCommand,
    hide: { id: 'dg-hide', label: 'Hide', icon: 'visibility_off', ...w(shapes), run: cmd.hideSelection } as OfficeCommand,
    copyStyle: { id: 'dg-copy-style', label: 'Copy style', icon: 'format_paint', keys: ['alt', 'mod', 'c'], ...shapes, run: cmd.copyStyle } as OfficeCommand,
    pasteStyle: {
      id: 'dg-paste-style',
      label: 'Paste style',
      icon: 'format_color_fill',
      keys: ['alt', 'mod', 'v'],
      ...w({ enabled: () => d.nodes > 0 && cmd.hasStyleClipboard(), reason: () => (d.nodes > 0 ? 'Copy a style first.' : 'Select a shape first.') }),
      run: cmd.pasteStyle
    } as OfficeCommand,
    bold: textCommand(d, w, 'bold', 'Bold', 'format_bold', 'b'),
    italic: textCommand(d, w, 'italic', 'Italic', 'format_italic', 'i'),
    underline: textCommand(d, w, 'underline', 'Underline', 'format_underlined', 'u'),
    // One wording for the view controls (it was "Fit to view" in the menu, "Fit
    // page" elsewhere; "Zoom to shape" on the right-click menu).
    fit: { id: 'dg-fit', label: 'Fit page', icon: 'fit_screen', keys: ['shift', '1'], run: cmd.fit } as OfficeCommand,
    zoomToSelection: { id: 'dg-zoom-selection', label: 'Zoom to selection', icon: 'zoom_in_map', keys: ['shift', '2'], ...shapes, run: cmd.zoomToSelection } as OfficeCommand,
    zoomIn: { id: 'dg-zoom-in', label: 'Zoom in', icon: 'zoom_in', keys: ['mod', 'plus'], run: cmd.zoomIn } as OfficeCommand,
    zoomOut: { id: 'dg-zoom-out', label: 'Zoom out', icon: 'zoom_out', keys: ['mod', 'minus'], run: cmd.zoomOut } as OfficeCommand,
    actualSize: { id: 'dg-actual-size', label: 'Actual size', icon: 'crop_free', keys: ['mod', '0'], run: () => cmd.zoomTo(1) } as OfficeCommand
  }
}

// Bold / Italic / Underline: the ribbon and ⌘B / ⌘I / ⌘U run the same toggle
// (commands.toggleTextStyle).
function textCommand(
  d: DiagramCommandDeps,
  w: (gate?: Pick<OfficeCommand, 'enabled' | 'reason'>) => Required<Pick<OfficeCommand, 'enabled' | 'reason'>>,
  key: 'bold' | 'italic' | 'underline',
  label: string,
  icon: string,
  k: string
): OfficeCommand {
  return {
    id: `dg-${key}`,
    label,
    icon,
    keys: ['mod', k],
    ...w({ enabled: () => d.nodes > 0, reason: () => 'Select a shape first.' }),
    checked: () => d.cmd.textStyleOn(key),
    run: () => d.cmd.toggleTextStyle(key)
  }
}
