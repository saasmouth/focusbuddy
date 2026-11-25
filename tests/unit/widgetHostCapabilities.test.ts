// @vitest-environment node
// What the widget host tells PlexiiLite it can make and show: manifest.json,
// written by the build beside index.html (1a's contract, plexii-lite
// docs/plans/widget-files.md "The widget host contract"):
//   { protocol: 1, pin, kinds: [...], documents: { doc: { ext, label }, ... } }
// The pin and the file list are added by haptyx-web build-widget-host.mjs; the
// build itself writes what the host can do, from the same lists it loads.
import { describe, it, expect } from 'vitest'
import { hostManifest, HOST_WIDGET_KINDS, HOST_DOCUMENTS } from '../../src/web/widgetHost/capabilities'
import { HOST_WIDGET_LOADERS, HOST_DOCUMENT_TYPES } from '../../src/web/widgetHost/kinds'
import { widgetFileType } from '../../src/shared/widgetFiles'

describe('the widget host manifest', () => {
  it('protocol 1, the 19 widget kinds and the six document types', () => {
    const m = hostManifest()
    expect(m.protocol).toBe(1)
    expect(m.kinds).toHaveLength(19)
    expect(Object.keys(m.documents)).toEqual(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])
    expect(m.documents.map).toEqual({ ext: '.plexii-map', label: 'Diagram' })
    expect(m.documents.draw).toEqual({ ext: '.plexii-draw', label: 'Artwork' })
  })

  it('lists exactly what the host loads: no kind it cannot draw, none missing', () => {
    expect([...HOST_WIDGET_KINDS].sort()).toEqual(Object.keys(HOST_WIDGET_LOADERS).sort())
    expect(Object.keys(HOST_DOCUMENTS)).toEqual([...HOST_DOCUMENT_TYPES])
  })

  it('every widget kind is one Plexii can file, with its file type', () => {
    for (const k of HOST_WIDGET_KINDS) expect(widgetFileType(k)?.ext, k).toMatch(/^\.plexii-/)
  })
})
