// Image (contextual, one picture selected): Replace image…, Place as
// template…, and what the picture is (its pixel size and how big it is
// placed). Image Trace arrives later.

import { BarGroup, BarSep } from '../../../office/shell'
import { getObject } from '@shared/draw/ops'
import type { DrawImageNode } from '@shared/draw/model'
import type { DrawBarTab, EditorCtx, EditorState } from '../editor/types'
import { CmdButton, useEditor } from './controls'

export function selectedImageNode(s: Pick<EditorState, 'doc' | 'selection'>): DrawImageNode | null {
  if (s.selection.length !== 1) return null
  const n = getObject(s.doc, s.selection[0])
  return n && n.type === 'image' ? n : null
}

function ImageTab({ ctx }: { ctx: EditorCtx }): JSX.Element | null {
  const s = useEditor(ctx)
  const img = selectedImageNode(s)
  if (!img) return null
  const asset = s.doc.assets[img.assetId]
  const kind = asset?.mime?.replace('image/', '').toUpperCase() || 'Picture'
  const natural = asset?.w && asset?.h ? `${kind}, ${asset.w} × ${asset.h} px` : kind
  return (
    <>
      <BarGroup label="Image">
        <CmdButton ctx={ctx} id="file.replaceImage" icon="swap_horiz" showLabel testid="draw-image-replace" />
        <CmdButton ctx={ctx} id="file.placeTemplate" icon="layers" showLabel testid="draw-image-template" />
      </BarGroup>
      <BarSep />
      <span className="shrink-0 px-1 text-[11px] text-[var(--ink-50)] fb-tabular" data-testid="draw-image-info">
        {natural}, placed at {Math.round(img.w)} × {Math.round(img.h)}
      </span>
    </>
  )
}

const image: DrawBarTab = { id: 'image', label: 'Image', order: 160, when: (s) => selectedImageNode(s) !== null, component: ImageTab }

export default image
