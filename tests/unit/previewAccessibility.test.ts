import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Hidden desk data was massively overexposed through the accessibility tree:
// opening "All desks" handed screen readers and automation the full contents of
// every desk in the collection -- note bodies, document text, URLs, prompts --
// including desks scrolled off screen and never looked at.
//
// The cause is that thumbnails render real widget content at small scale. They
// are pictures of objects, not the objects, and the cards around them already
// carry the title, object count and status. So the previews are marked
// decorative, and the surfaces that use them for navigation keep their own
// accessible names.

const C = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components')
const read = (f: string): string => readFileSync(join(C, f), 'utf8')

describe('preview surfaces are decorative to assistive technology', () => {
  it('WidgetPreview hides its whole subtree', () => {
    const src = read('WidgetPreview.tsx')
    const impl = src.indexOf('function WidgetPreviewImpl')
    expect(impl, 'the preview implementation has been renamed').toBeGreaterThan(-1)
    expect(src.slice(impl, impl + 400)).toContain('aria-hidden="true"')
    // The switch must stay behind the wrapper, or new branches leak again.
    expect(src).toContain('function renderPreview(')
    // The export is that implementation memoised -- nothing may be exported
    // that bypasses the aria-hidden wrapper checked above.
    expect(src).toMatch(/const WidgetPreview = memo\(WidgetPreviewImpl\)/)
    expect(src).toContain('export default WidgetPreview')
  })

  it('DeskMiniature hides both its rendered and empty states', () => {
    const src = read('DeskMiniature.tsx')
    const svg = src.slice(src.indexOf('<svg'))
    expect(svg.slice(0, 320)).toContain('aria-hidden="true"')
    const empty = src.slice(src.indexOf('Empty desk') - 300, src.indexOf('Empty desk'))
    expect(empty).toContain('aria-hidden="true"')
  })

  it('the canvas minimap keeps a name of its own once its contents are hidden', () => {
    // Hiding the previews inside must not leave an unnamed graphic behind.
    expect(read('CanvasMinimapFAB.tsx')).toContain('aria-label="Canvas overview"')
  })

  it('focus dock entries keep a name of their own', () => {
    expect(read('WidgetFocusDock.tsx')).toContain("title={w.title || entry?.label || 'Widget'}")
  })
})
