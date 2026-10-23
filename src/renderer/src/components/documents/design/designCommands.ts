import { sharedCommand, type OfficeCommand } from '../../../lib/menus/officeCommand'

// PlexiiDesign's shared actions, each defined once (SPEC §9, no repeats): the
// menu bar, the ribbon, the right-click menu render from this record. Ids are
// new (Design had no palette); they follow a `ds-` prefix. DOM-free.

export interface DesignCommandDeps {
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
  const sel = { enabled: () => d.selected > 0, reason: () => 'Select something first' }
  const mark = (m: 'bold' | 'italic' | 'underline', label: string, icon: string, key: string): OfficeCommand => ({
    id: `ds-${m}`,
    label,
    icon,
    keys: ['mod', key],
    enabled: () => d.textMarks !== null,
    reason: () => 'Select a text frame first',
    checked: () => !!d.textMarks?.[m],
    run: () => d.toggleMark(m)
  })
  return {
    undo: sharedCommand('ds-undo', 'undo', d.undo),
    redo: sharedCommand('ds-redo', 'redo', d.redo),
    cut: sharedCommand('ds-cut', 'cut', d.cut, sel),
    copy: sharedCommand('ds-copy', 'copy', d.copy, sel),
    paste: sharedCommand('ds-paste', 'paste', d.paste, { enabled: () => d.canPaste, reason: () => 'Nothing to paste' }),
    duplicate: sharedCommand('ds-duplicate', 'duplicate', d.duplicate, sel),
    remove: sharedCommand('ds-delete', 'delete', d.remove, sel),
    selectAll: sharedCommand('ds-select-all', 'selectAll', d.selectAll),
    group: sharedCommand('ds-group', 'group', d.group, { enabled: () => d.selected >= 2, reason: () => 'Select two or more things' }),
    ungroup: sharedCommand('ds-ungroup', 'ungroup', d.ungroup, { enabled: () => d.grouped, reason: () => 'Select a group to ungroup' }),
    bringToFront: sharedCommand('ds-front', 'bringToFront', () => d.reorder('front'), sel),
    // One step each way. The ribbon called the second "Send back" with the
    // send-to-back icon, and moved only the first selected frame.
    bringForward: { id: 'ds-forward', label: 'Bring forward', icon: 'arrow_upward', ...sel, run: () => d.reorder('forward') } as OfficeCommand,
    sendBackward: { id: 'ds-backward', label: 'Send backward', icon: 'arrow_downward', ...sel, run: () => d.reorder('back') } as OfficeCommand,
    sendToBack: sharedCommand('ds-back', 'sendToBack', () => d.reorder('backmost'), sel),
    saveSnippet: sharedCommand('ds-save-snippet', 'saveAsSnippet', d.saveSnippet, sel),
    insertSnippet: sharedCommand('ds-insert-snippet', 'insertSnippet', d.insertSnippet),
    bold: mark('bold', 'Bold', 'format_bold', 'b'),
    italic: mark('italic', 'Italic', 'format_italic', 'i'),
    underline: mark('underline', 'Underline', 'format_underlined', 'u'),
    removeBackground: { id: 'ds-remove-bg', label: 'Remove background', icon: 'auto_awesome', run: d.removeBackground } as OfficeCommand,
    addPage: { id: 'ds-add-page', label: 'Add page', icon: 'note_add', run: d.addPage } as OfficeCommand
  }
}
