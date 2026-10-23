import { sharedCommand, type OfficeCommand } from '../../../lib/menus/officeCommand'

// PlexiiDeck's actions, each defined once (SPEC §9, no repeats): the menu bar,
// the ribbon, the right-click menu and the palette all render from this record,
// so an action cannot read, hint or behave differently on two surfaces. Ids are
// the palette's existing ones (sl-*); new ones follow the prefix. DOM-free:
// the editor passes its real functions and state, a test passes stubs.

export interface DeckCommandDeps {
  /** How many elements are selected, and whether a group is among them. */
  selected: number
  anyGrouped: boolean
  canUndo: boolean
  canRedo: boolean
  canPaste: boolean
  /** The one selected text box's character style, or null when there is none (B/I/U apply to it). */
  textMarks: { bold?: boolean; italic?: boolean; underline?: boolean } | null
  toggleMark: (mark: 'bold' | 'italic' | 'underline') => void
  /** A slide snippet (one slide, no deck): slide-level commands are absent. */
  singleSlide: boolean
  undo: () => void
  redo: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  duplicate: () => void
  remove: () => void
  selectAll: () => void
  find: () => void
  findAndReplace: () => void
  saveSnippet: () => void
  insertSnippet: () => void
  group: () => void
  ungroup: () => void
  reorder: (dir: 'front' | 'forward' | 'back' | 'backmost') => void
  align: (dir: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom') => void
  distribute: (axis: 'h' | 'v') => void
  centre: (axis: 'h' | 'v') => void
  insertText: () => void
  insertShape: (shape: 'rect' | 'ellipse') => void
  insertImage: () => void
  insertLine: () => void
  insertTable: () => void
  insertChart: () => void
  insertWidget: () => void
  newSlide: () => void
  duplicateSlide: () => void
  deleteSlide: () => void
  present: () => void
  checkA11y: () => void
  importFile: () => void
  exportFile: (format: 'pptx' | 'pdf') => void
  openAi: () => void
}

export type DeckCommands = ReturnType<typeof buildDeckCommands>

export function buildDeckCommands(d: DeckCommandDeps) {
  const some = (): boolean => d.selected > 0
  const SELECT = (): string => 'Select something first'
  const sel = { enabled: some, reason: SELECT }
  const two = { enabled: () => d.selected >= 2, reason: () => 'Select two or more to align' }
  return {
    undo: sharedCommand('sl-undo', 'undo', d.undo, { icon: 'undo', group: 'Edit', enabled: () => d.canUndo, reason: () => 'Nothing to undo' }),
    redo: sharedCommand('sl-redo', 'redo', d.redo, { icon: 'redo', group: 'Edit', enabled: () => d.canRedo, reason: () => 'Nothing to redo' }),
    cut: sharedCommand('sl-cut', 'cut', d.cut, { group: 'Edit', ...sel }),
    copy: sharedCommand('sl-copy', 'copy', d.copy, { group: 'Edit', ...sel }),
    paste: sharedCommand('sl-paste', 'paste', d.paste, { group: 'Edit', enabled: () => d.canPaste, reason: () => 'Nothing to paste' }),
    duplicate: sharedCommand('sl-dup', 'duplicate', d.duplicate, { group: 'Arrange', ...sel }),
    remove: sharedCommand('sl-del', 'delete', d.remove, { group: 'Arrange', keywords: 'remove', ...sel }),
    selectAll: sharedCommand('sl-select-all', 'selectAll', d.selectAll, { group: 'Edit' }),
    find: sharedCommand('sl-find', 'find', d.find, { icon: 'search', group: 'Edit', keywords: 'search' }),
    findAndReplace: sharedCommand('sl-find-replace', 'findAndReplace', d.findAndReplace, { icon: 'find_replace', group: 'Edit', keywords: 'search replace' }),
    saveSnippet: sharedCommand('sl-save-snippet', 'saveAsSnippet', d.saveSnippet, { group: 'Arrange', keywords: 'saved reuse library keep', ...sel }),
    insertSnippet: sharedCommand('sl-snippet', 'insertSnippet', d.insertSnippet, { group: 'Insert', keywords: 'saved reuse library' }),
    group: sharedCommand('sl-group', 'group', d.group, { icon: 'group_work', group: 'Arrange', keywords: 'combine link', enabled: () => d.selected >= 2, reason: () => 'Select two or more to group' }),
    ungroup: sharedCommand('sl-ungroup', 'ungroup', d.ungroup, { icon: 'category', group: 'Arrange', keywords: 'split separate', enabled: () => d.anyGrouped, reason: () => 'Select a group to ungroup' }),
    bringToFront: sharedCommand('sl-front', 'bringToFront', () => d.reorder('front'), { group: 'Arrange', keywords: 'z order top', ...sel }),
    bringForward: { id: 'sl-forward', label: 'Bring forward', icon: 'arrow_upward', group: 'Arrange', keywords: 'z order', ...sel, run: () => d.reorder('forward') } as OfficeCommand,
    sendBackward: { id: 'sl-backward', label: 'Send backward', icon: 'arrow_downward', group: 'Arrange', keywords: 'z order', ...sel, run: () => d.reorder('back') } as OfficeCommand,
    sendToBack: sharedCommand('sl-back', 'sendToBack', () => d.reorder('backmost'), { group: 'Arrange', keywords: 'z order bottom', ...sel }),
    alignLeft: { id: 'sl-al', label: 'Align left edges', icon: 'align_horizontal_left', group: 'Align', ...two, run: () => d.align('left') } as OfficeCommand,
    alignCentreX: { id: 'sl-acx', label: 'Align horizontal centres', icon: 'align_horizontal_center', group: 'Align', keywords: 'center middle', ...two, run: () => d.align('centerX') } as OfficeCommand,
    alignRight: { id: 'sl-ar', label: 'Align right edges', icon: 'align_horizontal_right', group: 'Align', ...two, run: () => d.align('right') } as OfficeCommand,
    alignTop: { id: 'sl-at', label: 'Align top edges', icon: 'align_vertical_top', group: 'Align', ...two, run: () => d.align('top') } as OfficeCommand,
    alignMiddleY: { id: 'sl-amy', label: 'Align vertical centres', icon: 'align_vertical_center', group: 'Align', keywords: 'middle center', ...two, run: () => d.align('middleY') } as OfficeCommand,
    alignBottom: { id: 'sl-ab', label: 'Align bottom edges', icon: 'align_vertical_bottom', group: 'Align', ...two, run: () => d.align('bottom') } as OfficeCommand,
    distributeH: { id: 'sl-dh', label: 'Distribute horizontally', icon: 'horizontal_distribute', group: 'Align', keywords: 'space even', enabled: () => d.selected >= 3, reason: () => 'Select three or more to distribute', run: () => d.distribute('h') } as OfficeCommand,
    distributeV: { id: 'sl-dv', label: 'Distribute vertically', icon: 'vertical_distribute', group: 'Align', keywords: 'space even', enabled: () => d.selected >= 3, reason: () => 'Select three or more to distribute', run: () => d.distribute('v') } as OfficeCommand,
    centreH: { id: 'sl-ch', label: 'Centre on slide horizontally', icon: 'align_horizontal_center', group: 'Arrange', keywords: 'align center middle slide', ...sel, run: () => d.centre('h') } as OfficeCommand,
    centreV: { id: 'sl-cv', label: 'Centre on slide vertically', icon: 'align_vertical_center', group: 'Arrange', keywords: 'align center middle slide', ...sel, run: () => d.centre('v') } as OfficeCommand,
    bold: markCommand(d, 'bold', 'Bold', 'format_bold', 'b'),
    italic: markCommand(d, 'italic', 'Italic', 'format_italic', 'i'),
    underline: markCommand(d, 'underline', 'Underline', 'format_underlined', 'u'),
    insertText: { id: 'sl-text', label: 'Text box', icon: 'title', group: 'Insert', keywords: 'insert type words', run: d.insertText } as OfficeCommand,
    insertRect: { id: 'sl-shape', label: 'Rectangle', icon: 'crop_square', group: 'Insert', keywords: 'insert shape box', run: () => d.insertShape('rect') } as OfficeCommand,
    insertEllipse: { id: 'sl-ellipse', label: 'Ellipse', icon: 'circle', group: 'Insert', keywords: 'insert shape oval circle', run: () => d.insertShape('ellipse') } as OfficeCommand,
    insertImage: { id: 'sl-image', label: 'Image', icon: 'image', group: 'Insert', keywords: 'insert picture photo', run: d.insertImage } as OfficeCommand,
    insertLine: { id: 'sl-line', label: 'Line', icon: 'horizontal_rule', group: 'Insert', keywords: 'insert arrow connector', run: d.insertLine } as OfficeCommand,
    insertTable: { id: 'sl-table', label: 'Table', icon: 'grid_on', group: 'Insert', keywords: 'insert grid rows columns cells', run: d.insertTable } as OfficeCommand,
    insertChart: { id: 'sl-chart', label: 'Chart', icon: 'bar_chart', group: 'Insert', keywords: 'insert graph plot data sheet', run: d.insertChart } as OfficeCommand,
    insertWidget: sharedCommand('sl-widget', 'workWidgetFromDesk', d.insertWidget, { icon: 'widgets', group: 'Insert', keywords: 'insert embed desk canvas' }),
    // One New slide: the template gallery, as the ribbon and palette always did
    // (the menu's used to add a blank slide without asking).
    newSlide: { id: 'sl-new', label: 'New slide', icon: 'add_to_photos', group: 'Slide', keywords: 'add template', ...(d.singleSlide ? noSlides : {}), run: d.newSlide } as OfficeCommand,
    duplicateSlide: { id: 'sl-dup-slide', label: 'Duplicate slide', icon: 'file_copy', group: 'Slide', ...(d.singleSlide ? noSlides : {}), run: d.duplicateSlide } as OfficeCommand,
    deleteSlide: { id: 'sl-del-slide', label: 'Delete slide', icon: 'delete', group: 'Slide', ...(d.singleSlide ? noSlides : {}), run: d.deleteSlide } as OfficeCommand,
    present: { id: 'sl-present', label: 'Present', icon: 'play_arrow', group: 'Slide', keywords: 'slideshow play deck', run: d.present } as OfficeCommand,
    checkA11y: { id: 'sl-a11y', label: 'Check accessibility', icon: 'accessibility_new', group: 'Review', keywords: 'contrast alt text', run: d.checkA11y } as OfficeCommand,
    importPptx: { id: 'sl-import', label: 'Import PowerPoint (.pptx)…', icon: 'upload_file', group: 'File', keywords: 'open pptx', ...(d.singleSlide ? noSlides : {}), run: d.importFile } as OfficeCommand,
    downloadPptx: { id: 'sl-export-pptx', label: 'Download PowerPoint (.pptx)', shortLabel: 'PowerPoint (.pptx)', icon: 'slideshow', group: 'File', keywords: 'export save pptx', run: () => d.exportFile('pptx') } as OfficeCommand,
    downloadPdf: { id: 'sl-export-pdf', label: 'Download PDF document (.pdf)', shortLabel: 'PDF document (.pdf)', icon: 'picture_as_pdf', group: 'File', keywords: 'export save pdf', run: () => d.exportFile('pdf') } as OfficeCommand,
    ai: { id: 'sl-ai', label: 'AI: generate or redesign slides', icon: 'auto_awesome', group: 'AI', keywords: 'design make beautiful', run: d.openAi } as OfficeCommand
  }
}

// A slide snippet is one slide with no deck around it: slide-level commands
// do not apply there, and say so.
const noSlides: Pick<OfficeCommand, 'enabled' | 'reason'> = { enabled: () => false, reason: () => 'Not in a single-slide snippet' }

// Bold / Italic / Underline on the selected text box (the whole box, as Google
// Slides does with a shape selected). Bound to ⌘B / ⌘I / ⌘U in the editor's key
// handler, which the ribbon has always shown.
function markCommand(d: DeckCommandDeps, mark: 'bold' | 'italic' | 'underline', label: string, icon: string, key: string): OfficeCommand {
  return {
    id: `sl-${mark}`,
    label,
    icon,
    keys: ['mod', key],
    group: 'Format',
    enabled: () => d.textMarks !== null,
    reason: () => 'Select a text box first',
    checked: () => !!d.textMarks?.[mark],
    run: () => d.toggleMark(mark)
  }
}
