// @vitest-environment node
// No office File menu may act on the documents store's `active` document.
//
// They did, in all five office apps: Move to trash ran remove(active.id), Make
// a copy took active.body, Version history and Start a meeting used active.id
// (with `?? ''` when nothing was open). A desk widget holds its document in
// local state, so its menu acted on whatever Documents last had open: shipped in
// public 4.3.33. Hosts now bind DocumentOps by id (editor/documentOps.ts).
//
// This pins it at the source, for all five office menu bars (Deck and Diagrams:
// d8; Write and Cells: ec; Design: f0).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const EDITOR = join(process.cwd(), 'src/renderer/src/components/documents/editor')
// Code only: comments that quote the old bug (`active?.id ?? ''`) are history, not code.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const read = (f: string): string => stripComments(readFileSync(join(EDITOR, f), 'utf8'))

const MENU_BARS = ['SlidesMenuBar.tsx', 'DrawMenuBar.tsx', 'DocMenuBar.tsx', 'SheetMenuBar.tsx', 'DesignMenuBar.tsx']

describe('office File menus act on the document the host binds, never the store’s active one', () => {
  it.each(MENU_BARS)('%s does not read the documents store', (f) => {
    const src = read(f)
    expect(src).not.toMatch(/useDocumentsStore/)
    expect(src).not.toMatch(/\bactive\??\.id\b/)
    expect(src, 'a meeting must never fall back to an empty id').not.toMatch(/\?\?\s*''/)
    // Two host-bound shapes, both fine. Most bars take the DocumentOps the host
    // bound and call them. PlexiiWrite and PlexiiCells go one better: their
    // hosts build the DocumentCommands (one object, so the menu's ⌘P hint and
    // the key matcher share it) and pass those in, so the menu bar never sees
    // the ops at all. What this pins either way is that the id never comes from
    // the store — which the three assertions above are what really enforce.
    expect(src, 'document actions come from the host, not the store').toMatch(
      /from '\.\/documentOps'|DocumentCommands/
    )
  })

  it('createDocumentOps itself never reads `active` and never uses the id-less rename', () => {
    const src = read('documentOps.ts')
    expect(src).not.toMatch(/\.active\b/)
    expect(src).not.toMatch(/getState\(\)\.rename\(/)
    expect(src).toMatch(/renameById\(id,/)
    expect(src).toMatch(/remove\(id\)/)
  })

  it('the store’s rename(title) delegates to renameById, so no caller renames by implication', () => {
    const store = readFileSync(join(process.cwd(), 'src/renderer/src/stores/documents.ts'), 'utf8')
    const body = store.slice(store.indexOf('  rename: async (title) => {'), store.indexOf('  renameById: async'))
    expect(body).toMatch(/renameById\(a\.id, title\)/)
    expect(body).not.toMatch(/documents\.update/)
  })
})
