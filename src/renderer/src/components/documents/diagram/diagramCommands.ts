import { sharedCommand, writeGate, type OfficeCommand } from '../../../lib/menus/officeCommand'
import { runCommandKey, type KeyLikeEvent } from '../../../lib/menus/commandKeys'
import type { MapSettings } from '@shared/types'
import { SHAPES } from '@shared/diagram/shapes'
import type { Commands } from './commands'
import type { Tool } from './DiagramEditor'

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
  /**
   * Whether there is a step to undo / redo (Edit's rows say "Nothing to undo."
   * when not). The key listener passes true: ⌘Z simply tries, as it always
   * did, and is refused only for a viewer.
   */
  canUndo: boolean
  canRedo: boolean
  /** The diagram's settings, for View's toggles (absent: their defaults). */
  settings?: MapSettings
  /** Shapes hidden on this page (Arrange ▸ Show all hidden). */
  hidden?: number
  /**
   * What only the editor's chrome can do: arm a tool, open its dialogs, panes
   * and file pickers, show a status line. The key listener passes setTool
   * alone; the right-click menu passes none (it renders none of those rows).
   */
  ui?: DiagramCommandUi
}

export interface DiagramCommandUi {
  setTool?: (t: Tool) => void
  openDialog?: (d: 'data' | 'data-widgets' | 'templates' | 'mermaid') => void
  pickImage?: () => void
  /** Open the AI pane (not toggle: the menu row only ever opens it). */
  openAi?: () => void
  importFile?: (kind: 'drawio' | 'json') => void
  setStatus?: (msg: string) => void
  /** The saved-snippets library; absent where the editor offers none. */
  insertSnippet?: () => void
}

const tableShapeId = (): string => SHAPES.find((s) => s.special === 'table')?.id ?? 'process'
const stickyShapeId = (): string => SHAPES.find((s) => s.special === 'sticky')?.id ?? 'note'

export type DiagramCommands = ReturnType<typeof buildDiagramCommands>

