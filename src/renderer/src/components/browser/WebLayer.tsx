import { useLayoutEffect, useRef } from 'react'
import { registerWebLayerHost } from '../../lib/webLayer'

/**
 * The canvas surface's web layer (lib/webLayer): the one place this desk's
 * live web pages sit for their whole life, so switching between the canvas,
 * the Workcentre and Columns hands each page to the new view instead of
 * reloading it.
 *
 * Render it as the canvas surface's FIRST child: React runs layout effects in
 * tree order, so the layer is registered before any browser in the views below
 * it claims its page on the same commit.
 *
 * `z` places the pages in the surface's stacking context: just above the
 * transformed desk on the canvas (below its links, menus and selection
 * chrome), just above a full-screen desk view (z-60) otherwise.
 */
export default function WebLayer({ z }: { z: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => registerWebLayerHost(ref.current!), [])
  return <div ref={ref} data-web-layer="" data-testid="web-layer" className="absolute inset-0 pointer-events-none" style={{ zIndex: z }} />
}
