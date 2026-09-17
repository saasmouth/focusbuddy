import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import type { DocType, FbDocument } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import { DocEditor, SheetEditor, SlidesEditor, MapEditor, DesignEditor, DrawStudio } from '@office'
import type { MapBody, SheetBody, SlidesBody } from '@shared/types'

// A document / spreadsheet / slide deck living on the canvas as a native widget.
// widget.content holds the backing fb_documents id (the same store the full
// Documents view uses), so the same file can be opened in both places and edits
// stay in sync. A widget with no content yet lazily provisions a blank document
// of its type. Body edits persist straight to the document (debounced) via IPC.

interface Props {
  widget: Widget
  inline?: boolean
}

const KIND_TO_DOCTYPE: Record<string, DocType> = {
  doc: 'doc',
  sheet: 'sheet',
  slides: 'slides',
  map: 'map',
  design: 'design',
  draw: 'draw'
}
const TYPE_META: Record<DocType, { label: string; accent: string }> = {
  doc: { label: 'Document', accent: 'bg-sky-300/60 dark:bg-sky-400/25' },
  sheet: { label: 'Spreadsheet', accent: 'bg-emerald-300/60 dark:bg-emerald-400/25' },
  slides: { label: 'Slides', accent: 'bg-orange-300/60 dark:bg-orange-400/25' },
  map: { label: 'Diagram', accent: 'bg-violet-300/60 dark:bg-violet-400/25' },
  design: { label: 'Design', accent: 'bg-pink-300/60' },
  draw: { label: 'Artwork', accent: 'bg-fuchsia-300/60 dark:bg-fuchsia-400/25' }
}

export default function OfficeDocWidget({ widget, inline = false }: Props): JSX.Element {
  const docType = KIND_TO_DOCTYPE[widget.kind] ?? 'doc'
  const updateWidget = useWidgetStore((s) => s.update)
  const [doc, setDoc] = useState<FbDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const provisioned = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load the backing document, or provision a blank one and repoint the widget.
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      if (widget.content) {
        const fetched = await window.api.documents.get(widget.content)
        if (cancelled) return
        if (fetched) {
          setDoc(fetched)
          return
        }
        // Dangling id (e.g. document deleted) — heal by provisioning a new one.
      }
      if (provisioned.current) return
      provisioned.current = true
      const created = await window.api.documents.create({
        docType,
        title: widget.title || TYPE_META[docType].label
      })
      if (cancelled) return
      setDoc(created)
      await updateWidget(widget.id, { content: created.id })
    }
    void load().catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.content])

  // Debounced persist of the body to the document store.
  function saveBody(body: unknown): void {
    setDoc((d) => (d ? { ...d, body: body as FbDocument['body'] } : d))
    if (!widget.content) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.api.documents.update(widget.content, { body: body as FbDocument['body'] })
    }, 500)
  }

  const meta = TYPE_META[docType]
  let body: JSX.Element
  if (error) {
    body = <div className="h-full w-full flex items-center justify-center text-[11px] text-red-500">{error}</div>
  } else if (!doc) {
    body = (
      <div className="h-full w-full flex items-center justify-center text-[11px] text-[var(--ink-50)]">
        Loading {meta.label.toLowerCase()}…
      </div>
    )
  } else if (docType === 'doc') {
    body = <DocEditor key={doc.id} content={doc.body} title={doc.title} onChange={saveBody} />
  } else if (docType === 'sheet') {
    body = <SheetEditor key={doc.id} body={doc.body as SheetBody} title={doc.title} onChange={saveBody} />
  } else if (docType === 'slides') {
    body = <SlidesEditor key={doc.id} body={doc.body as SlidesBody} title={doc.title} onChange={saveBody} />
  } else if (docType === 'design') {
    body = <DesignEditor key={doc.id} content={doc.body} title={doc.title} onChange={saveBody} />
  } else if (docType === 'draw') {
    body = <DrawStudio key={doc.id} content={doc.body} title={doc.title} onChange={saveBody} />
  } else {
    body = <MapEditor key={doc.id} body={doc.body as MapBody} title={doc.title} onChange={saveBody} />
  }

  // Stop right-clicks (and the editors' own context menus, e.g. the sheet column
  // header menu) from bubbling to the canvas, so the canvas add/widget menu does
  // not hijack them when the document widget is focused.
  const wrapped = (
    <div
      className="h-full w-full overflow-auto bg-[var(--surface-raised)]"
      onContextMenu={(e) => e.stopPropagation()}
    >
      {body}
    </div>
  )
  if (inline) return wrapped
  return (
    <WidgetFrame widget={widget} headerLabel={doc?.title || meta.label} headerAccent={meta.accent}>
      {wrapped}
    </WidgetFrame>
  )
}
