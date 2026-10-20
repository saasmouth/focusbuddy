// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { SEGMENT_APPS } from '../../src/renderer/src/lib/segmentApps'
import { PLEXI_PRODUCTS } from '../../src/shared/plexiSuite'

// The suite's own names (owner, 4.3.34): PlexiiWrite, PlexiiCells, PlexiiDeck,
// PlexiiCall, PlexiiChat, PlexiiVault, PlexiiBrain, PlexiiAssist, PlexiiDesk.
//
// Why they moved: Docs / Sheets / Slides / Meet, each coloured blue / green /
// orange, read as a copy of Google's line-up, which is what a confusion claim
// is built from. So the names AND the colours changed. Meetings are PlexiiCall,
// not PlexiiRooms, because Rooms (the rooms that hold desks) already exists.
//
// Display names only. Keys, view kinds, entitlement capabilities, URLs and
// document types (docs/sheets/slides/meet, doc/sheet/slides) are unchanged, so
// no stored document, licence or link breaks. This scans what a person can read
// (string literals and JSX text, as plexiiSpelling.test.ts does) for the
// retired names, so they cannot drift back.

const SRC = join(__dirname, '..', '..', 'src')

// The retired product names, in either spelling.
const RETIRED = /\bPlexii? ?(Docs|Sheets|Slides|Meet)\b/

// History keeps the names each release shipped with; the SQL schema's comments
// are stored DDL, not something a person reads.
const SKIP = new Set(['renderer/src/lib/changelog.ts', 'main/db/schema.ts', 'main/db/migrations.ts'])

function uiTexts(src: string, tsx: boolean): string[] {
  const sf = ts.createSourceFile('x', src, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) out.push(n.getText().replace(/\s+/g, ' '))
    else if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      n.kind === ts.SyntaxKind.TemplateHead ||
      n.kind === ts.SyntaxKind.TemplateMiddle ||
      n.kind === ts.SyntaxKind.TemplateTail
    )
      out.push((n as ts.LiteralLikeNode).text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const isImportPath = (t: string): boolean => /^(\.{1,2}\/|@[\w-]*\/)[^\s]*$/.test(t)

function walk(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

const app = (key: string): { label: string; tone?: string } =>
  (SEGMENT_APPS.office as readonly { key: string; label: string; tone?: string }[]).find((a) => a.key === key)!

describe('the office app names', () => {
  it('no UI text in src/ uses a retired name (PlexiiDocs, PlexiiSheets, PlexiiSlides, PlexiiMeet)', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/')
      if (SKIP.has(rel)) continue
      for (const t of uiTexts(readFileSync(file, 'utf8'), file.endsWith('.tsx')))
        if (RETIRED.test(t) && !isImportPath(t)) offenders.push(`${rel}: ${t.trim().slice(0, 140)}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('the side menu names each app by its own name, under the unchanged key', () => {
    expect(app('docs').label).toBe('PlexiiWrite')
    expect(app('sheets').label).toBe('PlexiiCells')
    expect(app('slides').label).toBe('PlexiiDeck')
    expect(app('meet').label).toBe('PlexiiCall')
    expect(app('chat').label).toBe('PlexiiChat')
    expect(app('vault').label).toBe('PlexiiVault')
    const brain = (SEGMENT_APPS.plexibrain as readonly { key: string; label: string }[]).map((a) => a.label)
    expect(brain).toEqual(expect.arrayContaining(['PlexiiBrain Home', 'Ask PlexiiBrain', 'PlexiiBrain Map']))
  })

  it('the "not on your plan" copy and the product catalogue use the same names', () => {
    // entitlementReason.ts and viewCapability.ts import stores that need a window, so read them as text.
    const ent = readFileSync(join(SRC, 'renderer/src/lib/entitlementReason.ts'), 'utf8')
    for (const l of ["doc: 'PlexiiWrite',", "sheet: 'PlexiiCells',", "slides: 'PlexiiDeck',"]) expect(ent).toContain(l)
    const caps = readFileSync(join(SRC, 'renderer/src/lib/viewCapability.ts'), 'utf8')
    expect(caps).toContain("vault: { cap: 'password_vault', label: 'PlexiiVault' }")
    expect(caps).toContain("messages: { cap: 'chat', label: 'PlexiiChat' }")
    expect(caps).toContain("meetings: { cap: 'meet', label: 'PlexiiCall' }")
    const names = PLEXI_PRODUCTS.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['PlexiiWrite', 'PlexiiCells', 'PlexiiDeck', 'PlexiiCall', 'PlexiiChat', 'PlexiiVault', 'PlexiiBrain']))
    // The keys stay: entitlements and saved launches name them.
    expect(PLEXI_PRODUCTS.map((p) => p.key)).toEqual(expect.arrayContaining(['plexidocs', 'pleximeet']))
  })

  it('Write, Cells and Deck are not coloured blue, green and orange', () => {
    const googleish = /(sky|blue|green|emerald|orange|amber|yellow)-/
    for (const key of ['docs', 'sheets', 'slides']) expect(app(key).tone, key).not.toMatch(googleish)
    const shell = readFileSync(join(SRC, 'renderer/src/components/office/PlexiOfficeShell.tsx'), 'utf8')
    for (const name of ['PlexiiWrite', 'PlexiiCells', 'PlexiiDeck']) {
      const row = shell.split('\n').find((l) => l.includes(`label: '${name}'`))!
      expect(row, name).toBeTruthy()
      expect(row, name).not.toMatch(googleish)
    }
  })

  it('the scanner catches a retired name and lets the new ones through', () => {
    const sample = `const a = 'Open PlexiiDocs'; const b = <h1>PlexiSheets</h1>; const c = 'PlexiiWrite'
      const d = 'Google Docs'; const e = 'pleximeet'; const g = 'A Plexii Meet room'; // PlexiiSlides in a comment is fine`
    const found = uiTexts(sample, true).filter((t) => RETIRED.test(t))
    expect(found.sort()).toEqual(['A Plexii Meet room', 'Open PlexiiDocs', 'PlexiSheets'])
  })
})
