// A converted snippet's SVG picture as a PNG, for the destinations that need a
// bitmap (a file in the store, an export). Kept out of the pure core on
// purpose: rasterising is asynchronous and needs a DOM, while conversion must
// be synchronous and deterministic. Uses PlexiiDraw's own rasteriser.
//
// Honest failure: null when the picture cannot be drawn. Deck and Design
// pictures are HTML in a foreignObject; older Chromium tainted a canvas that
// drew one, but this Electron does not, and the PNG really shows the picture
// (measured in the app by tests/e2e/snippetRasterProbe.spec.ts RP-1, which
// fails first if an upgrade brings the taint back). A caller still handles
// null by keeping the SVG data: URL, never by claiming a PNG.

import type { SvgValue } from '@shared/snippetForms'
import { rasterizeSvgInDom } from '../components/documents/draw/editor/clipboard'

/** PNG data: URL of the picture at `scale` pixels per unit, or null when it cannot be drawn. */
export async function snippetSvgToPng(pic: Pick<SvgValue, 'svg' | 'width' | 'height'>, scale = 2): Promise<string | null> {
  if (!pic.svg || pic.width <= 0 || pic.height <= 0) return null
  try {
    return await rasterizeSvgInDom(pic.svg, pic.width, pic.height, scale)
  } catch {
    return null
  }
}
