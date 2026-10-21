// Help > How PlexiiDraw works.

import type { DrawDialog } from '../editor/types'

const help: DrawDialog = {
  id: 'help',
  title: 'How PlexiiDraw works',
  component: function HelpDialog() {
    return (
      <div className="space-y-2.5 text-[13px] text-[var(--ink-70)]">
        <p>
          PlexiiDraw holds vector shapes and painted pixels in one stack. A <strong>vector layer</strong> takes the pen, pencil, shape and type tools; a{' '}
          <strong>paint layer</strong> takes the brush, eraser and paint bucket. Add either from the Layer menu or the two buttons above the layers list.
        </p>
        <ul className="space-y-1 list-disc pl-4">
          <li>Draw a bezier with the Pen (P) — click for corners, drag for curves, click the first point to close.</li>
          <li>Edit points with the direct-select tool (A): drag anchors, drag handles, hold Alt to break a handle pair.</li>
          <li>Select two or more shapes and use Pathfinder to unite, subtract, intersect or exclude them.</li>
          <li>Hold Shift while drawing for a perfect square or circle, and while dragging to constrain to one axis.</li>
          <li>Space-drag (or the Hand tool) pans; ⌘/Ctrl with the scroll wheel zooms.</li>
          <li>[ and ] resize the brush. The eyedropper (I) samples a colour from a shape or from painted pixels.</li>
          <li>Rasterize a vector layer to paint over its shapes; merge down to flatten two layers into one.</li>
        </ul>
      </div>
    )
  }
}

export default help
