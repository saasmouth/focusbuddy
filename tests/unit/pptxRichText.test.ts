// Theme colour resolution and rich positioned text on .pptx import.
//
// Before these, slide text was flattened to a title string plus bullet strings
// (losing position, bold, italic, colour, size and alignment), and any colour
// expressed as a theme reference — which is most colour in a real deck — was
// dropped because only literal srgbClr was read.
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parsePptx } from '../../src/main/slidesIo'
import type { SlideTextElement, SlideShapeElement } from '@shared/types'

const EMU_W = 12192000
const EMU_H = 6858000

const THEME = `<a:theme xmlns:a="a"><a:themeElements><a:clrScheme name="x">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
</a:clrScheme></a:themeElements></a:theme>`

function deck(spTree: string, withTheme = true): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': strToU8(`<p:presentation><p:sldSz cx="${EMU_W}" cy="${EMU_H}"/></p:presentation>`),
    'ppt/slides/slide1.xml': strToU8(`<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${spTree}</p:spTree></p:cSld></p:sld>`)
  }
  if (withTheme) files['ppt/theme/theme1.xml'] = strToU8(THEME)
  return zipSync(files)
}

/** A non-placeholder text shape at a known position. */
function textBox(body: string, x = 0, y = 0, cx = 1000, cy = 500): string {
  return `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody>${body}</p:txBody></p:sp>`
}

// Only the boxes this importer positions. migrateSlidesBody also emits text
// elements (ids "mig-*") for the slide's title and bullets; those are a
// different thing and not what these tests are about.
const textOf = (els: unknown[] | undefined): SlideTextElement[] =>
  ((els ?? []) as SlideTextElement[]).filter((e) => e.type === 'text' && e.id.startsWith('txt-'))
const shapeOf = (els: unknown[] | undefined): SlideShapeElement[] =>
  ((els ?? []) as SlideShapeElement[]).filter((e) => e.type === 'shape')

describe('pptx theme colours', () => {
  it('resolves a scheme colour on a shape fill', async () => {
    const r = await parsePptx(deck(
      `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>` +
      `<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>`
    ), 'd.pptx')
    expect(shapeOf(r.body!.slides[0].elements)[0].fill).toEqual({ type: 'solid', color: '#4472c4' })
  })

  it('resolves tx1/bg1 aliases onto dk1/lt1', async () => {
    const r = await parsePptx(deck(
      `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>` +
      `<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:spPr></p:sp>`
    ), 'd.pptx')
    expect(shapeOf(r.body!.slides[0].elements)[0].fill).toEqual({ type: 'solid', color: '#ffffff' })
  })

  it('applies a lumMod tint instead of importing flat accent', async () => {
    const r = await parsePptx(deck(
      `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/>` +
      `<a:solidFill><a:schemeClr val="dk1"><a:lumOff val="50000"/></a:schemeClr></a:solidFill></p:spPr></p:sp>`
    ), 'd.pptx')
    // black lifted by 50% luminance is mid grey, not black
    expect(shapeOf(r.body!.slides[0].elements)[0].fill).toEqual({ type: 'solid', color: '#808080' })
  })

  it('drops an unresolvable colour rather than guessing one', async () => {
    const r = await parsePptx(deck(
      `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/>` +
      `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>`, false
    ), 'd.pptx')
    expect(shapeOf(r.body!.slides[0].elements)[0].fill).toBeUndefined()
  })
})

