import { sharedCommand, writeGate, type OfficeCommand } from '../../../lib/menus/officeCommand'

// PlexiiDesign's shared actions, each defined once (SPEC §9, no repeats): the
// menu bar, the ribbon, the right-click menu render from this record. Ids are
// new (Design had no palette); they follow a `ds-` prefix. DOM-free.

export interface DesignCommandDeps {
  /**
   * A viewer's design (LiveDocEditorView's viewerOnly): every command that
   * changes it is off with the shell's READ_ONLY_REASON. Read strictly
   * (`=== true`): a stub-deps proxy answers a function for a missing key.
   */
  readOnly: boolean
  selected: number
  /** The first selected element is a text frame: its character style, else null. */
  textMarks: { bold?: boolean; italic?: boolean; underline?: boolean } | null
  grouped: boolean
  canPaste: boolean
  undo: () => void
  redo: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  duplicate: () => void
  remove: () => void
  selectAll: () => void
  group: () => void
  ungroup: () => void
  reorder: (dir: 'front' | 'forward' | 'back' | 'backmost') => void
  saveSnippet: () => void
  insertSnippet: () => void
  toggleMark: (mark: 'bold' | 'italic' | 'underline') => void
  removeBackground: () => void
  addPage: () => void
}

export type DesignCommands = ReturnType<typeof buildDesignCommands>

export function buildDesignCommands(d: DesignCommandDeps) {
  const sel = { enabled: () => d.selected > 0, reason: () => 'Select something first.' }
  // Changes the design: off for a viewer first, then the command's own gate.
  const ro = d.readOnly === true
  const w = (gate?: Pick<OfficeCommand, 'enabled' | 'reason'>): Required<Pick<OfficeCommand, 'enabled' | 'reason'>> => writeGate(ro, gate)
  const mark = (m: 'bold' | 'italic' | 'underline', label: string, icon: string, key: string): OfficeCommand => ({
    id: `ds-${m}`,
    label,
    icon,
    keys: ['mod', key],
    ...w({ enabled: () => d.textMarks !== null, reason: () => 'Select a text frame first.' }),
    checked: () => !!d.textMarks?.[m],
    run: () => d.toggleMark(m)
  })
  return {
    undo: sharedCommand('ds-undo', 'undo', d.undo, w()),
    redo: sharedCommand('ds-redo', 'redo', d.redo, w()),
    cut: sharedCommand('ds-cut', 'cut', d.cut, w(sel)),
    copy: sharedCommand('ds-copy', 'copy', d.copy, sel),
    paste: sharedCommand('ds-paste', 'paste', d.paste, w({ enabled: () => d.canPaste, reason: () => 'Nothing to paste.' })),
    duplicate: sharedCommand('ds-duplicate', 'duplicate', d.duplicate, w(sel)),
    remove: sharedCommand('ds-delete', 'delete', d.remove, w(sel)),
    selectAll: sharedCommand('ds-select-all', 'selectAll', d.selectAll),
    group: sharedCommand('ds-group', 'group', d.group, w({ enabled: () => d.selected >= 2, reason: () => 'Select two or more things.' })),
    ungroup: sharedCommand('ds-ungroup', 'ungroup', d.ungroup, w({ enabled: () => d.grouped, reason: () => 'Select a group to ungroup.' })),
    bringToFront: sharedCommand('ds-front', 'bringToFront', () => d.reorder('front'), w(sel)),
    // One step each way. The ribbon called the second "Send back" with the
    // send-to-back icon, and moved only the first selected frame.
    bringForward: { id: 'ds-forward', label: 'Bring forward', icon: 'arrow_upward', ...w(sel), run: () => d.reorder('forward') } as OfficeCommand,
    sendBackward: { id: 'ds-backward', label: 'Send backward', icon: 'arrow_downward', ...w(sel), run: () => d.reorder('back') } as OfficeCommand,
    sendToBack: sharedCommand('ds-back', 'sendToBack', () => d.reorder('backmost'), w(sel)),
    saveSnippet: sharedCommand('ds-save-snippet', 'saveAsSnippet', d.saveSnippet, sel),
    insertSnippet: sharedCommand('ds-insert-snippet', 'insertSnippet', d.insertSnippet, w()),
    bold: mark('bold', 'Bold', 'format_bold', 'b'),
    italic: mark('italic', 'Italic', 'format_italic', 'i'),
    underline: mark('underline', 'Underline', 'format_underlined', 'u'),
    removeBackground: { id: 'ds-remove-bg', label: 'Remove background', icon: 'auto_awesome', ...w(), run: d.removeBackground } as OfficeCommand,
    addPage: { id: 'ds-add-page', label: 'Add page', icon: 'note_add', ...w(), run: d.addPage } as OfficeCommand
  }
}
