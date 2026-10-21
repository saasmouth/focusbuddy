// PlexiiDraw's keyboard map: Illustrator's default shortcuts.
//
// Source for every Illustrator key here: Adobe, "Default keyboard shortcuts |
// Illustrator", https://helpx.adobe.com/illustrator/using/default-keyboard-shortcuts.html
// (read 2026-10-21 from the Wayback Machine capture of 2026-10-15, because
// helpx refuses scripted fetches). The whole table, row by row, with what each
// row means in PlexiiDraw, is in ./illustratorKeys.ts; a unit test holds this
// file to it.
//
// ONE LINE PER BINDING, kept sorted, so packages adding shortcuts never touch
// the same line. A unit test fails on an unsorted file, a binding naming no
// command, a tool key that is also bound here, and a key reserved for one
// feature but bound to another.
//
// Key strings: 'mod+' for Cmd on a Mac and Ctrl on Windows, then 'alt+'
// (Option / Alt), then 'shift+', then the key: a letter or digit, the
// unshifted US symbol on that key ('=', '[', "'", '\\', '`', ',', '.'), or the
// lower-cased KeyboardEvent.key name ('escape', 'arrowleft', 'f1'). See keys.ts:
// eventKeyString turns a keyboard event into this form on any layout.
//
// Tool keys (V, A, M, L, Shift+E...) are declared on the tools themselves.

export const KEYMAP: Record<string, readonly [string, 'prevent'?]> = {
  '[': ['brush.smaller'],
  ']': ['brush.larger'],
  arrowdown: ['object.nudgeDown', 'prevent'],
  arrowleft: ['object.nudgeLeft', 'prevent'],
  arrowright: ['object.nudgeRight', 'prevent'],
  arrowup: ['object.nudgeUp', 'prevent'],
  backspace: ['edit.delete', 'prevent'],
  delete: ['edit.delete', 'prevent'],
  enter: ['pen.finish'],
  escape: ['edit.escape'],
  f1: ['help.howItWorks', 'prevent'],
  f2: ['edit.cut', 'prevent'],
  f3: ['edit.copy', 'prevent'],
  f4: ['edit.paste', 'prevent'],
  "mod+'": ['view.grid', 'prevent'],
  'mod+-': ['view.zoomOut', 'prevent'],
  'mod+0': ['view.fit', 'prevent'],
  'mod+1': ['view.actualSize', 'prevent'],
  'mod+=': ['view.zoomIn', 'prevent'],
  'mod+[': ['object.arrange.backward', 'prevent'],
  'mod+]': ['object.arrange.forward', 'prevent'],
  'mod+a': ['edit.selectAll', 'prevent'],
  'mod+alt+j': ['path.average', 'prevent'],
  'mod+alt+n': ['file.new', 'prevent'],
  'mod+alt+p': ['document.artboardSize', 'prevent'],
  'mod+alt+s': ['file.copy', 'prevent'],
  'mod+alt+shift+d': ['object.transform.each', 'prevent'],
  'mod+alt+shift+j': ['path.averageJoin', 'prevent'],
  'mod+alt+shift+k': ['edit.keyboardShortcuts', 'prevent'],
  'mod+alt+shift+v': ['edit.pasteOnAllArtboards', 'prevent'],
  'mod+b': ['edit.pasteInBack', 'prevent'],
  'mod+c': ['edit.copy', 'prevent'],
  'mod+d': ['object.transformAgain', 'prevent'],
  'mod+f': ['edit.pasteInFront', 'prevent'],
  'mod+j': ['path.join', 'prevent'],
  'mod+l': ['layer.newVector', 'prevent'],
  'mod+n': ['file.new', 'prevent'],
  'mod+o': ['file.openSvg', 'prevent'],
  'mod+shift+[': ['object.arrange.back', 'prevent'],
  'mod+shift+]': ['object.arrange.front', 'prevent'],
  'mod+shift+a': ['edit.deselect', 'prevent'],
  'mod+shift+m': ['object.transform.move', 'prevent'],
  'mod+shift+p': ['file.place', 'prevent'],
  'mod+shift+v': ['edit.pasteInPlace', 'prevent'],
  'mod+shift+z': ['edit.redo', 'prevent'],
  'mod+u': ['view.snap', 'prevent'],
  'mod+v': ['edit.paste', 'prevent'],
  'mod+x': ['edit.cut', 'prevent'],
  'mod+z': ['edit.undo', 'prevent']
}

