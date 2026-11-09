// A file widget is fitted to its picture's shape only while nobody has sized it
// (lib/fileWidgetFit.ts, FileWidget's auto-size): the size every place that makes
// one gives it. A chosen size -- a resize, a room brought in from PlexiiLite as it
// was laid out -- is kept on every mount; before, each mount undid it.
import { describe, expect, it } from 'vitest'
import { fitsPictureOnMount } from '../../src/renderer/src/lib/fileWidgetFit'
import { catalogFor } from '../../src/renderer/src/lib/widgetCatalog'

describe('fitting a picture to its widget', () => {
  it('a widget at a drop\'s size is fitted', () => {
    const d = catalogFor('file')!
    expect(fitsPictureOnMount({ width: d.defaultWidth, height: d.defaultHeight })).toBe(true)
  })
  it('a size somebody chose is kept', () => {
    expect(fitsPictureOnMount({ width: 340, height: 260 })).toBe(false)
    expect(fitsPictureOnMount({ width: 320, height: 241 })).toBe(false)
  })
})
