// Double-clicking a .plexii-* file opens Plexii (F3, 2026-11-20).
//
// What the packaged app tells macOS and Windows about the files it opens comes
// from electron-builder.cjs, which can't read the shared TypeScript tables. So
// this test holds the two equal: every type Plexii imports (25 work widgets, 6
// Office documents) and nothing else, each under its own type identifier.
import { describe, expect, it } from 'vitest'
import { DOCUMENT_FILE_TYPES, EMBED_TOOL_FILE_TYPES, WIDGET_FILE_TYPES, isPlexiiFileName, parsePlexiiFile, type WidgetFileType } from '../../src/shared/widgetFiles'
import { importablePlexiiFileTypes, isImportablePlexiiFileName, plexiiFileDescription, plexiiFileProgId, plexiiFileUti } from '../../src/shared/plexiiFileTypes'

type DocType = { CFBundleTypeName: string; CFBundleTypeRole: string; LSHandlerRank: string; LSItemContentTypes: string[]; CFBundleTypeExtensions?: unknown }
type UtDecl = { UTTypeIdentifier: string; UTTypeDescription: string; UTTypeConformsTo: string[]; UTTypeTagSpecification: Record<string, string[]> }
type WinAssoc = { ext: string; name: string; description: string }
type Config = {
  fileAssociations?: unknown
  mac: { extendInfo: { CFBundleDocumentTypes: DocType[]; UTExportedTypeDeclarations: UtDecl[]; UTImportedTypeDeclarations?: unknown }; fileAssociations?: unknown }
  win: { fileAssociations: WinAssoc[] }
}

async function config(): Promise<Config> {
  const mod = (await import('../../electron-builder.cjs')) as { default?: unknown }
  const raw = (mod.default ?? mod) as unknown
  return (typeof raw === 'function' ? (raw as () => unknown)() : raw) as Config
}

const importable = (): WidgetFileType[] => [...Object.values(WIDGET_FILE_TYPES), ...Object.values(DOCUMENT_FILE_TYPES)] as WidgetFileType[]
const sorted = (xs: string[]): string[] => [...xs].sort()

describe('the .plexii-* types Plexii opens', () => {
  it('are exactly the 25 work widget and 6 document types it imports', () => {
    const types = importablePlexiiFileTypes()
    expect(types).toHaveLength(31)
    expect(sorted(types.map((t) => t.typeId))).toEqual(sorted(importable().map((t) => t.typeId)))
    // An embed tool (a calendar, a browser) is never imported, so never claimed.
    for (const t of Object.values(EMBED_TOOL_FILE_TYPES)) expect(types.map((x) => x.ext)).not.toContain(t!.ext)
  })

  it('each has its own type identifier under com.plexiidesk, stable from its type id', () => {
    expect(plexiiFileUti('plexii.widget.table')).toBe('com.plexiidesk.widget.table')
    expect(plexiiFileUti('plexii.document.sheet')).toBe('com.plexiidesk.document.sheet')
    expect(plexiiFileUti('plexii.widget.voice-note')).toBe('com.plexiidesk.widget.voice-note')
    const utis = importablePlexiiFileTypes().map((t) => plexiiFileUti(t.typeId))
    expect(new Set(utis).size).toBe(31)
    // Apple: a type identifier is ASCII letters, digits, hyphens and periods.
    for (const u of utis) expect(u).toMatch(/^[A-Za-z0-9.-]+$/)
  })

  it('names itself as Finder and Explorer show it', () => {
    expect(plexiiFileDescription(WIDGET_FILE_TYPES.table!)).toBe('Plexii Table')
    expect(plexiiFileDescription(DOCUMENT_FILE_TYPES.sheet)).toBe('Plexii Spreadsheet')
  })
})

describe('what the packaged app tells macOS', () => {
  it('declares every type as its own (exported), each one plain JSON with its one extension', async () => {
    const decls = (await config()).mac.extendInfo.UTExportedTypeDeclarations
    expect(decls).toHaveLength(31)
    for (const t of importable()) {
      const d = decls.find((x) => x.UTTypeIdentifier === plexiiFileUti(t.typeId))
      expect(d, t.typeId).toEqual({
        UTTypeIdentifier: plexiiFileUti(t.typeId),
        UTTypeDescription: plexiiFileDescription(t),
        UTTypeConformsTo: ['public.json'],
        UTTypeTagSpecification: { 'public.filename-extension': [t.ext.slice(1)] }
      })
    }
  })

  it('opens every type as their owner, by type identifier (never by extension alone)', async () => {
    const docs = (await config()).mac.extendInfo.CFBundleDocumentTypes
    expect(docs).toHaveLength(31)
    for (const t of importable()) {
      const d = docs.find((x) => x.LSItemContentTypes.includes(plexiiFileUti(t.typeId)))
      expect(d, t.typeId).toEqual({
        CFBundleTypeName: plexiiFileDescription(t),
        // Plexii brings in a copy and never writes the file back: a viewer of it.
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Owner',
        LSItemContentTypes: [plexiiFileUti(t.typeId)]
      })
    }
  })

  it('has no extension-only document types: electron-builder would add those from fileAssociations', async () => {
    const cfg = await config()
    expect(cfg.fileAssociations).toBeUndefined()
    expect(cfg.mac.fileAssociations).toBeUndefined()
    // Plexii owns these types; it imports none (PlexiiLite imports Plexii's).
    expect(cfg.mac.extendInfo.UTImportedTypeDeclarations).toBeUndefined()
  })
})

describe('what the Windows installer registers', () => {
  it('every extension, each under a valid ProgID of its own', async () => {
    const assoc = (await config()).win.fileAssociations
    expect(sorted(assoc.map((a) => `.${a.ext}`))).toEqual(sorted(importable().map((t) => t.ext)))
    expect(new Set(assoc.map((a) => a.name)).size).toBe(31)
    for (const a of assoc) {
      // A ProgID: letters, digits and periods, 39 characters at most, not starting with a digit.
      expect(a.name, a.ext).toMatch(/^[A-Za-z][A-Za-z0-9.]{0,38}$/)
      expect(a.name.startsWith('Plexii.')).toBe(true)
      const t = importable().find((x) => x.ext === `.${a.ext}`)!
      expect(a.description).toBe(plexiiFileDescription(t))
      expect(a.name).toBe(plexiiFileProgId(t.typeId))
    }
    expect(assoc.find((a) => a.ext === 'plexii-tasks')!.name).toBe('Plexii.widget.taskList')
  })
})

describe('the example files', () => {
  it('every file name Plexii claims is one it can import', () => {
    for (const t of importablePlexiiFileTypes()) {
      expect(isPlexiiFileName(`Example${t.ext}`), t.ext).toBe(true)
      expect(isImportablePlexiiFileName(`Example${t.ext.toUpperCase()}`), t.ext).toBe(true)
    }
    for (const t of Object.values(EMBED_TOOL_FILE_TYPES)) expect(isImportablePlexiiFileName(`Example${t!.ext}`), t!.ext).toBe(false)
    expect(isImportablePlexiiFileName('notes.txt')).toBe(false)
    expect(parsePlexiiFile('{}')).toHaveProperty('error')
  })
})
