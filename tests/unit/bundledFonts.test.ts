// @vitest-environment node
// Fonts ship with the app (4.3.34). PlexiiOffice used to load Google Fonts on
// every launch, and the font pickers fetched families from fonts.googleapis.com
// on demand. These hold the line: no remote font load anywhere in the renderer,
// no CSP that would allow one, and every family a picker offers is bundled.

import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const R = join(__dirname, '..', '..', 'src', 'renderer')
const read = (p: string): string => readFileSync(join(R, p), 'utf8')
const stripComments = (s: string): string =>
  s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css|html)$/.test(n)) out.push(p)
  }
  return out
}

describe('no remote fonts', () => {
  it('no renderer code, stylesheet or page references a font CDN', () => {
    const hits = walk(R).filter((p) =>
      /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net/.test(stripComments(readFileSync(p, 'utf8')))
    )
    expect(hits).toEqual([])
  })

  it('the window’s CSP allows fonts only from the app itself', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read('index.html'))?.[1] ?? ''
    expect(csp).toContain("font-src 'self' data:")
    expect(csp).not.toMatch(/googleapis|gstatic/)
  })

  // PlexiiOffice used to be a second window with its own page and entry
  // (plexioffice.html + src/officeApp.tsx), held here to the same bundled type
  // stack. It was retired in 4.3.41; the Office area renders inside index.html.
  // A second page would need its own CSP and font imports, so it must not come
  // back unnoticed.
  it('there is one renderer page, and the retired PlexiiOffice entry stays gone', () => {
    expect(existsSync(join(R, 'plexioffice.html'))).toBe(false)
    expect(existsSync(join(R, 'src', 'officeApp.tsx'))).toBe(false)
  })

  it('the desk imports the bundled type stack', () => {
    const entry = read('src/main.tsx')
    for (const pkg of [
      'material-symbols/outlined.css',
      '@fontsource-variable/inter',
      '@fontsource-variable/lexend',
      '@fontsource/jetbrains-mono',
      '@fontsource/patrick-hand',
      '@fontsource/atkinson-hyperlegible',
      './assets/fonts/bundled-fonts.css'
    ]) {
      expect(entry).toContain(`import '${pkg}'`)
    }
  })
})

describe('every family a picker offers is bundled', () => {
  const lib = read('src/lib/googleFonts.ts')
  const list = /export const GOOGLE_FONTS: string\[\] = \[([\s\S]*?)\]/.exec(lib)?.[1] ?? ''
  const offered = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1])
  const css = read('src/assets/fonts/bundled-fonts.css')
  const declared = new Set([...css.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]))
  const typeStack = new Set(['Inter', 'JetBrains Mono', 'Lexend', 'Atkinson Hyperlegible', 'Patrick Hand'])

  it('offers a real list', () => {
    expect(offered.length).toBeGreaterThan(25)
  })

  it('each one is either the bundled type stack or declared in bundled-fonts.css', () => {
    const missing = offered.filter((f) => !typeStack.has(f) && !declared.has(f))
    expect(missing).toEqual([])
  })

  it('every @font-face points at a file that exists', () => {
    const files = [...css.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map((m) => m[1])
    expect(files.length).toBeGreaterThan(50)
    for (const f of files) expect(existsSync(join(R, 'src', 'assets', 'fonts', 'files', f))).toBe(true)
  })

  it('the licences travel with the fonts and name every bundled family', () => {
    const lic = read('src/assets/fonts/FONT-LICENSES.txt')
    expect(lic).toMatch(/SIL OPEN FONT LICENSE/i)
    expect(lic).toMatch(/Apache License/)
    for (const id of new Set([...css.matchAll(/url\(\.\/files\/([a-z0-9-]+?)-latin-/g)].map((m) => m[1]))) {
      expect(lic).toContain(`[${id}]`)
    }
    expect(lib).toContain("import '../assets/fonts/FONT-LICENSES.txt?url'")
  })

  it('loadGoogleFont never injects a stylesheet', () => {
    const body = /export function loadGoogleFont[\s\S]*?\n\}/.exec(lib)?.[0] ?? ''
    expect(body).not.toMatch(/createElement|appendChild|href/)
  })
})