describe('pptx rich text', () => {
  it('keeps run formatting instead of flattening to a string', async () => {
    const r = await parsePptx(deck(textBox(
      `<a:p><a:r><a:rPr b="1" sz="2400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Bold red</a:t></a:r>` +
      `<a:r><a:rPr i="1" u="sng"/><a:t> and italic</a:t></a:r></a:p>`
    )), 'd.pptx')
    const runs = textOf(r.body!.slides[0].elements)[0].paragraphs[0].runs
    expect(runs[0]).toMatchObject({ text: 'Bold red', bold: true, color: '#ff0000' })
    expect(runs[0].fontSize).toBeGreaterThan(0)
    expect(runs[1]).toMatchObject({ text: ' and italic', italic: true, underline: true })
    expect(runs[1].bold).toBeUndefined()
  })

  it('positions the box from its own transform', async () => {
    const r = await parsePptx(deck(textBox('<a:p><a:r><a:t>x</a:t></a:r></a:p>',
      EMU_W / 4, EMU_H / 4, EMU_W / 2, EMU_H / 2)), 'd.pptx')
    const t = textOf(r.body!.slides[0].elements)[0]
    expect([t.x, t.y, t.w, t.h]).toEqual([320, 180, 640, 360])
  })

  it('reads alignment, indent level and list style', async () => {
    const r = await parsePptx(deck(textBox(
      `<a:p><a:pPr algn="ctr" lvl="2"/><a:buChar char="-"/><a:r><a:t>a</a:t></a:r></a:p>` +
      `<a:p><a:pPr algn="r"/><a:buNone/><a:r><a:t>b</a:t></a:r></a:p>`
    )), 'd.pptx')
    const ps = textOf(r.body!.slides[0].elements)[0].paragraphs
    expect(ps[0]).toMatchObject({ align: 'center', bulletLevel: 2, listStyle: 'bullet' })
    expect(ps[1]).toMatchObject({ align: 'right', listStyle: 'none' })
  })

  it('resolves a theme colour on a run', async () => {
    const r = await parsePptx(deck(textBox(
      `<a:p><a:r><a:rPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:rPr><a:t>x</a:t></a:r></a:p>`
    )), 'd.pptx')
    expect(textOf(r.body!.slides[0].elements)[0].paragraphs[0].runs[0].color).toBe('#ed7d31')
  })

  it('converts font size using the deck real width, not a fixed assumption', async () => {
    // 13.333in wide mapped to 1280 units = 96 units/in, so 18pt = 24 units.
    const r = await parsePptx(deck(textBox(
      `<a:p><a:r><a:rPr sz="1800"/><a:t>x</a:t></a:r></a:p>`
    )), 'd.pptx')
    expect(textOf(r.body!.slides[0].elements)[0].paragraphs[0].runs[0].fontSize).toBe(24)
  })

  it('does not duplicate placeholder text, which is already the bullets', async () => {
    const ph = `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:p><a:r><a:t>In the bullets</a:t></a:r></a:p></p:txBody></p:sp>`
    const r = await parsePptx(deck(ph), 'd.pptx')
    expect(textOf(r.body!.slides[0].elements)).toHaveLength(0)
    expect(JSON.stringify(r.body!.slides[0])).toContain('In the bullets')
  })

  it('does not import the same sentence twice', async () => {
    // Title and bullets are read from placeholders only. Before that, a free
    // text box's words were read BOTH as a slide bullet and as this positioned
    // box, so every imported sentence appeared on the slide twice.
    const r = await parsePptx(deck(textBox('<a:p><a:r><a:t>Only once please</a:t></a:r></a:p>')), 'd.pptx')
    const whole = JSON.stringify(r.body!.slides[0])
    expect(whole.split('Only once please').length - 1).toBe(1)
    expect(textOf(r.body!.slides[0].elements)).toHaveLength(1)
  })

  it('still reads title and bullets from real placeholders', async () => {
    const ph = (type: string, t: string): string =>
      `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`
    const r = await parsePptx(deck(ph('title', 'The title') + ph('body', 'A bullet')), 'd.pptx')
    expect(r.body!.slides[0].title).toBe('The title')
    expect(JSON.stringify(r.body!.slides[0])).toContain('A bullet')
  })

  it('skips an empty text body rather than emitting a blank box', async () => {
    const r = await parsePptx(deck(textBox('<a:p><a:r><a:t></a:t></a:r></a:p>')), 'd.pptx')
    expect(textOf(r.body!.slides[0].elements)).toHaveLength(0)
  })
})
