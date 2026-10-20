// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { CHANGELOG } from '../../src/renderer/src/lib/changelog'
import { productDisplayName, detectOfficeBuild, detectPreviewBuild } from '../../src/main/appMode'

// The brand (owner, 4.3.33): "We are Plexii not Plexi, including when
// concatenated with other sub-app identifiers such as PlexiiApps." So every
// name a person reads is PlexiiDesk, PlexiiOffice, PlexiiDocs, PLEXIIDESK.
//
// This scans what a person can read — string literals and JSX text in src/ —
// for "Plexi" + a capital letter, and fails on any that is not on the list of
// identifiers that deliberately keep the old spelling. Code identifiers
// (PlexiOfficeShell, PlexiChart) and comments are not scanned: nobody sees
// them, and renaming them would only churn.
//
// The identities that stay are pinned at the bottom: changing one of THOSE is
// the expensive mistake, not leaving it alone.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

const OLD = /\bPlexi(?=[A-Z])|\bPLEXI(?=[A-HJ-Z])/

/**
 * Strings that keep the old spelling, by file, each for a reason that outlives
 * the rename. A NEW old-spelling string anywhere else fails.
 */
const ALLOWED: Record<string, { texts: string[]; why: string }> = {
  'main/index.ts': {
    texts: ['PlexiOffice', 'PlexiDesk 4 Preview', 'PlexiDesk3Preview'],
    why:
      "app.setName('PlexiOffice' | 'PlexiDesk 4 Preview') names the safeStorage keychain item " +
      '("PlexiOffice Safe Storage"); a new spelling orphans every stored key. PlexiOffice and ' +
      'PlexiDesk3Preview are also the userData directory names, which hold real workspaces.'
  },
  'main/updaterInstall.ts': {
    texts: ['PlexiDesk-'],
    why: 'Release artifact prefix. The update feeds and the site download buttons name these files on R2.'
  },
  'main/autoUpdate.ts': { texts: ['PlexiDesk-Updater'], why: 'User-Agent token, not shown; servers may key on it.' },
  'main/calendar/push.ts': { texts: ['PlexiDesk Calendar Sync'], why: 'User-Agent sent to calendar servers.' },
  'main/calendar/sync.ts': { texts: ['PlexiDesk Calendar Sync'], why: 'User-Agent sent to calendar servers.' },
  'main/ai/agentInputs.ts': {
    texts: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PlexiDeskDeskAgent/1.0'
    ],
    why: 'User-Agent sent to the sites a desk agent reads.'
  },
  'shared/ics.ts': { texts: ['PRODID:-//PlexiDesk//Meeting//EN'], why: 'iCalendar producer id, a machine field.' }
}

/** Whole files that are not UI text. */
const ALLOWED_FILES: Record<string, string> = {
  // SQL DDL whose comments mention the product. Changing the text changes
  // nothing a person sees and rewrites the stored schema text.
  'main/db/schema.ts': 'SQL',
  'main/db/migrations.ts': 'SQL',
  // History. Entries before 4.3.33 keep the spelling they shipped with; the
  // 4.3.33 entry is checked separately below.
  'renderer/src/lib/changelog.ts': 'history'
}

/**
 * Every string literal, template-literal piece and JSX text node, read with
 * the TypeScript parser itself. A hand tokenizer was tried first and missed
 * JSX text beside a {expression} or holding an entity (&apos;s), which is
 * exactly where UI copy lives.
 */
