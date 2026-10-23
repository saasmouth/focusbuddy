/**
 * RP-1: can the real app's renderer turn a Deck/Design picture (an SVG whose
 * content is HTML inside a foreignObject, shared/snippetForms/picture.ts
 * elementsToSvg) into a PNG on a canvas, the way snippetRaster.ts does it
 * (PlexiiDraw's rasterizeSvgInDom: data: URL image, drawImage, toDataURL)?
 *
 * Older Chromium marked a canvas that drew an SVG image holding a
 * foreignObject as tainted, and toDataURL then threw a SecurityError. Measured
 * on this Electron (2026-10-23): it does NOT; the renderer returns a PNG, and
 * the PNG really shows the picture (the red shape and the dark text are in its
 * pixels, not a blank canvas). So snippetRaster needs no main-process capture
 * fallback. This spec pins that, so an Electron upgrade that starts tainting
 * these canvases fails here rather than silently turning pictures into nulls.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'
import { elementsToSvg } from '../../src/shared/snippetForms/picture'
import type { SlideElement } from '../../src/shared/types'

let app: LaunchedApp
let window: Page

const ELEMENTS = [
  { id: 's', type: 'shape', shape: 'rect', x: 0, y: 0, w: 200, h: 100, z: 0, fill: { type: 'solid', color: '#ff0000' } },
  { id: 't', type: 'text', x: 10, y: 10, w: 180, h: 40, z: 1, paragraphs: [{ runs: [{ text: 'Quarterly results', bold: true }] }] }
] as unknown as SlideElement[]

test.beforeAll(async () => {
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
})

test.afterAll(async () => {
  await app.dispose()
})

/** The same procedure as rasterizeSvgInDom, run in the app's renderer. */
async function rasterInRenderer(svg: string, w: number, h: number): Promise<{ png: string | null; error: string | null }> {
  return window.evaluate(
    async ({ svg, w, h }) => {
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      const img = new Image()
      img.decoding = 'async'
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('image did not load'))
          img.src = url
        })
      } catch (e) {
        return { png: null, error: (e as Error).message }
      }
      const canvas = document.createElement('canvas')
      canvas.width = w * 2
      canvas.height = h * 2
      const g = canvas.getContext('2d')!
      g.drawImage(img, 0, 0, w * 2, h * 2)
      try {
        return { png: canvas.toDataURL('image/png'), error: null }
      } catch (e) {
        return { png: null, error: `${(e as Error).name}: ${(e as Error).message}` }
      }
    },
    { svg, w, h }
  )
}

test('RP-1 a Deck/Design foreignObject picture rasterises to a painted PNG in the renderer', async () => {
  const pic = elementsToSvg(ELEMENTS, 'PlexiiDeck')
  expect(pic.svg).toContain('<foreignObject')
  const r = await rasterInRenderer(pic.svg, pic.width, pic.height)
  expect(r.error).toBeNull()
  expect(r.png?.startsWith('data:image/png;base64,')).toBe(true)
  // Read the PNG's own pixels back: a canvas can encode a blank picture too.
  const px = await window.evaluate(async (png) => {
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('png did not load'))
      img.src = png
    })
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    let red = 0
    let dark = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++
      else if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++
    }
    return { w: img.width, h: img.height, red, dark }
  }, r.png!)
  console.log('[RP-1] foreignObject PNG', JSON.stringify(px))
  expect(px.w).toBe(pic.width * 2)
  expect(px.h).toBe(pic.height * 2)
  // The red rectangle fills most of the picture; the bold words are dark pixels on it.
  expect(px.red).toBeGreaterThan(px.w * px.h * 0.5)
  expect(px.dark).toBeGreaterThan(50)
})
