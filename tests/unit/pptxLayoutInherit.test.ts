// Layout and master inheritance on .pptx import.
//
// A slide's title and body placeholders usually carry no <a:xfrm>: their
// position lives in the slide layout, and failing that the master. Before this,
// they landed wherever our defaults put them, so an imported slide was
// re-laid-out as a generic one instead of keeping its composition.
//
// The resolver is tested through that live path on purpose. Non-placeholder
// shapes are not covered here because they inherit nothing: they either declare
// their own transform or are skipped, since guessing would move artwork.
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parsePptx } from '../../src/main/slidesIo'
import type { SlideTextElement } from '@shared/types'

const EMU_W = 12192000
const EMU_H = 6858000

/** A placeholder declaring a box, as a layout or master writes it. */
const phSp = (attrs: string, x: number, y: number, cx: number, cy: number): string =>
  `<p:sp><p:nvSpPr><p:nvPr><p:ph ${attrs}/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr></p:sp>`

/** A title placeholder with NO transform of its own, as a real slide writes it. */
const titleSp = (t: string): string =>
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`

const relsTo = (target: string): string =>
  `<Relationships><Relationship Id="rId1" Target="${target}"/></Relationships>`

function deck(opts: { slide: string; layout?: string; master?: string }): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': strToU8(`<p:presentation><p:sldSz cx="${EMU_W}" cy="${EMU_H}"/></p:presentation>`),
    'ppt/slides/slide1.xml': strToU8(
      `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${opts.slide}</p:spTree></p:cSld></p:sld>`),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(relsTo('../slideLayouts/slideLayout1.xml'))
  }
  if (opts.layout !== undefined) {
    files['ppt/slideLayouts/slideLayout1.xml'] = strToU8(
      `<p:sldLayout xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${opts.layout}</p:spTree></p:cSld></p:sldLayout>`)
    files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = strToU8(relsTo('../slideMasters/slideMaster1.xml'))
  }
  if (opts.master !== undefined) {
    files['ppt/slideMasters/slideMaster1.xml'] = strToU8(
      `<p:sldMaster xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${opts.master}</p:spTree></p:cSld></p:sldMaster>`)
  }
  return zipSync(files)
}

const roleEl = (els: unknown[] | undefined, role: string): SlideTextElement =>
  ((els ?? []) as SlideTextElement[]).find((e) => e.type === 'text' && e.styleRole === role)!

describe('pptx layout inheritance', () => {
  it('places the title where the layout says, not at our default', async () => {
    const r = await parsePptx(deck({
      slide: titleSp('Where I belong'),
      layout: phSp('type="title"', 0, EMU_H / 2, EMU_W, EMU_H / 4)
    }), 'd.pptx')
    const t = roleEl(r.body!.slides[0].elements, 'title')
    expect([t.x, t.y, t.w, t.h]).toEqual([0, 360, 1280, 180])
  })

  it('falls back to the master when the layout does not declare the slot', async () => {
    const r = await parsePptx(deck({
      slide: titleSp('T'),
      layout: '',
      master: phSp('type="title"', 0, EMU_H / 2, EMU_W, EMU_H / 4)
    }), 'd.pptx')
    const t = roleEl(r.body!.slides[0].elements, 'title')
    expect([t.x, t.y, t.w, t.h]).toEqual([0, 360, 1280, 180])
  })

  it('prefers the layout over the master for the same slot', async () => {
    const r = await parsePptx(deck({
      slide: titleSp('T'),
      layout: phSp('type="title"', 0, 0, EMU_W / 4, EMU_H / 4),
      master: phSp('type="title"', 0, EMU_H / 2, EMU_W, EMU_H / 2)
    }), 'd.pptx')
    const t = roleEl(r.body!.slides[0].elements, 'title')
    expect([t.x, t.y, t.w]).toEqual([0, 0, 320])
  })

  it('treats ctrTitle as the title slot', async () => {
    const r = await parsePptx(deck({
      slide: titleSp('T'),
      layout: phSp('type="ctrTitle"', 0, EMU_H / 4, EMU_W, EMU_H / 4)
    }), 'd.pptx')
    expect(roleEl(r.body!.slides[0].elements, 'title').y).toBe(180)
  })

  it('places the body from its own slot, independently of the title', async () => {
    const body = `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr/><p:txBody><a:p><a:r><a:t>A bullet</a:t></a:r></a:p></p:txBody></p:sp>`
    const r = await parsePptx(deck({
      slide: titleSp('T') + body,
      layout: phSp('type="title"', 0, 0, EMU_W, EMU_H / 4) +
        phSp('type="body"', 0, EMU_H / 2, EMU_W / 2, EMU_H / 2)
    }), 'd.pptx')
    expect(roleEl(r.body!.slides[0].elements, 'title').y).toBe(0)
    const b = roleEl(r.body!.slides[0].elements, 'body')
    expect([b.y, b.w]).toEqual([360, 640])
  })

  it('still places the title when neither layout nor master declares it', async () => {
    const r = await parsePptx(deck({ slide: titleSp('T') }), 'd.pptx')
    const t = roleEl(r.body!.slides[0].elements, 'title')
    expect(t.w).toBeGreaterThan(0)
    expect(t.h).toBeGreaterThan(0)
  })
})