export function buildDiagramCommands(d: DiagramCommandDeps) {
  const { cmd } = d
  const ui = d.ui ?? {}
  const settings = d.settings ?? {}
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
    actualSize: { id: 'dg-actual-size', label: 'Actual size', icon: 'crop_free', keys: ['mod', '0'], run: () => cmd.zoomTo(1) } as OfficeCommand,

    // ── Rows the chrome and the right-click menu wrote by hand until
    // viewer-registry-41, live for a viewer while the editor refused (or, for
    // a key, changed the viewer's copy). Each label is the row's own. ───────
    undo: sharedCommand('dg-undo', 'undo', cmd.undo, { icon: 'undo', ...w({ enabled: () => d.canUndo, reason: () => 'Nothing to undo.' }) }),
    redo: sharedCommand('dg-redo', 'redo', cmd.redo, { icon: 'redo', ...w({ enabled: () => d.canRedo, reason: () => 'Nothing to redo.' }) }),
    // Edit text (a shape) / Edit label (a line), and Enter: one action, cmd.editSelected.
    editText: {
      id: 'dg-edit-text',
      label: 'Edit text',
      icon: 'edit',
      keys: ['enter'],
      ...w({ enabled: () => d.nodes === 1 || (d.nodes === 0 && d.edges === 1), reason: () => 'Select one shape.' }),
      run: cmd.editSelected
    } as OfficeCommand,
    // Insert. One definition for every shape row (the menu's quick shapes and
    // its category submenus, the right-click "Add … here"): each row passes
    // its shape, the gate is this one.
    insertShape: { id: 'dg-insert-shape', label: 'Shape', icon: 'category', ...w(), run: () => void cmd.addShape('process') } as OfficeCommand,
    insertText: { id: 'dg-insert-text', label: 'Text', icon: 'title', keys: ['t'], ...w(), run: () => ui.setTool?.('text') } as OfficeCommand,
    insertTable: { id: 'dg-insert-table', label: 'Table', icon: 'table', ...w(), run: () => void cmd.addShape(tableShapeId()) } as OfficeCommand,
    insertSticky: { id: 'dg-insert-sticky', label: 'Sticky note', icon: 'sticky_note_2', ...w(), run: () => void cmd.addShape(stickyShapeId()) } as OfficeCommand,
    insertSwimlane: { id: 'dg-insert-swimlane', label: 'Swimlane', icon: 'view_column', ...w(), run: () => void cmd.addShape('lane') } as OfficeCommand,
    insertImage: { id: 'dg-insert-image', label: 'Image…', icon: 'image', ...w(), run: () => ui.pickImage?.() } as OfficeCommand,
    fromTable: { id: 'dg-insert-from-table', label: 'From a Plexii table…', icon: 'table_chart', ...w(), run: () => ui.openDialog?.('data') } as OfficeCommand,
    template: { id: 'dg-insert-template', label: 'Template…', icon: 'dashboard', ...w(), run: () => ui.openDialog?.('templates') } as OfficeCommand,
    // Insert ▸ Mermaid… and File ▸ Import ▸ Mermaid… open the same dialog.
    mermaid: { id: 'dg-insert-mermaid', label: 'Mermaid…', icon: 'code', ...w(), run: () => ui.openDialog?.('mermaid') } as OfficeCommand,
    aiDiagram: { id: 'dg-ai-diagram', label: 'AI diagram…', icon: 'auto_awesome', ...w(), run: () => ui.openAi?.() } as OfficeCommand,
    newPage: { id: 'dg-new-page', label: 'New page', icon: 'note_add', ...w(), run: cmd.addPage } as OfficeCommand,
    insertSnippet: sharedCommand('dg-insert-snippet', 'insertSnippet', () => ui.insertSnippet?.(), { icon: 'bookmarks', ...w() }),
    insertWidget: sharedCommand('dg-insert-widget', 'workWidgetFromDesk', () => ui.openDialog?.('data-widgets'), { icon: 'widgets', ...w() }),
    // File ▸ Import: each replaces or adds to the diagram.
    importDrawio: { id: 'dg-import-drawio', label: 'draw.io / diagrams.net file…', icon: 'draw', ...w(), run: () => ui.importFile?.('drawio') } as OfficeCommand,
    importVsdx: {
      id: 'dg-import-vsdx',
      label: 'Visio (.vsdx)…',
      icon: 'schema',
      ...w(),
      run: () => void cmd.importVsdx().then((e) => e && ui.setStatus?.(e))
    } as OfficeCommand,
    importJson: { id: 'dg-import-json', label: 'PlexiiDiagrams JSON…', icon: 'data_object', ...w(), run: () => ui.importFile?.('json') } as OfficeCommand,
    // View. Grid and Minimap are view aids the ribbon already keeps live for a
    // viewer (readOnlySafe there); snapping, guides and line jumps shape what
    // is drawn, so they are off with the rest.
    grid: { id: 'dg-grid', label: 'Grid', icon: 'grid_on', checked: () => settings.grid !== false, run: () => cmd.setSettings({ grid: settings.grid === false ? undefined : false }) } as OfficeCommand,
    snap: {
      id: 'dg-snap',
      label: 'Snap to grid',
      icon: 'grid_goldenratio',
      ...w(),
      checked: () => settings.snap !== false,
      run: () => cmd.setSettings({ snap: settings.snap === false ? undefined : false })
    } as OfficeCommand,
    guides: {
      id: 'dg-guides',
      label: 'Smart guides',
      icon: 'straighten',
      ...w(),
      checked: () => settings.guides !== false,
      run: () => cmd.setSettings({ guides: settings.guides === false ? undefined : false })
    } as OfficeCommand,
    lineJumps: { id: 'dg-line-jumps', label: 'Line jumps', icon: 'u_turn_right', ...w(), checked: () => !!settings.lineJumps, run: () => cmd.setSettings({ lineJumps: settings.lineJumps ? undefined : true }) } as OfficeCommand,
    minimap: { id: 'dg-minimap', label: 'Minimap', icon: 'map', checked: () => settings.minimap !== false, run: () => cmd.setSettings({ minimap: settings.minimap === false ? undefined : false }) } as OfficeCommand,
    // Arrange.
    showAllHidden: {
      id: 'dg-show-hidden',
      label: 'Show all hidden',
      icon: 'visibility',
      ...w({ enabled: () => (d.hidden ?? 0) > 0, reason: () => 'Nothing on this page is hidden.' }),
      run: cmd.showAllHidden
    } as OfficeCommand,
    // One definition each for Align ▸, Distribute ▸, Auto layout ▸ and Route ▸: each row passes its own argument.
    align: { id: 'dg-align', label: 'Align', icon: 'align_horizontal_left', ...w({ enabled: () => d.nodes >= 2, reason: () => 'Select two or more shapes.' }), run: () => cmd.align('left') } as OfficeCommand,
    distribute: {
      id: 'dg-distribute',
      label: 'Distribute',
      icon: 'horizontal_distribute',
      ...w({ enabled: () => d.nodes >= 3, reason: () => 'Select three or more shapes.' }),
      run: () => cmd.distribute('h')
    } as OfficeCommand,
    rotateRight: { id: 'dg-rotate-right', label: 'Rotate 90° right', ...w(shapes), run: () => cmd.rotate(90) } as OfficeCommand,
    rotateLeft: { id: 'dg-rotate-left', label: 'Rotate 90° left', ...w(shapes), run: () => cmd.rotate(-90) } as OfficeCommand,
    flipH: { id: 'dg-flip-h', label: 'Flip horizontally', ...w(shapes), run: () => cmd.flip('x') } as OfficeCommand,
    flipV: { id: 'dg-flip-v', label: 'Flip vertically', ...w(shapes), run: () => cmd.flip('y') } as OfficeCommand,
    tidy: { id: 'dg-tidy', label: 'Tidy connections', icon: 'cleaning_services', ...w(), run: () => tidy(d) } as OfficeCommand,
    tidySelected: {
      id: 'dg-tidy-selected',
      label: 'Tidy these connections',
      icon: 'cleaning_services',
      ...w({ enabled: () => d.nodes >= 2, reason: () => 'Select two or more shapes.' }),
      run: () => tidy(d)
    } as OfficeCommand,
    autoLayout: { id: 'dg-auto-layout', label: 'Auto layout', icon: 'account_tree', ...w(), run: () => cmd.layout('layered', 'TB') } as OfficeCommand,
    route: { id: 'dg-route', label: 'Route', icon: 'turn_right', ...w(), run: () => cmd.setEdges({ routing: 'orthogonal', waypoints: undefined }) } as OfficeCommand
  }
}

/** Tidy connections, saying what it did where the chrome has a status line. */
function tidy(d: DiagramCommandDeps): void {
  const msg = d.cmd.tidyConnections()
  d.ui?.setStatus?.(msg)
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

/**
 * The editor's keydown, in order: a key a menu or the ribbon shows runs from
 * its command (commandKeys, refused by the command's gate); what is left goes
 * to commands.handleKey, whose keys that change the diagram take a gate too.
 * So a viewer's keys change nothing, while zoom, selection and the Select and
 * Hand tools stay live. Returns true when the key was handled.
 */
export function dispatchDiagramKey(
  e: KeyboardEvent | (KeyLikeEvent & Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'metaKey' | 'ctrlKey' | 'shiftKey'>),
  keys: DiagramCommands,
  cmd: Commands,
  ui: { setTool: (t: Tool) => void; tool: Tool; readOnly: boolean }
): boolean {
  if (runCommandKey(Object.values(keys), e)) return true
  return cmd.handleKey(e as KeyboardEvent, { ...ui, keys })
}
