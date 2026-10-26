// The shape of what an embed shows, so a dropped embed starts the size of its
// content (owner, 4.3.44: "the default size of the embed should be the same as
// the content within, depending on the type"). One answer for every host: Write
// measures it live (WidgetEmbedNode), and Deck, Design, Draw, Diagram and Cells
// fit their dropped box to it here.

import type { SheetBody } from '@shared/types'
import type { DesignBody } from '@shared/design'
import { documentIdFromEmbed } from '@shared/documentEmbedId'

const ROW_PX = 27
const COL_PX = 110

/**
 * Height / width of an office document's output, or null when it is running
 * text, which has no shape of its own until it is laid out at a width.
 */
export async function documentAspect(docType: string, body: unknown): Promise<number | null> {
  if (docType === 'slides') return 9 / 16
  if (docType === 'design') {
    const b = body as DesignBody
    return b?.width ? b.height / b.width : null
  }
  if (docType === 'map') {
    const [{ normalizeBody }, { mapToSvg }] = await Promise.all([import('@shared/diagram/normalize'), import('@shared/mapExport')])
    const r = mapToSvg(normalizeBody(body), { padding: 24, background: '#ffffff' })
    return r.height / Math.max(1, r.width)
  }
  if (docType === 'draw') {
    const [{ normalizeDrawDoc }, { exportArtboard }] = await Promise.all([import('@shared/draw/normalize'), import('@shared/draw/svg')])
    const a = exportArtboard(normalizeDrawDoc(body))
    return a.h / Math.max(1, a.w)
  }
  if (docType === 'sheet') {
    // The used grid, as the output draws it: header plus rows, by its columns.
    const { normalizeBody, activeTab } = await import('../../../lib/sheetBody')
    const tab = activeTab(normalizeBody(body as SheetBody))
    const rows = Math.min(30, Math.max(3, tab.rows.length))
    const cols = Math.min(10, Math.max(2, tab.columns.length))
    return (ROW_PX * (rows + 1) + 28) / (COL_PX * cols + 36)
  }
  return null
}

/** Height / width of what this embed shows, or null when it has no fixed shape. */
export async function embedAspect(widgetId: string): Promise<number | null> {
  try {
    const docId = documentIdFromEmbed(widgetId)
    if (docId) {
      const doc = await window.api.documents.get(docId)
      return doc ? await documentAspect(doc.docType, doc.body) : null
    }
    // A work widget: the frame it was made in on its desk is the shape it was
    // designed to be seen at.
    const { resolveWidget } = await import('./widgetLookup')
    const res = await resolveWidget(widgetId)
    const w = res?.widget
    return w && w.width > 0 && w.height > 0 ? w.height / w.width : null
  } catch {
    return null
  }
}

/**
 * The host's default box, reshaped to the content: as wide as the default, as
 * tall as the content is at that width, and narrower instead when that would
 * be taller than `maxH`. Without a shape the default box is kept.
 */
export async function fitEmbedBox(widgetId: string, box: { w: number; h: number; maxH: number }): Promise<{ w: number; h: number }> {
  const aspect = await embedAspect(widgetId)
  if (!aspect || !Number.isFinite(aspect)) return { w: box.w, h: box.h }
  const a = Math.min(4, Math.max(0.1, aspect))
  const h = box.w * a
  if (h <= box.maxH) return { w: Math.round(box.w), h: Math.round(h) }
  return { w: Math.round(box.maxH / a), h: Math.round(box.maxH) }
}
