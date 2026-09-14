import { useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import { useFilesStore } from '../../stores/files'
import { fileSrc } from '../../lib/fileUrl'

// A set of pictures read as a set.
//
// One image widget per photo turns a desk into a filing cabinet: six frames,
// six headers, six drag handles, and no way to see them as the group they
// actually are. This holds the group, lays it out edge to edge, and opens one
// large when you want to look properly.
//
// Content is a list of file ids. Not URLs: a gallery of links to somebody
// else's server is a gallery that empties itself, which this project has
// already watched happen to a desk full of images.

interface GalleryContent {
  fileIds: string[]
}

function parse(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as GalleryContent | string[]
    if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
    return Array.isArray(p?.fileIds) ? p.fileIds.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export default function GalleryWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const ingestBlob = useFilesStore((s) => s.ingestBlob)
  const ids = useMemo(() => parse(widget.content), [widget.content])
  const [open, setOpen] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)

  const add = async (files: File[]): Promise<void> => {
    const added: string[] = []
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      try {
        // ingestBlob copies the bytes into the workspace, which is the whole
        // point: a gallery of links to someone else's server empties itself.
        const stored = await ingestBlob(f, f.name)
        added.push(stored.id)
      } catch {
        // One unreadable file must not lose the rest of the drop.
      }
    }
    if (added.length) await update(widget.id, { content: JSON.stringify({ fileIds: [...ids, ...added] }) })
  }

  const body = (
    <div
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        void add(Array.from(e.dataTransfer.files ?? []))
      }}
      className={`h-full w-full overflow-auto ${dropping ? 'ring-2 ring-accent ring-inset bg-accent/5' : 'bg-[var(--surface-sunken)]'}`}
    >
      {ids.length === 0 ? (
        <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-4 text-center">
          <Icon name="photo_library" size={22} className="text-[var(--ink-40)]" />
          <div className="fb-t-caption text-[var(--ink-60)]">Drop pictures here</div>
          <div className="text-[10px] text-[var(--ink-40)] leading-snug max-w-[220px]">
            They are copied into this workspace, so the gallery keeps working when
            the original moves.
          </div>
        </div>
      ) : (
        // A dense grid rather than a carousel: the whole set at once is the
        // thing a gallery is for, and a carousel hides most of it.
        <div className="grid gap-1 p-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
          {ids.map((id) => (
            <button
              key={id}
              onClick={() => setOpen(id)}
              className="relative block aspect-[4/3] overflow-hidden rounded-[4px] ring-1 ring-black/[0.06] dark:ring-white/[0.08] hover:ring-accent/50 transition-shadow"
            >
              <img src={fileSrc(id)} alt="" className="h-full w-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {open && (
        <div
          className="absolute inset-0 z-20 bg-black/70 flex items-center justify-center p-3"
          onClick={() => setOpen(null)}
          role="presentation"
        >
          <img src={fileSrc(open)} alt="" className="max-h-full max-w-full object-contain rounded" />
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(null) }}
            className="absolute top-2 right-2 icon-btn !h-6 !w-6 !text-white"
            aria-label="Close"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </div>
  )

  return (
    <WidgetFrame
      widget={widget}
      headerLabel={`gallery${ids.length ? ` · ${ids.length}` : ''}`}
      headerAccent="bg-violet-200/50 dark:bg-violet-400/10"
    >
      {body}
    </WidgetFrame>
  )
}
