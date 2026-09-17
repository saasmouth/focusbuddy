import { columnBoxes, marginBox, type DesignBody } from '@shared/design'
import type { SlideElement, SlideTextElement } from '@shared/types'

// The non-printing furniture of a page-layout view: the margin box, the column
// grid, the author's ruler guides, the outline of anything set to wrap text, and
// the overset marker on a full text frame.
//
// None of it is content — it is drawn above the page, never exported, and never
// clickable, so it can be dense without getting in the way. Everything is in
// logical page coordinates, which is why it can live inside SlideCanvas's scaled
// stage and stay pin-sharp at any zoom.

interface Props {
  design: DesignBody
  /** The canvas scale, so hairlines stay one screen pixel wide at any zoom. */
  scale: number
  show: {
    margins: boolean
    columns: boolean
    guides: boolean
    wrap: boolean
  }
  /** Fires when a guide is clicked, so the editor can delete it. */
  onRemoveGuide?: (axis: 'v' | 'h', at: number) => void
}

export default function LayoutOverlay({ design, scale, show, onRemoveGuide }: Props): JSX.Element {
  const hair = Math.max(0.5, 1 / Math.max(scale, 0.01))
  const box = marginBox(design)
  const cols = columnBoxes(design)
  const elements: SlideElement[] = design.elements ?? []

  return (
    <div className="pointer-events-none" style={{ position: 'absolute', inset: 0, zIndex: 9997 }} data-testid="design-layout-overlay">
      {show.margins && design.margins && (
        <div
          data-testid="design-margin-box"
          style={{
            position: 'absolute',
            left: box.x,
            top: box.y,
            width: box.w,
            height: box.h,
            border: `${hair}px solid rgba(236,72,153,0.55)`
          }}
        />
      )}

      {show.columns && cols.length > 1 && (
        <>
          {cols.map((c, i) => (
            <div
              key={i}
              data-testid={`design-column-${i}`}
              style={{
                position: 'absolute',
                left: c.x,
                top: c.y,
                width: c.w,
                height: c.h,
                background: 'rgba(139,92,246,0.06)',
                borderLeft: `${hair}px solid rgba(139,92,246,0.4)`,
                borderRight: `${hair}px solid rgba(139,92,246,0.4)`
              }}
            />
          ))}
        </>
      )}

      {show.guides && (
        <>
          {(design.guides?.v ?? []).map((x, i) => (
            <div
              key={`v${i}`}
              data-testid="design-guide-v"
              onClick={() => onRemoveGuide?.('v', x)}
              title="Click to remove this guide"
              style={{
                position: 'absolute',
                left: x - hair,
                top: 0,
                width: hair * 3,
                height: design.height,
                background: 'rgba(14,165,233,0.75)',
                pointerEvents: onRemoveGuide ? 'auto' : 'none',
                cursor: onRemoveGuide ? 'pointer' : 'default'
              }}
            />
          ))}
          {(design.guides?.h ?? []).map((y, i) => (
            <div
              key={`h${i}`}
              data-testid="design-guide-h"
              onClick={() => onRemoveGuide?.('h', y)}
              title="Click to remove this guide"
              style={{
                position: 'absolute',
                left: 0,
                top: y - hair,
                height: hair * 3,
                width: design.width,
                background: 'rgba(14,165,233,0.75)',
                pointerEvents: onRemoveGuide ? 'auto' : 'none',
                cursor: onRemoveGuide ? 'pointer' : 'default'
              }}
            />
          ))}
        </>
      )}

      {show.wrap &&
        elements
          .filter((el) => el.wrap?.mode === 'square')
          .map((el) => {
            const o = el.wrap?.offset ?? 0
            return (
              <div
                key={`w-${el.id}`}
                data-testid="design-wrap-outline"
                style={{
                  position: 'absolute',
                  left: el.x - o,
                  top: el.y - o,
                  width: el.w + o * 2,
                  height: el.h + o * 2,
                  border: `${hair}px dashed rgba(34,197,94,0.8)`
                }}
              />
            )
          })}

      {/* Overset markers: the classic red square on a full frame. Its presence is
          the honest signal that text exists which the page is not showing. */}
      {elements
        .filter((el): el is SlideTextElement => el.type === 'text' && el.overset === true)
        .map((el) => (
          <div
            key={`o-${el.id}`}
            data-testid="design-overset"
            title="This frame is full — text is still waiting. Link another frame or make this one bigger."
            style={{
              position: 'absolute',
              left: el.x + el.w - 14,
              top: el.y + el.h - 14,
              width: 14,
              height: 14,
              background: '#ef4444',
              color: '#fff',
              fontSize: 11,
              lineHeight: '14px',
              textAlign: 'center',
              fontWeight: 700,
              border: '1px solid #fff'
            }}
          >
            +
          </div>
        ))}

      {/* Thread ports: the small squares that say a frame is part of a story and
          which end of the chain it is. */}
      {elements
        .filter((el): el is SlideTextElement => el.type === 'text' && !!el.storyId)
        .map((el) => (
          <div
            key={`t-${el.id}`}
            data-testid="design-thread-port"
            style={{
              position: 'absolute',
              left: el.x - 5,
              top: el.y - 5,
              width: 10,
              height: 10,
              background: '#0ea5e9',
              border: '1px solid #fff'
            }}
            title={`Threaded frame ${el.storyOrder ?? '?'}`}
          />
        ))}
    </div>
  )
}
