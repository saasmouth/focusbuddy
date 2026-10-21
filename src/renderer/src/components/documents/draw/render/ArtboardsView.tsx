// The pages under the art when a drawing has several artboards (WP-ARTBOARD):
// each artboard is drawn at its place on the pasteboard with its own
// background (a checkerboard where it is transparent) and its name above it,
// as Illustrator shows them. With one artboard the stage itself is the page
// and this is not drawn.

import { memo } from 'react'
import type { Box } from '@shared/drawGeometry'
import type { DrawDoc } from '@shared/draw/model'
import { primaryArtboard } from '@shared/draw/ops'
import { docPaintToCss } from '@shared/draw/svg'

const CHECKER = {
  backgroundImage:
    'linear-gradient(45deg,#d6d3d1 25%,transparent 25%),linear-gradient(-45deg,#d6d3d1 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d6d3d1 75%),linear-gradient(-45deg,transparent 75%,#d6d3d1 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0'
}

function ArtboardsView({ doc, frame, zoom }: { doc: DrawDoc; frame: Box; zoom: number }): JSX.Element {
  const active = primaryArtboard(doc).id
  return (
    <div className="absolute inset-0 pointer-events-none" data-testid="draw-artboards">
      {doc.artboards.map((a, i) => {
        const none = a.background.type === 'none'
        return (
          <div
            key={a.id}
            data-testid={`draw-artboard-${a.id}`}
            data-active={a.id === active ? '1' : undefined}
            className="absolute shadow-md"
            style={{
              left: (a.x - frame.x) * zoom,
              top: (a.y - frame.y) * zoom,
              width: a.w * zoom,
              height: a.h * zoom,
              ...(none ? CHECKER : { background: docPaintToCss(doc, a.background) }),
              outline: a.id === active ? '1px solid rgba(28,25,23,0.55)' : '1px solid rgba(28,25,23,0.15)'
            }}
          >
            <span
              className="absolute left-0 -top-[18px] text-[11px] leading-[16px] whitespace-nowrap text-[var(--ink-50)] max-w-full overflow-hidden text-ellipsis"
              style={{ fontWeight: a.id === active ? 600 : 400 }}
            >
              {i + 1} – {a.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default memo(ArtboardsView)
