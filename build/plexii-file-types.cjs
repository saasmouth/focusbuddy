// The .plexii-* files the packaged app opens from Finder and Explorer (F3,
// 2026-11-20). electron-builder.cjs reads this; it can't read TypeScript, so the
// list is written out here, and tests/unit/plexiiFileAssociations.test.ts fails
// the moment it differs from src/shared/widgetFiles.ts (WIDGET_FILE_TYPES,
// DOCUMENT_FILE_TYPES) or src/shared/plexiiFileTypes.ts (the type identifiers,
// names and ProgIDs).
//
// Every type Plexii imports, and no other: 25 work widgets, 6 Office documents.
// The embed tools (a calendar, a browser, a PDF placed in a document) are never
// imported, so never claimed.
//
// macOS: Plexii DECLARES each type as its own (UTExportedTypeDeclarations,
// com.plexiidesk.*): plain JSON with its one extension, so Quick Look shows the
// text. And it opens each one as its owner (CFBundleDocumentTypes), by type
// identifier. PlexiiLite opens the same files and IMPORTS these declarations,
// never exports them. With no icon given, macOS draws each document's icon from
// the app's.
//
// Windows: the NSIS installer registers each extension under its own ProgID.
//
// Type identifiers and ProgIDs are stable forever once shipped.
'use strict'

/** typeId and ext exactly as the shared tables have them; label is the type's name there. */
const PLEXII_FILE_TYPES = [
  // Work widgets (WIDGET_FILE_TYPES)
  { typeId: 'plexii.widget.table', ext: '.plexii-table', label: 'Table' },
  { typeId: 'plexii.widget.task-list', ext: '.plexii-tasks', label: 'Task list' },
  { typeId: 'plexii.widget.mindmap', ext: '.plexii-mindmap', label: 'Mind map' },
  { typeId: 'plexii.widget.sticky', ext: '.plexii-sticky', label: 'Sticky' },
  { typeId: 'plexii.widget.note', ext: '.plexii-note', label: 'Note' },
  { typeId: 'plexii.widget.markdown', ext: '.plexii-markdown', label: 'Markdown note' },
  { typeId: 'plexii.widget.page', ext: '.plexii-page', label: 'Page' },
  { typeId: 'plexii.widget.card', ext: '.plexii-card', label: 'Card' },
  { typeId: 'plexii.widget.chart', ext: '.plexii-chart', label: 'Chart' },
  { typeId: 'plexii.widget.stat-card', ext: '.plexii-stat', label: 'Stat card' },
  { typeId: 'plexii.widget.metrics', ext: '.plexii-metrics', label: 'Metrics' },
  { typeId: 'plexii.widget.field', ext: '.plexii-field', label: 'Field' },
  { typeId: 'plexii.widget.timer', ext: '.plexii-timer', label: 'Timer' },
  { typeId: 'plexii.widget.calculator', ext: '.plexii-calc', label: 'Calculator' },
  { typeId: 'plexii.widget.color', ext: '.plexii-color', label: 'Colour swatch' },
  { typeId: 'plexii.widget.voice-note', ext: '.plexii-voice', label: 'Voice note' },
  { typeId: 'plexii.widget.diagram', ext: '.plexii-diagram', label: 'Diagram' },
  { typeId: 'plexii.widget.scratchpad', ext: '.plexii-sketch', label: 'Sketch' },
  { typeId: 'plexii.widget.shape', ext: '.plexii-shape', label: 'Shape' },
  { typeId: 'plexii.widget.custom-block', ext: '.plexii-block', label: 'Form block' },
  { typeId: 'plexii.widget.custom', ext: '.plexii-custom', label: 'Custom work widget' },
  { typeId: 'plexii.widget.image-gen', ext: '.plexii-image', label: 'AI image' },
  { typeId: 'plexii.widget.gallery', ext: '.plexii-gallery', label: 'Gallery' },
  { typeId: 'plexii.widget.location', ext: '.plexii-place', label: 'Place' },
  { typeId: 'plexii.widget.speeddeck', ext: '.plexii-speeddeck', label: 'SpeedDeck' },
  // Office documents (DOCUMENT_FILE_TYPES)
  { typeId: 'plexii.document.doc', ext: '.plexii-doc', label: 'Document' },
  { typeId: 'plexii.document.sheet', ext: '.plexii-sheet', label: 'Spreadsheet' },
  { typeId: 'plexii.document.slides', ext: '.plexii-slides', label: 'Slides' },
  { typeId: 'plexii.document.map', ext: '.plexii-map', label: 'Diagram' },
  { typeId: 'plexii.document.design', ext: '.plexii-design', label: 'Design' },
  { typeId: 'plexii.document.draw', ext: '.plexii-draw', label: 'Artwork' }
]

const bare = (typeId) => typeId.replace(/^plexii\./, '')
const uti = (t) => `com.plexiidesk.${bare(t.typeId)}`
const description = (t) => `Plexii ${t.label}`
const progId = (t) => `Plexii.${bare(t.typeId).replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase())}`

/** mac.extendInfo.UTExportedTypeDeclarations */
function macExportedTypes() {
  return PLEXII_FILE_TYPES.map((t) => ({
    UTTypeIdentifier: uti(t),
    UTTypeDescription: description(t),
    UTTypeConformsTo: ['public.json'],
    UTTypeTagSpecification: { 'public.filename-extension': [t.ext.slice(1)] }
  }))
}

/** mac.extendInfo.CFBundleDocumentTypes: Plexii brings in a copy and never writes the file back, so a Viewer. */
function macDocumentTypes() {
  return PLEXII_FILE_TYPES.map((t) => ({
    CFBundleTypeName: description(t),
    CFBundleTypeRole: 'Viewer',
    LSHandlerRank: 'Owner',
    LSItemContentTypes: [uti(t)]
  }))
}

/** win.fileAssociations (NSIS). Windows only: on macOS electron-builder would add extension-only types from these. */
function winFileAssociations() {
  return PLEXII_FILE_TYPES.map((t) => ({ ext: t.ext.slice(1), name: progId(t), description: description(t) }))
}

module.exports = { PLEXII_FILE_TYPES, macExportedTypes, macDocumentTypes, winFileAssociations }
