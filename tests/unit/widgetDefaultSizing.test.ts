import { describe, it, expect } from 'vitest'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'
import { GROW_MAX_HEIGHT, DEFAULT_GROW_MAX } from '../../src/renderer/src/lib/useGrowToFit'
import { naturalItemWidth } from '../../src/renderer/src/lib/deskColumns'
import type { Widget } from '../../src/shared/types'

const entry = (kind: string) => WIDGET_CATALOG.find((e) => e.kind === kind)

describe('browser starts just above where sites go to a tablet layout', () => {
  it('defaults to 1060 x 600', () => {
    const web = entry('webview')
    expect(web?.defaultWidth).toBe(1060)
    expect(web?.defaultHeight).toBe(600)
  })

  it('does not let that width distort a desk column', () => {
    // Column layout clamps to a legible maximum, so a 1920-wide default must
    // not drag a column out with it.
    const w = { kind: 'webview', width: 1920, height: 1080 } as unknown as Widget
    expect(naturalItemWidth(w)).toBeLessThanOrEqual(760)
  })
})

describe('grow-to-fit ceilings', () => {
  it('gives every kind that grows a real ceiling', () => {
    for (const [kind, max] of Object.entries(GROW_MAX_HEIGHT)) {
      expect(max, `${kind} needs a positive ceiling`).toBeGreaterThan(0)
      // A ceiling below the kind's own opening size would shrink it on sight.
      const e = entry(kind)
      if (e) expect(max, `${kind} ceiling is under its default height`).toBeGreaterThanOrEqual(e.defaultHeight)
    }
  })

  it('keeps ceilings bounded so one widget cannot swallow the desk', () => {
    for (const max of Object.values(GROW_MAX_HEIGHT)) expect(max).toBeLessThanOrEqual(1200)
    expect(DEFAULT_GROW_MAX).toBeLessThanOrEqual(1200)
  })
})

describe('every catalog entry opens at a usable size', () => {
  it('has a positive default width and height', () => {
    for (const e of WIDGET_CATALOG) {
      expect(e.defaultWidth, `${e.kind} width`).toBeGreaterThan(0)
      expect(e.defaultHeight, `${e.kind} height`).toBeGreaterThan(0)
    }
  })
})
