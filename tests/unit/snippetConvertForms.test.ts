// convertForms (the paste half of the conversion matrix), conversionNotice,
// acceptsFor (what a host offers, derived from the builders), the slide →
// design flow note, and image addresses checked when slide/design bodies are
// read (isSafeImageSrc; PlexiiDraw's stricter isDrawImageSrc into Draw).

import { describe, expect, it } from 'vitest'
import { conversionNotice, convertForms, convertSnippetBody } from '../../src/shared/snippetConvert'
import { acceptsFor, canConvertInto, probeBodies } from '../../src/shared/snippetConvert/accepts'
import { REASON, nothingUsable } from '../../src/shared/snippetConvert/common'
import { formsOf, type Form } from '../../src/shared/snippetForms'
import { L } from '../../src/shared/snippetForms/lossy'
import { SVG_DATA_PREFIX } from '../../src/shared/snippetForms/picture'
import { SNIPPET_KINDS, type SlideSnippetBody, type SnippetBody, type SnippetHostKind, type SnippetKind } from '../../src/shared/snippets'
import * as F from './snippetConvertFixtures'

const KINDS: SnippetKind[] = ['doc', 'sheet', 'slide', 'design', 'diagram', 'draw', 'widget']

function sources(): Array<[string, SnippetBody]> {
  return [
    ['doc', F.doc()],
    ['sheet', F.sheet()],
    ['slide', F.slide()],
    ['design', F.design()],
    ['diagram', F.diagram()],
    ['draw', F.draw()],
    ['sticky', F.STICKY],
    ['markdown', F.MARKDOWN],
    ['page', F.PAGE],
    ['image', F.IMAGE],
    ['card', F.CARD],
    ['table', F.TABLE]
  ]
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#f00"/></svg>'
const svgForm: Form = { kind: 'svg', value: { svg: SVG, width: 120, height: 80, vector: true, app: 'PlexiiDraw' }, lossy: [] }
const imageForm: Form = { kind: 'image', value: { src: F.PNG, width: 1, height: 1 }, lossy: [] }
const rowsForm: Form = { kind: 'rows', value: { rows: [['a', 'b'], ['1', '2']], header: true }, lossy: [] }
const textForm: Form = { kind: 'text', value: 'First\nSecond', lossy: [] }

describe('convertForms', () => {
  it('lands exactly as convertSnippetBody for every source and destination (paste and insert agree)', () => {
    for (const [name, body] of sources()) {
      for (const to of KINDS) {
        const viaBody = convertSnippetBody(body, to, F.DEPS)
        const viaForms = convertForms(formsOf(body, F.DEPS), to, F.DEPS)
        expect(viaForms, `${name} → ${to}`).toEqual(viaBody)
      }
    }
  })

  it('takes the body from `source` over the native form', () => {
    // Diagram forms, but the source says slide: the diagram's native
    // pass-through is not taken (its native form is not the source), so it
    // lands through the picture form instead.
    const forms = formsOf(F.diagram(), F.DEPS)
    const native = convertForms(forms, 'diagram', F.DEPS)
    if (!native.ok) throw new Error(native.reason)
    expect((native.body as { nodes: Array<{ shape: string }> }).nodes.map((n) => n.shape)).toEqual(['process', 'decision'])
    const r = convertForms(forms, 'diagram', F.DEPS, F.slide())
    if (!r.ok) throw new Error(r.reason)
    expect((r.body as { nodes: Array<{ shape: string }> }).nodes.map((n) => n.shape)).toEqual(['image'])
    const r2 = convertForms([], 'slide', F.DEPS, F.slide())
    expect(r2).toEqual(convertSnippetBody(F.slide(), 'slide', F.DEPS))
  })

  it('a picture from another app (no source body) lands in PlexiiWrite as an image node, said so', () => {
    const r = convertForms([svgForm], 'doc')
    if (!r.ok) throw new Error(r.reason)
    expect(r.body.kind).toBe('doc')
    const node = (r.body as { content: Array<{ type: string; attrs: { src: string; width: number } }> }).content[0]
    expect(node.type).toBe('image')
    expect(node.attrs.src.startsWith(SVG_DATA_PREFIX)).toBe(true)
    expect(node.attrs.width).toBe(120)
    expect(r.lossy).toEqual(['It becomes a picture: edit it in PlexiiDraw.'])
  })

  it('a PNG lands in Deck as an image element', () => {
    const r = convertForms([imageForm], 'slide')
    if (!r.ok) throw new Error(r.reason)
    const el = (r.body as SlideSnippetBody).elements[0] as { type: string; src: string }
    expect(el.type).toBe('image')
    expect(el.src).toBe(F.PNG)
  })

  it('refuses a picture into PlexiiCells and rows into PlexiiDraw with the same reasons a snippet gets', () => {
    expect(convertForms([svgForm], 'sheet')).toEqual({ ok: false, reason: REASON.cellsNoPictures })
    expect(convertForms([imageForm], 'sheet')).toEqual({ ok: false, reason: REASON.cellsNoPictures })
    expect(convertForms([rowsForm], 'draw')).toEqual({ ok: false, reason: REASON.drawNoTables })
  })

  it('rows become a Diagrams table shape; text becomes notes, one per paragraph', () => {
    const t = convertForms([rowsForm], 'diagram')
    if (!t.ok) throw new Error(t.reason)
    const n = (t.body as { nodes: Array<{ shape: string; cells: string[][] }> }).nodes[0]
    expect(n.shape).toBe('table-header')
    expect(n.cells).toEqual([['a', 'b'], ['1', '2']])
    const notes = convertForms([textForm], 'diagram')
    if (!notes.ok) throw new Error(notes.reason)
    expect((notes.body as { nodes: Array<{ label: string }> }).nodes.map((x) => x.label)).toEqual(['First', 'Second'])
    expect(notes.lossy).toEqual([L.eachParagraphNote])
  })

  it('text that is not art lands as words (no source body means no art rule)', () => {
    const r = convertForms([textForm], 'slide')
    expect(r.ok).toBe(true)
  })

  it('nothing usable is refused naming the destination', () => {
    expect(convertForms([], 'doc')).toEqual({ ok: false, reason: nothingUsable('doc') })
    expect(nothingUsable('doc')).toBe('Nothing that was copied is something PlexiiWrite can hold.')
    expect(convertForms([textForm], 'sheet')).toEqual({ ok: false, reason: nothingUsable('sheet') })
  })

  it('is deterministic and never mutates the forms', () => {
    const forms = [svgForm, imageForm, rowsForm, textForm]
    const before = JSON.stringify(forms)
    for (const to of KINDS) {
      const a = JSON.stringify(convertForms(forms, to, F.DEPS))
      const b = JSON.stringify(convertForms(forms, to, F.DEPS))
      expect(a).toBe(b)
    }
    expect(JSON.stringify(forms)).toBe(before)
  })
})

describe('conversionNotice', () => {
  it('is null for a kind landing as itself, the lossy lines when converted, and a plain line when faithful', () => {
    expect(conversionNotice('doc', 'doc', ['x'])).toBeNull()
    expect(conversionNotice('draw', 'doc', ['It becomes a picture: edit it in PlexiiDraw.', 'It becomes a picture: edit it in PlexiiDraw.'])).toBe('It becomes a picture: edit it in PlexiiDraw.')
    expect(conversionNotice('slide', 'design', [])).toBe('Converted from PlexiiDeck for PlexiiDesign.')
    expect(conversionNotice(null, 'doc', [])).toBeNull()
  })
})

describe('acceptsFor: derived from the builders', () => {
  const EXPECTED: Record<SnippetHostKind, SnippetKind[]> = {
    doc: ['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'],
    desk: ['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'],
    sheet: ['doc', 'widget', 'sheet'],
    slide: ['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'],
    design: ['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'],
    diagram: ['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw'],
    draw: ['doc', 'widget', 'slide', 'design', 'diagram', 'draw']
  }

  it('is the matrix the builders produce, with the renderer deps', () => {
    for (const host of Object.keys(EXPECTED) as SnippetHostKind[]) expect(acceptsFor(host, F.DEPS), host).toEqual(EXPECTED[host])
  })

  it('without PlexiiDraw’s SVG writer a drawing has no picture, so only Draw takes it', () => {
    expect(acceptsFor('doc')).not.toContain('draw')
    expect(acceptsFor('draw')).toContain('draw')
  })

  it('agrees with the builders on every pair: offered means some body converts, withheld means every probe is refused', () => {
    for (const to of KINDS) {
      for (const from of SNIPPET_KINDS) {
        const results = probeBodies(from).map((b) => convertSnippetBody(b, to, F.DEPS))
        expect(canConvertInto(from, to, F.DEPS), `${from} → ${to}`).toBe(from === to || results.some((r) => r.ok))
        // A refusal always carries a reason a person can read.
        for (const r of results) if (!r.ok) expect(r.reason.length).toBeGreaterThan(10)
      }
    }
  })

  it('the real fixtures of a withheld kind are refused too (the probes are not hiding a working case)', () => {
    for (const [name, body] of sources()) {
      for (const host of Object.keys(EXPECTED) as SnippetHostKind[]) {
        if (EXPECTED[host].includes(body.kind)) continue
        const to = host === 'desk' ? 'widget' : (host as SnippetKind)
        expect(convertSnippetBody(body, to, F.DEPS).ok, `${name} → ${host}`).toBe(false)
      }
    }
  })
})

describe('slide → design', () => {
  it('says how to make separate text boxes flow when there are two or more', () => {
    const r = convertSnippetBody(F.slide(), 'design', F.DEPS)
    if (!r.ok) throw new Error(r.reason)
    expect(r.lossy).toEqual([]) // one text box: nothing to link
    const two: SlideSnippetBody = {
      kind: 'slide',
      elements: [
        { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 40, z: 0, paragraphs: [{ runs: [{ text: 'One' }] }] },
        { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 40, z: 1, paragraphs: [{ runs: [{ text: 'Two' }] }] }
      ] as never
    }
    const r2 = convertSnippetBody(two, 'design', F.DEPS)
    if (!r2.ok) throw new Error(r2.reason)
    expect(r2.lossy).toEqual(['Text boxes arrive as separate frames; to make the text flow, select them and use Link text frames on the Text tab.'])
  })
})

describe('image addresses are checked when slide and design bodies are read', () => {
  const withImage = (src: string): SlideSnippetBody => ({
    kind: 'slide',
    elements: [
      { id: 's', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 60, z: 0, fill: { type: 'solid', color: '#e0e7ff' } },
      { id: 'i', type: 'image', x: 120, y: 0, w: 60, h: 60, z: 1, src }
    ] as never
  })
  const BAD = 'javascript:alert(1)'
  const HTTPS = 'https://example.test/logo.png'

  it('an unsafe address is left out of the picture, said so', () => {
    const r = convertSnippetBody(withImage(BAD), 'doc', F.DEPS)
    if (!r.ok) throw new Error(r.reason)
    const src = (r.body as { content: Array<{ attrs: { src: string } }> }).content[0].attrs.src
    const svg = new TextDecoder().decode(Uint8Array.from(atob(src.slice(SVG_DATA_PREFIX.length)), (c) => c.charCodeAt(0)))
    expect(svg).not.toContain('javascript')
    expect(r.lossy).toContain(L.unsupportedImage)
  })

  it('an unsafe address is left out of a slide landing in Design, and of a design landing in Deck', () => {
    const d = convertSnippetBody(withImage(BAD), 'design', F.DEPS)
    if (!d.ok) throw new Error(d.reason)
    expect((d.body as { elements: Array<{ type: string }> }).elements.map((e) => e.type)).toEqual(['shape'])
    expect(d.lossy).toContain(L.unsupportedImage)
    const s = convertSnippetBody({ kind: 'design', elements: withImage(BAD).elements }, 'slide', F.DEPS)
    if (!s.ok) throw new Error(s.reason)
    expect((s.body as { elements: Array<{ type: string }> }).elements.map((e) => e.type)).toEqual(['shape'])
    expect(s.lossy).toContain(L.unsupportedImage)
  })

  it('a safe https image is kept by Deck and Design, but left out of PlexiiDraw (embedded bytes only), said so', () => {
    const d = convertSnippetBody(withImage(HTTPS), 'design', F.DEPS)
    if (!d.ok) throw new Error(d.reason)
    expect(d.lossy).not.toContain(L.unsupportedImage)
    expect((d.body as { elements: unknown[] }).elements).toHaveLength(2)
    const draw = convertSnippetBody(withImage(HTTPS), 'draw', F.DEPS)
    if (!draw.ok) throw new Error(draw.reason)
    expect(draw.lossy).toContain(L.unsupportedImage)
    const assets = Object.values((draw.body as { assets: Record<string, { dataUrl: string }> }).assets)
    for (const a of assets) expect(atob(a.dataUrl.split(',')[1] ?? '')).not.toContain(HTTPS)
    // Embedded bytes go into Draw untouched.
    const ok = convertSnippetBody(withImage(F.PNG), 'draw', F.DEPS)
    if (!ok.ok) throw new Error(ok.reason)
    expect(ok.lossy).not.toContain(L.unsupportedImage)
  })

  it('a slide holding only an unsafe image is refused into Design with that reason', () => {
    const only: SlideSnippetBody = { kind: 'slide', elements: [withImage(BAD).elements[1]] }
    expect(convertSnippetBody(only, 'design', F.DEPS)).toEqual({ ok: false, reason: L.unsupportedImage })
  })
})
