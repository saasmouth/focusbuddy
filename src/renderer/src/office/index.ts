// @plexi/office — the public surface of the Office suite (doc / sheet / slides
// editors + the cloud-document sync they depend on). This barrel is the boundary
// for the lean PlexiOffice split: everything OUTSIDE the office code (the desk
// canvas, the views router, and the coming standalone PlexiOffice app shell)
// imports the editors and office helpers from here, never via deep paths. When
// this becomes a real package, only the alias target moves — call sites don't.
//
// Office-internal modules still import each other directly; this is for crossing
// the boundary inward.

export { default as DocEditor } from '../components/documents/DocEditor'
export { default as SheetEditor } from '../components/documents/SheetEditor'
export { default as SlidesEditor } from '../components/documents/SlidesEditor'
// MapEditor is PlexiDiagrams' surface; the module name predates the rename.
export { default as MapEditor } from '../components/documents/MapEditor'
export { default as DesignEditor } from '../components/documents/DesignEditor'
export { default as DrawStudio } from '../components/documents/DrawStudio'

// Doc helpers used across the boundary (importing a Word file into a doc body,
// building the shared Tiptap extension set).
export { wrapDocBody } from '../components/documents/editor/headingStyles'
export { buildDocExtensions } from '../components/documents/editor/extensions'
export { htmlToDoc } from '../lib/docHtml'

// Cloud document sync — the integration contract that lets PlexiDesk and the
// standalone PlexiOffice app share the same documents.
export {
  listCloudDocs,
  syncCloudDocs,
  getCloudDoc,
  putCloudDoc,
  deleteCloudDoc,
  type CloudDocument,
  type CloudDocType
} from '../lib/cloudDocsClient'
export {
  cloudDocsEnabled,
  setCloudDocsEnabled,
  cloudSyncActive,
  pullCloudDocs,
  pushCloudDoc,
  pushCloudDelete
} from '../lib/cloudDocsSync'

// Office document data shapes.
export type {
  DocType,
  FbDocument,
  DocumentMeta,
  DocBody,
  SheetBody,
  SheetBodyV2,
  SlidesBody,
  MapBody,
  MapNode,
  MapEdge,
  MapShape
} from '@shared/types'
export type { DrawBody, DrawLayer, DrawObject, DrawPaint } from '@shared/draw'
