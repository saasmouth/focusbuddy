import type { DocType } from '@shared/types'
import { useViewStore } from '../../../stores/view'
import { useDocMetas } from '../../../lib/docMetaCache'
import Icon from '../../Icon'

// The read-only card shown for a PlexiOffice document embedded inside another
// document. It resolves the referenced document's live title/type from the
// shared meta cache and offers an Open button, rather than nesting a full live
// editor. Keeping it a reference card (not a live sub-editor) avoids heavy
// nested editors and the self-embed infinite-render trap.

const TYPE_ICON: Record<DocType, string> = {
  doc: 'description',
  sheet: 'table_chart',
  slides: 'slideshow',
  map: 'account_tree',
  design: 'palette',
  draw: 'brush'
}
const TYPE_LABEL: Record<DocType, string> = {
  doc: 'Document',
  sheet: 'Spreadsheet',
  slides: 'Slides',
  map: 'Diagram',
  design: 'Design',
  draw: 'Artwork'
}

export default function DocEmbed({ documentId }: { documentId: string }): JSX.Element {
  const metas = useDocMetas(documentId ? [documentId] : [])
  const goDocument = useViewStore((s) => s.goDocument)
  const meta = metas[documentId]

  if (!documentId) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--edge-firm)] px-3 py-2 text-[12px] text-[var(--ink-40)]">
        No document linked.
      </div>
    )
  }

  return (
    <div className="fb-card flex items-center gap-3 px-3 py-2.5">
      <span className="h-9 w-9 rounded-lg bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] inline-flex items-center justify-center shrink-0">
        <Icon name={meta ? TYPE_ICON[meta.docType] : 'description'} size={18} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[var(--ink-100)] truncate">
          {meta ? meta.title || 'Untitled' : 'Document'}
        </div>
        <div className="text-[11px] text-[var(--ink-50)]">
          {meta ? TYPE_LABEL[meta.docType] : 'PlexiOffice document'}
        </div>
      </div>
      <button
        onClick={() => goDocument(documentId)}
        className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-[rgb(var(--accent))] text-white text-[12px] font-medium hover:bg-[rgb(var(--accent-hover))] shrink-0"
      >
        <Icon name="open_in_new" size={14} /> Open
      </button>
    </div>
  )
}
