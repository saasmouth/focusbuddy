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
  // ── Insert and Layout (the menu bar's own rows, hand-written until
  // viewer-registry-41, so a viewer saw them live and the editor refused) ──
  addText: () => void
  addImage: () => void
  addShape: (shape: 'rect' | 'ellipse' | 'roundRect' | 'triangle') => void
  addLine: () => void
  insertPageNumber: () => void
  addWidget: () => void
  openLayout: () => void
  openStyles: () => void
  openSwatches: () => void
  /** Layout guides on screen: this viewer's own view, never written to the design. */
  guidesVisible: boolean
  toggleGuides: () => void
  facing: boolean
  toggleFacing: () => void
  masters: Array<{ id: string; name: string }>
  editingMasterId: string | null
  addMaster: () => void
  editMaster: (id: string | null) => void
  duplicatePage: () => void
  canLink: boolean
  canUnlink: boolean
  linkFrames: () => void
  unlinkFrame: () => void
  find: () => void
  findAndReplace: () => void
  /** Check accessibility: reads the design and reports, so a viewer keeps it. */
  checkA11y: () => void
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
    addPage: { id: 'ds-add-page', label: 'Add page', icon: 'note_add', ...w(), run: d.addPage } as OfficeCommand,
    // Insert. Each label is the row's own (Insert ▸ supplies the verb).
    insertText: { id: 'ds-insert-text', label: 'Text', icon: 'title', ...w(), run: d.addText } as OfficeCommand,
    insertImage: { id: 'ds-insert-image', label: 'Image', icon: 'image', ...w(), run: d.addImage } as OfficeCommand,
    insertRect: { id: 'ds-insert-rect', label: 'Rectangle', ...w(), run: () => d.addShape('rect') } as OfficeCommand,
    insertRoundRect: { id: 'ds-insert-round-rect', label: 'Rounded rectangle', ...w(), run: () => d.addShape('roundRect') } as OfficeCommand,
    insertEllipse: { id: 'ds-insert-ellipse', label: 'Ellipse', ...w(), run: () => d.addShape('ellipse') } as OfficeCommand,
    insertTriangle: { id: 'ds-insert-triangle', label: 'Triangle', ...w(), run: () => d.addShape('triangle') } as OfficeCommand,
    insertLine: { id: 'ds-insert-line', label: 'Line', icon: 'horizontal_rule', ...w(), run: d.addLine } as OfficeCommand,
    insertPageNumber: { id: 'ds-insert-page-number', label: 'Page-number frame', icon: 'tag', ...w(), run: d.insertPageNumber } as OfficeCommand,
    insertWidget: sharedCommand('ds-insert-widget', 'workWidgetFromDesk', d.addWidget, { icon: 'widgets', ...w() }),
    // Layout. The three panels set the design's margins, styles and inks.
    layoutPanel: { id: 'ds-layout', label: 'Margins, columns & layers…', icon: 'grid_on', ...w(), run: d.openLayout } as OfficeCommand,
    stylesPanel: { id: 'ds-styles', label: 'Paragraph styles…', icon: 'format_paint', ...w(), run: d.openStyles } as OfficeCommand,
    swatchesPanel: { id: 'ds-swatches', label: 'Swatches & spot inks…', icon: 'palette', ...w(), run: d.openSwatches } as OfficeCommand,
    // The guides are this person's view of the page, not the design: no gate.
    toggleGuides: {
      id: 'ds-guides',
      label: 'Show layout guides',
      barLabel: 'Layout guides',
      icon: d.guidesVisible ? 'visibility' : 'visibility_off',
      checked: () => d.guidesVisible,
      run: d.toggleGuides
    } as OfficeCommand,
    facing: { id: 'ds-facing', label: 'Facing pages', icon: 'auto_stories', ...w(), checked: () => d.facing, run: d.toggleFacing } as OfficeCommand,
    newMaster: { id: 'ds-new-master', label: 'New master page', icon: 'add', ...w(), run: d.addMaster } as OfficeCommand,
    // One definition for every "Edit ‹master›" row: the menu renders a row per
    // master from it (its label and run per master, its gate shared).
    editMaster: {
      id: 'ds-edit-master',
      label: 'Edit master page',
      ...w({ enabled: () => d.masters.length > 0, reason: () => 'Add a master page first.' }),
      run: () => d.editMaster(d.masters[0]?.id ?? null)
    } as OfficeCommand,
    stopEditingMaster: { id: 'ds-stop-master', label: 'Stop editing master', ...w(), run: () => d.editMaster(null) } as OfficeCommand,
    duplicatePage: { id: 'ds-duplicate-page', label: 'Duplicate this page', icon: 'file_copy', ...w(), run: d.duplicatePage } as OfficeCommand,
    linkFrames: {
      id: 'ds-link-frames',
      label: 'Link text frames into one story',
      icon: 'link',
      ...w({ enabled: () => d.canLink, reason: () => 'Select two or more text frames.' }),
      run: d.linkFrames
    } as OfficeCommand,
    unlinkFrame: {
      id: 'ds-unlink-frame',
      label: 'Unlink frame from its story',
      icon: 'link_off',
      ...w({ enabled: () => d.canUnlink, reason: () => 'Select a frame in a story.' }),
      run: d.unlinkFrame
    } as OfficeCommand,
    // Find reads; its Replace row writes (as Diagrams' pair).
    find: sharedCommand('ds-find', 'find', d.find, { icon: 'search' }),
    findAndReplace: sharedCommand('ds-find-replace', 'findAndReplace', d.findAndReplace, { icon: 'find_replace', ...w() }),
    // Reads the design and reports: a viewer keeps it, in the menu and the bar (as Deck's sl-a11y).
    checkA11y: { id: 'ds-a11y', label: 'Check accessibility', icon: 'accessibility_new', run: d.checkA11y } as OfficeCommand
  }
}
