// The .plexii-* files Plexii opens from Finder and Explorer (F3, 2026-11-20).
//
// Every type Plexii imports -- the work widgets that can be files (25) and the
// Office documents (6) -- and how the operating system knows each one: on macOS
// a type identifier (UTI) Plexii declares as its own, on Windows a ProgID. The
// packaged app's Info.plist and installer get these from
// build/plexii-file-types.cjs (electron-builder.cjs can't read TypeScript);
// tests/unit/plexiiFileAssociations.test.ts fails the moment the two differ.
//
// The embed tools (a calendar, a browser, a PDF placed in a document) are left
// out on purpose: Plexii never imports one, so it never claims one.
//
// Type identifiers and ProgIDs are stable forever once shipped: Finder,
// Explorer and PlexiiLite (which IMPORTS these declarations) remember them.
import { DOCUMENT_FILE_TYPES, WIDGET_FILE_TYPES, type WidgetFileType } from './widgetFiles'

/** Every .plexii-* type Plexii imports: work widgets first, then documents. */
export function importablePlexiiFileTypes(): WidgetFileType[] {
  return [...Object.values(WIDGET_FILE_TYPES), ...Object.values(DOCUMENT_FILE_TYPES)] as WidgetFileType[]
}

/** True for a file name ending in an extension Plexii imports (never an embed tool's, such as .plexii-calendar). */
export function isImportablePlexiiFileName(name: string): boolean {
  const m = /\.plexii-[a-z-]+$/i.exec(name.trim())
  if (!m) return false
  const ext = m[0].toLowerCase()
  return importablePlexiiFileTypes().some((t) => t.ext === ext)
}

/** The macOS type identifier: plexii.widget.table → com.plexiidesk.widget.table. */
export function plexiiFileUti(typeId: string): string {
  return `com.plexiidesk.${typeId.replace(/^plexii\./, '')}`
}

/** What Finder and Explorer call the type ("Plexii Table", "Plexii Spreadsheet"). */
export function plexiiFileDescription(t: Pick<WidgetFileType, 'label'>): string {
  return `Plexii ${t.label}`
}

/** The Windows ProgID: plexii.widget.task-list → Plexii.widget.taskList (letters, digits and periods only). */
export function plexiiFileProgId(typeId: string): string {
  return `Plexii.${typeId.replace(/^plexii\./, '').replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())}`
}

/** A file main read for the window to bring in: its text, or what went wrong reading it. */
export type OpenedPlexiiFile = { id: string; name: string; at: number } & ({ text: string } | { error: string })
