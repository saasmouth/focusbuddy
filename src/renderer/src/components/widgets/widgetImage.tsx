// Pictures in the page and markdown work widgets.
//
// It IS PlexiiWrite's ResizableImage (same `image` node, same `width`
// attribute, so a page's JSON and a document's agree and a picture moves
// between them unchanged), with one difference in how it is DRAWN: the src is
// resolved through resolveMediaSrc, so a picture stored as fb-file://<id> (how
// a converted or pasted picture is kept, lib/widgetPictures.ts) shows in the
// browser build too, where that scheme does not exist. The stored attribute
// is never rewritten, so the page and its markdown keep the portable form.

import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useRef } from 'react'
import { ResizableImage } from '../documents/editor/ResizableImage'
import { resolveMediaSrc } from '../../lib/fileUrl'

function WidgetImageView({ node, updateAttributes, selected, editor }: NodeViewProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const width = (node.attrs.width as number | null) ?? null

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = wrapRef.current?.querySelector('img')?.clientWidth ?? 320
    const onMove = (ev: MouseEvent): void => updateAttributes({ width: Math.max(40, Math.round(startW + ev.clientX - startX)) })
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <NodeViewWrapper ref={wrapRef} className="relative inline-block max-w-full" data-drag-handle data-testid="widget-image">
      <img
        src={resolveMediaSrc(node.attrs.src as string)}
        alt={(node.attrs.alt as string) ?? ''}
        data-src={node.attrs.src as string}
        style={{ width: width ? `${width}px` : undefined }}
        className={`max-w-full rounded ${selected ? 'outline outline-2 outline-accent' : ''}`}
        draggable={false}
      />
      {selected && editor.isEditable && (
        <span
          onMouseDown={startResize}
          className="absolute -bottom-1 -right-1 h-3 w-3 rounded-sm bg-accent border-2 border-white dark:border-stone-900 cursor-nwse-resize"
          title="Drag to resize"
        />
      )}
    </NodeViewWrapper>
  )
}

/** The image node for the page and markdown work widgets: block-level, data: URLs allowed (they are stored on insert). */
export const WidgetImage = ResizableImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(WidgetImageView)
  }
}).configure({ inline: false, allowBase64: true })
