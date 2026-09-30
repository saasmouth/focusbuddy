// @vitest-environment node
//
// A new widget kind must not be able to fail silently.
//
// Adding a kind means touching several files that have no compile-time link to
// each other. Miss one and there is no error — the widget just does nothing:
//
//   renderWidget      ended `default: return null`, so an unhandled kind drew a
//                     blank rectangle on the desk and nothing said why.
//   widgetText        has a deliberate fallback for chrome kinds, so a new kind
//                     that misses it is not blank — worse, it is INVISIBLE to
//                     Plexii, which reads every widget through this one path.
//                     The assistant then answers "there is nothing on this desk
//                     about that" while the answer is sitting on the desk.
//   widgetCatalog     a kind absent here cannot be added by the user at all.
//
// So this reads the sources and fails when the lists diverge. A comment saying
// "keep in step with X" is a bug with a delay on it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const RENDERER = 'src/renderer/src/components/widgets/renderWidget.tsx'
const WIDGET_TEXT = 'src/shared/widgetText.ts'
const CATALOG = 'src/renderer/src/lib/widgetCatalog.ts'

/** The WidgetKind union, read out of the type itself rather than duplicated. */
function widgetKinds(): Set<string> {
  const src = read('src/shared/types.ts')
  const start = src.indexOf('export type WidgetKind =')
  expect(start, 'WidgetKind union not found — did the type move or get renamed?').toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n\n', start))
  return new Set([...body.matchAll(/\|\s*'([a-z0-9-]+)'/g)].map((m) => m[1]))
}

const caseLabels = (rel: string): Set<string> =>
  new Set([...read(rel).matchAll(/case\s*'([a-z0-9-]+)'/g)].map((m) => m[1]))

describe('widget kind coverage', () => {
  const kinds = widgetKinds()

  // Vacuity guard. Every assertion below is of the form "nothing is missing",
  // which an empty or broken parse satisfies trivially — so the parse itself is
  // checked first. This exists because a test that silently stops testing is
  // indistinguishable from a passing one.
  it('parses a plausible set of kinds out of the union', () => {
    expect(kinds.size).toBeGreaterThan(50)
    for (const known of ['task-list', 'inbox', 'sticky', 'table', 'mail-thread']) {
      expect(kinds, `'${known}' missing — the WidgetKind parse is broken`).toContain(known)
    }
  })

  it('renders every kind on a desk', () => {
    const handled = caseLabels(RENDERER)
    expect([...kinds].filter((k) => !handled.has(k)), `${RENDERER} has no case for these`).toEqual(
      []
    )
  })

  it('does not fall back to a blank widget', () => {
    // The whole reason the gap above went unnoticed. An unknown kind must say so
    // on the desk, because desks sync between devices and an older install will
    // legitimately meet a kind it has never heard of.
    const src = read(RENDERER)
    const dflt = src.slice(src.lastIndexOf('default:'))
    expect(dflt, `${RENDERER} default branch renders nothing`).not.toMatch(/return null/)
    expect(dflt).toMatch(/UnknownKindWidget/)
  })

  // Exposure to the assistant. These four hold no content of their own and are
  // documented as such at widgetText's default branch; anything ELSE reaching
  // that branch is a kind Plexii cannot read, which is a bug every time.
  const CHROME_ONLY = ['local-app-launcher', 'minimap', 'section', 'shape']

  it('exposes every content-bearing kind to the assistant', () => {
    const resolved = caseLabels(WIDGET_TEXT)
    const fellThrough = [...kinds].filter((k) => !resolved.has(k)).sort()
    expect(
      fellThrough,
      `these kinds hit widgetText's generic fallback, so Plexii cannot read their contents. ` +
        `Add a case in ${WIDGET_TEXT}, or add the kind to CHROME_ONLY here if it genuinely ` +
        `holds no content.`
    ).toEqual(CHROME_ONLY)
  })

  it('lets the user add every kind that is meant to be addable', () => {
    const offered = new Set(
      [...read(CATALOG).matchAll(/kind:\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
    )
    // meeting-record is created by the meeting flow, never placed by hand.
    expect([...kinds].filter((k) => !offered.has(k)).sort()).toEqual(['meeting-record'])
  })
})
