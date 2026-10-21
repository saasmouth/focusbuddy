import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'

// Owner report (4.3.40): "Full view opens, but the widget's content and layout
// isn't shown, just a black modal with arrow navigation." Full view renders the
// card body through renderWidgetInline, which returned null for every kind
// without an inline variant (Tasks, Focus, Calendar, Inbox, Drive, …).
//
// Importing the renderer pulls in every editor (the @office alias and more),
// so this reads the switch itself: which kinds reach a bare `return null`, and
// what the default branch does. tests/e2e/fullViewBody.spec.ts checks the
// rendered result in the app.

const src = readFileSync(join(__dirname, '../../src/renderer/src/lib/renderWidgetInline.tsx'), 'utf8')
const body = src.slice(src.indexOf('export function renderWidgetInline'))
const sw = body.slice(0, body.indexOf('\n}\n'))

/** Kinds whose case group ends in `return null`. */
function nullKinds(): string[] {
  const out: string[] = []
  let pending: string[] = []
  for (const line of sw.split('\n')) {
    const c = /^\s*case '([^']+)':/.exec(line)
    if (c) { pending.push(c[1]!); continue }
    if (/^\s*\/\//.test(line) || line.trim() === '') continue
    if (/^\s*return null\b/.test(line)) out.push(...pending)
    if (/^\s*(return|default)/.test(line)) pending = []
  }
  return out
}

describe('Full view has a body for every work widget a desk can hold', () => {
  it('the default branch renders the canvas component, embedded, instead of nothing', () => {
    const def = sw.slice(sw.indexOf('default:'))
    expect(def).toMatch(/return renderEmbedded\(w\)/)
    expect(src).toContain('<WidgetSurfaceContext.Provider value="embedded">{renderWidget(w)}')
  })

  it('only the retired minimap and section containers render nothing', () => {
    expect(nullKinds().sort()).toEqual(['minimap', 'section'])
  })

  it('every catalog kind other than those is either a case or reaches the default', () => {
    const blank = new Set(nullKinds())
    const kinds = WIDGET_CATALOG.map((e) => e.kind)
    for (const k of ['task-list', 'attention', 'calendar', 'inbox', 'drive', 'contacts', 'metrics', 'gallery', 'stat-card', 'image-gen', 'location-map', 'custom']) {
      expect(kinds, k).toContain(k)
      expect(blank.has(k), k).toBe(false)
    }
  })
})
