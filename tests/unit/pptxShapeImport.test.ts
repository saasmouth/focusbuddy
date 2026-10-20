// Autoshape import from .pptx.
//
// Before this, parsePptx read text, notes, images, tables and charts, but every
// <p:sp> carrying <a:prstGeom> was dropped: a deck of boxes and circles opened
// as a deck of bullet points. These cover the shapes that map, the fills and
// borders that come with them, and the ones deliberately NOT mapped.
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parsePptx } from '../../src/main/slidesIo'
import type { SlideShapeElement } from '@shared/types'

const EMU_W = 12192000
const EMU_H = 6858000

/** One <p:sp> with a preset geometry, a transform, and whatever spPr extras. */
function sp(prst: string, x: number, y: number, cx: number, cy: number, extra = '', ph = false): string {
  return `<p:sp>${ph ? '<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' : ''}<p:spPr>` +
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${extra}</p:spPr></p:sp>`
}

/** A minimal but structurally real .pptx holding one slide of the given shapes. */
function deck(shapesXml: string): Uint8Array {
  const slide =
    `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${shapesXml}</p:spTree></p:cSld></p:sld>`
  return zipSync({
    'ppt/presentation.xml': strToU8(`<p:presentation><p:sldSz cx="${EMU_W}" cy="${EMU_H}"/></p:presentation>`),
    'ppt/slides/slide1.xml': strToU8(slide)
  })
}

const shapesOf = (els: unknown[] | undefined): SlideShapeElement[] =>
  ((els ?? []) as SlideShapeElement[]).filter((e) => e.type === 'shape')

describe('pptx autoshape import', () => {
  it('maps the preset families that genuinely correspond', async () => {
    const r = await parsePptx(deck(
      sp('rect', 0, 0, EMU_W / 2, EMU_H / 2) +
      sp('ellipse', 0, 0, 100, 100) +
      sp('roundRect', 0, 0, 100, 100) +
      sp('triangle', 0, 0, 100, 100)
    ), 'd.pptx')
    expect(r.ok).toBe(true)
    expect(shapesOf(r.body!.slides[0].elements).map((s) => s.shape))
      .toEqual(['rect', 'ellipse', 'roundRect', 'triangle'])
  })

  it('converts EMU to logical coordinates', async () => {
    // Half the slide, at the quarter point, should land at half/quarter of ours.
    const r = await parsePptx(deck(sp('rect', EMU_W / 4, EMU_H / 4, EMU_W / 2, EMU_H / 2)), 'd.pptx')
    const s = shapesOf(r.body!.slides[0].elements)[0]
    expect(s.w).toBe(640)   // half of 1280
    expect(s.h).toBe(360)   // half of 720
    expect(s.x).toBe(320)
    expect(s.y).toBe(180)
  })

  it('reads solid fill and a dashed border', async () => {
    const r = await parsePptx(deck(sp('rect', 0, 0, 100, 100,
      '<a:solidFill><a:srgbClr val="FF8800"/></a:solidFill>' +
      '<a:ln w="25400"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:prstDash val="dash"/></a:ln>'
    )), 'd.pptx')
    const s = shapesOf(r.body!.slides[0].elements)[0]
    expect(s.fill).toEqual({ type: 'solid', color: '#ff8800' })
    expect(s.border).toEqual({ color: '#112233', width: 2, style: 'dashed' })
  })

  it('reads a gradient as start and end colours', async () => {
    const r = await parsePptx(deck(sp('rect', 0, 0, 100, 100,
      '<a:gradFill><a:gsLst><a:gs><a:srgbClr val="000000"/></a:gs><a:gs><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst></a:gradFill>'
    )), 'd.pptx')
    const s = shapesOf(r.body!.slides[0].elements)[0]
    expect(s.fill).toEqual({ type: 'gradient', color: '#000000', color2: '#ffffff' })
  })

  it('does NOT square off geometry it cannot represent, and says how many', async () => {
    const r = await parsePptx(deck(
      sp('star5', 0, 0, 100, 100) + sp('rightArrow', 0, 0, 100, 100) + sp('rect', 0, 0, 100, 100)
    ), 'd.pptx')
    // A flowchart whose arrows silently became boxes is worse than one honestly
    // missing them.
    expect(shapesOf(r.body!.slides[0].elements).map((s) => s.shape)).toEqual(['rect'])
    expect(r.skippedShapes).toBe(2)
  })

  it('skips placeholders, whose text is already the title and bullets', async () => {
    const r = await parsePptx(deck(sp('rect', 0, 0, 100, 100, '', true)), 'd.pptx')
    expect(shapesOf(r.body!.slides[0].elements)).toHaveLength(0)
  })

  it('skips a shape with no transform rather than guessing a position', async () => {
    const noXfrm = '<p:sp><p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>'
    const r = await parsePptx(deck(noXfrm), 'd.pptx')
    expect(shapesOf(r.body!.slides[0].elements)).toHaveLength(0)
  })

  it('leaves skippedShapes absent when everything mapped', async () => {
    const r = await parsePptx(deck(sp('rect', 0, 0, 100, 100)), 'd.pptx')
    expect(r.skippedShapes).toBeUndefined()
  })
})