/**
 * Illustrator's keys for features PlexiiDraw does not have yet, so the package
 * that builds each one finds its key free. Key -> [the command or `tool:` id
 * that package should register, Illustrator's own name for it, the package
 * ('-' when no package is planned)].
 *
 * - A reserved key does nothing: it never falls through to another binding (so
 *   Shift+M is not the Rectangle tool's M), and its default is not prevented.
 * - When the expected command or tool arrives with this key, the reservation is
 *   fulfilled and the line can stay; binding the key to anything else fails
 *   the registry test.
 * - 'mod+r' is Illustrator's Windows rulers key and 'mod+alt+r' its macOS one.
 * - Numpad + reaches the editor as '+', the main-row plus as Shift+=.
 */
export const RESERVED_KEYS: Record<string, readonly [string, string, string]> = {
  '/': ['paint.noneMode', 'Select no stroke/fill mode', 'WP-COLOR'],
  d: ['paint.defaultFillStroke', 'Set fill and stroke to default', 'WP-COLOR'],
  f: ['view.screenMode', 'Toggle between screen modes: Normal Screen Mode, Full Screen Mode with Menu Bar, Full Screen Mode', 'WP-VIEWPORT'],
  f12: ['file.revert', 'Revert', '-'],
  f5: ['window.brushes', 'Show/hide Brushes panel', '-'],
  f6: ['window.color', 'Show/hide Color panel', 'WP-COLOR'],
  f7: ['window.layers', 'Show/hide Layers panel', 'WP-LAYERS'],
  f8: ['object.newSymbol', 'Create new symbol', 'WP-SYMBOLS'],
  g: ['tool:gradient', 'Gradient tool', 'WP-PAINT'],
  j: ['tool:columnGraph', 'Column Graph tool', '-'],
  'mod+/': ['appearance.addFill', 'Add new fill', 'WP-APPEAR'],
  'mod+2': ['object.lock', 'Lock a selection', 'WP-LAYERS'],
  'mod+3': ['object.hide', 'Hide a selection', 'WP-LAYERS'],
  'mod+4': ['object.repeatPathfinder', 'Apply last pathfinder effect to the selected object', 'WP-PATHFINDER'],
  'mod+5': ['view.makeGuides', 'Make guides', 'WP-SNAP'],
  'mod+6': ['edit.reselect', 'Reselect', '-'],
  'mod+7': ['object.makeClip', 'Make a clipping mask', 'WP-OBJ'],
  'mod+8': ['object.makeCompound', 'Create a compound path', 'WP-OBJ'],
  'mod+;': ['view.guides', 'Hide guides', 'WP-SNAP'],
  'mod+`': ['tool.lastSelection', 'Switch to last-used selection tool (Selection tool, Direct Selection tool, or Group Selection tool)', '-'],
  "mod+alt+'": ['view.snapToPoint', 'Snap to point', 'WP-SNAP'],
  'mod+alt+/': ['appearance.addStroke', 'Add new stroke', 'WP-APPEAR'],
  'mod+alt+0': ['view.fitAll', 'View all artboards in window', 'WP-ARTBOARD'],
  'mod+alt+2': ['object.unlockAll', 'Unlock a selection', 'WP-LAYERS'],
  'mod+alt+3': ['object.showAll', 'Show all selections', 'WP-LAYERS'],
  'mod+alt+5': ['view.releaseGuides', 'Release guides', 'WP-SNAP'],
  'mod+alt+7': ['object.releaseClip', 'Release a clipping mask', 'WP-OBJ'],
  'mod+alt+;': ['view.lockGuides', 'Lock guides', 'WP-SNAP'],
  'mod+alt+[': ['edit.selectBelow', 'Select the object below the current selection', 'WP-LAYERS'],
  'mod+alt+]': ['edit.selectAbove', 'Select the object above the current selection', 'WP-LAYERS'],
  'mod+alt+a': ['edit.selectAllOnArtboard', 'Select artwork in active artboard', 'WP-ARTBOARD'],
  'mod+alt+b': ['object.blendMake', 'Blend objects', 'WP-BLEND'],
  'mod+alt+c': ['object.envelopeTop', 'Distort objects using another object as the shape of the envelope', 'WP-ENVELOPE'],
  'mod+alt+e': ['file.exportForScreens', 'Open the Export for screens dialog box', 'WP-EXPORT'],
  'mod+alt+g': ['view.gradientAnnotator', 'Hide gradient annotator (when using the Gradient tool)', 'WP-PAINT'],
  'mod+alt+i': ['type.showHidden', 'Show hidden characters', 'WP-TYPE-A'],
  'mod+alt+l': ['layer.newWithOptions', 'Add a layer while opening the New Layer dialog box', 'WP-LAYERS'],
  'mod+alt+m': ['object.envelopeMesh', 'Distort objects using a mesh as the shape of the envelope', '-'],
  'mod+alt+r': ['view.rulers', 'Show/Hide artboard rulers', 'WP-SNAP'],
  'mod+alt+shift+2': ['object.lockOthers', 'Lock all deselected artwork', 'WP-LAYERS'],
  'mod+alt+shift+3': ['object.hideOthers', 'Hide unselected artwork', 'WP-LAYERS'],
  'mod+alt+shift+8': ['object.releaseCompound', 'Release a compound path', 'WP-OBJ'],
  'mod+alt+shift+b': ['object.blendRelease', 'Finish adding objects to the blend', 'WP-BLEND'],
  'mod+alt+shift+e': ['effect.applyLastWithOptions', 'Apply last effect to the selected object by adjusting the values in the effects dialog box', 'WP-EFFECTS'],
  'mod+alt+shift+f': ['type.focusFont', 'Highlight the font name field in the Character panel', 'WP-TYPE-A'],
  'mod+alt+shift+i': ['file.info', 'Open the File Information dialog box', '-'],
  'mod+alt+shift+p': ['file.package', 'Package the document', '-'],
  'mod+alt+shift+s': ['file.exportForWeb', 'Open the Save For Web dialog box', 'WP-EXPORT'],
  'mod+alt+shift+t': ['window.openType', 'Open the OpenType panel', 'WP-TYPE-A'],
  'mod+alt+shift+u': ['document.cycleUnits', 'Switch units of measurement', 'WP-PREFS'],
  'mod+alt+shift+w': ['object.envelopeWarp', 'Distort objects using a warp-shaped envelope', 'WP-ENVELOPE'],
  'mod+alt+shift+y': ['view.overprintPreview', 'View the document in Overprint Preview mode', '-'],
  'mod+alt+t': ['window.paragraph', 'Open the Paragraph panel', 'WP-TYPE-A'],
  'mod+alt+x': ['object.makeLivePaint', 'Make Live Paint (when using the Paint Bucket tool)', '-'],
  'mod+alt+y': ['view.pixelPreview', 'View the document in Pixel Preview mode', 'WP-VIEWPORT'],
  'mod+e': ['view.cpuPreview', 'Toggle between GPU and CPU Preview of the document', '-'],
  'mod+f10': ['window.stroke', 'Show/hide Stroke panel', 'WP-STROKE'],
  'mod+f11': ['window.attributes', 'Show/hide Attributes panel', '-'],
  'mod+f8': ['window.info', 'Show/hide Info panel', 'WP-SNAP'],
  'mod+f9': ['window.gradient', 'Show/hide Gradient panel', 'WP-PAINT'],
  'mod+g': ['object.group', 'Group the selected artwork', 'WP-OBJ'],
  'mod+i': ['edit.checkSpelling', 'Check spelling', '-'],
  'mod+k': ['edit.preferences', 'Open the Preferences dialog box', 'WP-PREFS'],
  'mod+p': ['file.print', 'Print', 'WP-EXPORT'],
  'mod+r': ['view.rulers', 'Show/Hide artboard rulers', 'WP-SNAP'],
  "mod+shift+'": ['view.snapToGrid', 'Snap to grid', 'WP-SNAP'],
  'mod+shift+b': ['view.boundingBox', 'Hide bounding box', 'WP-VIEWPORT'],
  'mod+shift+d': ['view.transparencyGrid', 'Show transparency grid', 'WP-VIEWPORT'],
  'mod+shift+e': ['effect.applyLast', 'Apply last effect to the selected object', 'WP-EFFECTS'],
  'mod+shift+f10': ['window.transparency', 'Show/hide Transparency panel', '-'],
  'mod+shift+f11': ['window.symbols', 'Show/hide Symbols panel', 'WP-SYMBOLS'],
  'mod+shift+f8': ['object.editPattern', 'Edit a pattern', 'WP-PAINT'],
  'mod+shift+f9': ['window.pathfinder', 'Show/hide Pathfinder panel', 'WP-PATHFINDER'],
  'mod+shift+g': ['object.ungroup', 'Ungroup the selected artwork', 'WP-OBJ'],
  'mod+shift+h': ['view.artboards', 'Show/Hide artboards', 'WP-ARTBOARD'],
  'mod+shift+i': ['view.perspectiveGrid', 'Show/ hide perspective grid', '-'],
  'mod+shift+k': ['edit.colorSettings', 'Open the Color Settings dialog box', '-'],
  'mod+shift+n': ['file.newFromTemplate', 'Create a document from a template', '-'],
  'mod+shift+o': ['type.createOutlines', 'Create outlines', 'WP-TYPE-B'],
  'mod+shift+t': ['window.tabs', 'Open the Tabs panel', '-'],
  'mod+t': ['window.character', 'Open the Character panel', 'WP-TYPE-A'],
  'mod+y': ['view.outline', 'Toggle between Outline and GPU Preview of the document', 'WP-VIEWPORT'],
  'shift+,': ['paint.colorMode', 'Select color fill mode', 'WP-COLOR'],
  'shift+.': ['paint.gradientMode', 'Select gradient fill mode', 'WP-PAINT'],
  'shift+=': ['tool:addAnchor', 'Add Anchor Point tool', 'WP-PATH'],
  'shift+b': ['tool:blobBrush', 'Blob Brush tool', 'WP-BRUSHV'],
  'shift+d': ['view.drawingMode', 'Switch through drawing modes', '-'],
  'shift+f3': ['window.colorGuide', 'Open Color Guide', 'WP-COLOR'],
  'shift+f5': ['window.graphicStyles', 'Show/hide Graphic Styles panel', 'WP-APPEAR'],
  'shift+f6': ['window.appearance', 'Show/hide Appearance panel', 'WP-APPEAR'],
  'shift+f7': ['window.align', 'Show/hide Align panel', 'WP-TRANSFORM'],
  'shift+f8': ['window.transform', 'Show/hide Transform panel', 'WP-TRANSFORM'],
  'shift+k': ['tool:slice', 'Slice tool', '-'],
  'shift+l': ['tool:livePaintSelection', 'Live Paint Selection tool', '-'],
  'shift+m': ['tool:shapeBuilder', 'Shape Builder Tool', 'WP-SHAPEBUILDER'],
  'shift+n': ['tool:shaper', 'Shaper tool', '-'],
  'shift+o': ['tool:artboard', 'Artboard tool', 'WP-ARTBOARD'],
  'shift+p': ['tool:perspectiveGrid', 'Perspective Grid Tool', '-'],
  'shift+r': ['tool:warp', 'Warp tool', 'WP-LIQUIFY'],
  'shift+s': ['tool:symbolSprayer', 'Symbol Sprayer tool', '-'],
  'shift+t': ['tool:touchType', 'Touch Type tool', '-'],
  'shift+tab': ['view.hidePanelsKeepTools', 'Show/Hide all panels except the Tools panel and Control panel', 'WP-VIEWPORT'],
  'shift+v': ['tool:perspectiveSelection', 'Perspective Selection Tool', '-'],
  'shift+w': ['tool:width', 'Width Tool', 'WP-STROKE'],
  'shift+x': ['paint.swapFillStroke', 'Swap fill and stroke', 'WP-COLOR'],
  tab: ['view.hidePanels', 'Show/Hide all panels', 'WP-VIEWPORT'],
  u: ['tool:mesh', 'Mesh tool', '-'],
  w: ['tool:blend', 'Blend tool', 'WP-BLEND'],
  x: ['paint.toggleFillStroke', 'Toggle between fill and stroke', 'WP-COLOR'],
  y: ['tool:magicWand', 'Magic Wand tool', '-'],
  z: ['tool:zoom', 'Zoom tool', 'WP-VIEWPORT']
}