function uiTexts(src: string, tsx: boolean, js = false): string[] {
  const kind = js ? ts.ScriptKind.JS : tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile('x', src, ts.ScriptTarget.Latest, true, kind)
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

/** A module specifier, not text: './views/PlexiMeetView', '@shared/plexiSuite'. */
const isImportPath = (t: string): boolean => /^(\.{1,2}\/|@[\w-]*\/)[^\s]*$/.test(t)

function walk(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

function offendersIn(rel: string, src: string, tsx: boolean): string[] {
  const allowed = ALLOWED[rel]?.texts ?? []
  return uiTexts(src, tsx)
    .filter((t) => OLD.test(t) && !isImportPath(t) && !allowed.includes(t))
    .map((t) => `${rel}: ${t.trim().slice(0, 140)}`)
}

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('the Plexii spelling', () => {
  it('no UI text in src/ says Plexi<Capital> outside the kept identifiers', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/')
      if (ALLOWED_FILES[rel]) continue
      const src = readFileSync(file, 'utf8')
      // CHEAP CHECK FIRST, as in officeAppNames. offendersIn parses the file
      // with the TypeScript compiler; over the whole renderer that is
      // seconds, and it was tipping this guard past its budget whenever the
      // machine was also running a build or another suite — a flake that
      // varied run to run and said nothing about the code.
      //
      // A file with no `Plexi<Capital>` anywhere cannot have one in its UI
      // text, so parsing it can only confirm what the substring said. Every
      // file that could offend is still parsed exactly as before.
      if (!OLD.test(src)) continue
      offenders.push(...offendersIn(rel, src, file.endsWith('.tsx')))
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('every allow-listed string is still there (a stale entry would hide a new one)', () => {
    for (const [rel, { texts }] of Object.entries(ALLOWED)) {
      const found = uiTexts(read(join('src', rel)), rel.endsWith('.tsx'))
      for (const t of texts) expect(found, `${rel} no longer contains ${JSON.stringify(t)}`).toContain(t)
    }
  })

  it('the window titles, the MCP extension and the agent profiles use it', () => {
    for (const p of ['index.html', 'plexioffice.html', 'src/renderer/index.html', 'src/renderer/plexioffice.html']) {
      expect(read(p), p).not.toMatch(/<title>[^<]*\bPlexi[A-Z]/)
    }
    const bridge = read('tools/plexii-mcp-bridge/server/index.js')
    expect(uiTexts(bridge, false, true).filter((t) => OLD.test(t))).toEqual([])
    const manifest = read('tools/plexii-mcp-bridge/manifest.json')
    expect(manifest).not.toMatch(OLD)
    expect(read('tools/build-agent-profiles.cjs')).toContain("replace(/\\bPlexi(?=[A-Z])/g, 'Plexii')")
  })

  it('the 4.3.33 What’s New speaks it', () => {
    const entry = CHANGELOG.find((e) => e.version === '4.3.33')!
    expect(entry).toBeTruthy()
    const text = [entry.title, entry.summary ?? '', ...entry.highlights, ...(entry.links ?? []).map((l) => l.label)].join('\n')
    // "PlexiDesk" may appear once, quoted, as the OLD name a person may still
    // have in Applications. Nowhere else.
    const stray = text.replace(/the older PlexiDesk/g, '').match(new RegExp(OLD.source, 'g'))
    expect(stray, text).toBeNull()
    expect(text).toMatch(/PlexiiDesk/)
  })

  it('the scanner itself catches the old spelling and lets the right forms through', () => {
    const sample = `import X from './views/PlexiMeetView'
      const a = 'Back to PlexiDesk'; const b = 'Back to PlexiiDesk'; const c = 'plexidesk-tile'
      const d = <h1>PlexiBrain</h1>; const e = <h1>PlexiiBrain</h1>; const f = \`\${n} in PlexiOffice\`
      const g = 'PLEXIDESK'; const h = 'PLEXIIDESK' // PlexiDesk in a comment is fine
      const i = <p>Update to “{kind}”. Update PlexiDesk to see it.</p>
      const j = <p>Using PlexiDesk&apos;s fallback</p>
      class PlexiChartView {}`
    const found = uiTexts(sample, true).filter((t) => OLD.test(t) && !isImportPath(t))
    expect(found.map((t) => t.trim()).sort()).toEqual(
      ['Back to PlexiDesk', 'PLEXIDESK', 'PlexiBrain', 'in PlexiOffice', '”. Update PlexiDesk to see it.', 'Using PlexiDesk&apos;s fallback'].sort()
    )
  })
})

// ── What deliberately did NOT change ────────────────────────────────────────
//
// productName is the displayed name and moved. The identities below did not,
// and each would cost users something real if it did.

describe('the identities the rename must not touch', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const builder = require('../../electron-builder.cjs') as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const office = require('../../electron-builder.plexioffice.cjs') as Record<string, unknown>
  const pkg = JSON.parse(read('package.json')) as { name: string; productName?: string }

  it('shows PlexiiDesk / PlexiiOffice as the app name', () => {
    expect(builder.productName).toBe('PlexiiDesk')
    expect(office.productName).toBe('PlexiiOffice')
    expect((builder.dmg as { title: string }).title).toBe('PlexiiDesk ${version}')
    expect((builder.nsis as { shortcutName: string }).shortcutName).toBe('PlexiiDesk')
    expect(read('electron-builder.plexi4preview.yml')).toMatch(/^productName: PlexiiDesk 4 Preview$/m)
    expect(productDisplayName({ office: false, preview: false })).toBe('PlexiiDesk')
    expect(productDisplayName({ office: true, preview: false })).toBe('PlexiiOffice')
    expect(productDisplayName({ office: false, preview: true })).toBe('PlexiiDesk 4 Preview')
  })

  it('keeps the bundle ids (TCC grants, LaunchServices, safeStorage)', () => {
    expect(builder.appId).toBe('app.haptyx.desktop')
    expect(office.appId).toBe('app.plexioffice.desktop')
  })

  it('keeps the artifact filenames the update feeds and the site download buttons name', () => {
    expect(builder.artifactName).toBe('PlexiDesk-${version}-${os}-${arch}.${ext}')
    expect(office.artifactName).toBe('PlexiOffice-${version}-${os}-${arch}.${ext}')
    // The mac one-click updater fetches this zip itself and copies whatever
    // .app is inside over the running bundle, so the bundle's own name can move.
    expect(read('src/main/updaterInstall.ts')).toContain('`PlexiDesk-${version}-mac-${arch}.zip`')
    expect(read('src/main/autoUpdate.ts')).toContain("readdirSync(unzipDir).find((n) => n.endsWith('.app'))")
    expect(read('scripts/release-mac.sh')).toContain('PREFIX="PlexiDesk-${VERSION}"')
    expect(read('scripts/release-mac.sh')).toContain('LEGACY_PREFIX="Haptyx-${VERSION}"')
  })

  it('keeps app.getName(): package.json name, and the setName strings that name the keychain items', () => {
    expect(pkg.name).toBe('plexii')
    expect(pkg.productName).toBeUndefined()
    const index = read('src/main/index.ts')
    expect(index).toContain("app.setName('PlexiOffice')")
    expect(index).toContain("app.setName('PlexiDesk 4 Preview')")
    expect(index).toContain("join(app.getPath('appData'), 'PlexiOffice')")
    expect(index).toContain("join(app.getPath('appData'), 'PlexiDesk3Preview')")
    expect(read('src/main/userDataMigration.ts')).toContain("export const CURRENT_DIR_NAME = 'plexii'")
  })

  it('still recognises office and preview bundles by path in EITHER spelling', () => {
    // A preview or office build that is not recognised opens the PRODUCTION
    // userData. An in-place update keeps the old directory with the new
    // executable inside, so mixed paths are real.
    const office = [
      '/Applications/PlexiiOffice.app/Contents/MacOS/PlexiiOffice',
      '/Applications/PlexiOffice.app/Contents/MacOS/PlexiiOffice',
      'C:\\Users\\me\\AppData\\Local\\Programs\\PlexiiOffice\\PlexiiOffice.exe'
    ]
    for (const execPath of office) expect(detectOfficeBuild({ execPath, appName: 'plexii' }), execPath).toBe(true)
    const preview = [
      '/Applications/PlexiiDesk 4 Preview.app/Contents/MacOS/PlexiiDesk 4 Preview',
      '/Applications/PlexiDesk 4 Preview.app/Contents/MacOS/PlexiiDesk 4 Preview'
    ]
    for (const execPath of preview) expect(detectPreviewBuild({ execPath, appName: 'plexii' }), execPath).toBe(true)
    for (const execPath of [
      '/Applications/PlexiiDesk.app/Contents/MacOS/PlexiiDesk',
      '/Applications/PlexiDesk.app/Contents/MacOS/PlexiiDesk',
      '/Applications/PlexiiDesk 4.3.33.app/Contents/MacOS/PlexiiDesk'
    ]) {
      expect(detectOfficeBuild({ execPath, appName: 'plexii' }), execPath).toBe(false)
      expect(detectPreviewBuild({ execPath, appName: 'plexii' }), execPath).toBe(false)
    }
  })
})
