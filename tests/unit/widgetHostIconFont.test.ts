// @vitest-environment node
// The widget host's icon font is Material Symbols pinned to the one style the
// host draws (scripts/widget-host-icon-font.py): 0.5 MB instead of 3.9 MB, every
// icon kept. It is generated, so it must never drift from the package the app
// uses: when material-symbols changes, this fails until the font is remade.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const manifest = JSON.parse(readFileSync('src/web/widgetHost/fonts/icon-font.json', 'utf8'))

describe('the widget host icon font', () => {
  it('was made from the material-symbols the app ships now (else: run scripts/widget-host-icon-font.py)', () => {
    expect(manifest.sourceSha256).toBe(sha('node_modules/material-symbols/material-symbols-outlined.woff2'))
    expect(manifest.sourceVersion).toBe(JSON.parse(readFileSync('node_modules/material-symbols/package.json', 'utf8')).version)
  })

  it('is the file the manifest describes, with every icon and the fill axis', () => {
    expect(sha('src/web/widgetHost/fonts/material-symbols-outlined.woff2')).toBe(manifest.sha256)
    expect(manifest.keptAxes).toEqual(['FILL'])
    expect(manifest.glyphs).toBeGreaterThan(6000)
    expect(manifest.bytes).toBeLessThan(700 * 1024)
  })

  it('pins exactly the style the app draws by default', () => {
    const css = readFileSync('src/renderer/src/styles/globals.css', 'utf8')
    expect(css).toContain(`'wght' var(--fb-icon-wght, ${manifest.pinned.wght})`)
    expect(css).toMatch(new RegExp(`'GRAD' ${manifest.pinned.GRAD}\\b`))
    expect(css).toMatch(new RegExp(`'opsz' ${manifest.pinned.opsz}\\b`))
  })

  it('the host page uses it, not the full font', () => {
    const main = readFileSync('src/web/widgetHost/main.tsx', 'utf8')
    expect(main).not.toContain("material-symbols/outlined.css")
    expect(main).toContain("import './icons.css'")
    expect(readFileSync('src/web/widgetHost/icons.css', 'utf8')).toContain("url('./fonts/material-symbols-outlined.woff2')")
  })
})
