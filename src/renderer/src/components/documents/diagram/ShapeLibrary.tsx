import { useMemo, useRef, useState } from 'react'
import { SHAPES, SHAPE_CATEGORIES, searchShapes, shapesIn, type ShapeCategory } from '@shared/diagram/shapes'
import { resolveNodeStyle } from '@shared/diagram/style'
import Icon from '../../Icon'
import { ShapeThumb } from './ShapeSvg'
import { ICON_NAMES } from './iconNames'
import type { Commands } from './commands'

// The left-hand library: shapes (searchable, favourites, collapsible
// categories), the full Material Symbols icon set, and images. Click to add at
// the centre of the view, or drag onto the canvas to drop exactly.

const FAV_KEY = 'pd-fav-shapes'
const OPEN_KEY = 'pd-open-cats'

// Test ids predate the category rename ("Basic shapes" → "Basic").
const catSlug = (c: ShapeCategory): string => (c === 'Basic' ? 'basic-shapes' : c.replace(/\s+/g, '-').toLowerCase())

function readSet(key: string, fallback: string[]): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    return new Set(raw ? (JSON.parse(raw) as string[]) : fallback)
  } catch {
    return new Set(fallback)
  }
}
function writeSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s]))
  } catch {
    /* private mode / quota: favourites just won't persist */
  }
}

export function ShapeLibrary({ cmd, themeId, readOnly }: { cmd: Commands; themeId: string; readOnly: boolean }): JSX.Element {
  const [tab, setTab] = useState<'shapes' | 'icons' | 'images'>('shapes')
  return (
    <div className="h-full min-h-0 flex flex-col w-full" data-testid="diagram-library">
      <div className="shrink-0 flex items-center gap-0.5 px-2 pt-2">
        {(
          [
            ['shapes', 'Shapes', 'category'],
            ['icons', 'Icons', 'emoji_symbols'],
            ['images', 'Images', 'image']
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`diagram-library-tab-${id}`}
            className={`flex-1 inline-flex items-center justify-center gap-1 h-7 rounded text-[11px] ${tab === id ? 'bg-[var(--surface-sunken)] text-[var(--ink-90)] font-semibold' : 'text-[var(--ink-60)] hover:text-[var(--ink-90)]'}`}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'shapes' && <ShapesTab cmd={cmd} themeId={themeId} readOnly={readOnly} />}
      {tab === 'icons' && <IconsTab cmd={cmd} readOnly={readOnly} />}
      {tab === 'images' && <ImagesTab cmd={cmd} readOnly={readOnly} />}
    </div>
  )
}

function ShapesTab({ cmd, themeId, readOnly }: { cmd: Commands; themeId: string; readOnly: boolean }): JSX.Element {
  const [query, setQuery] = useState('')
  const [favs, setFavs] = useState(() => readSet(FAV_KEY, []))
  const [open, setOpen] = useState(() => readSet(OPEN_KEY, ['Flowchart']))
  const results = useMemo(() => (query.trim() ? searchShapes(query) : null), [query])
  const thumbStyle = useMemo(() => resolveNodeStyle({ shape: 'process', color: '#475569' }, themeId), [themeId])

  const toggleFav = (id: string): void => {
    const next = new Set(favs)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFavs(next)
    writeSet(FAV_KEY, next)
  }
  const toggleCat = (c: ShapeCategory): void => {
    const next = new Set(open)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setOpen(next)
    writeSet(OPEN_KEY, next)
  }

  const grid = (ids: string[]): JSX.Element => (
    <div className="grid grid-cols-4 gap-1">
      {ids.map((id) => {
        const def = SHAPES.find((s) => s.id === id)
        if (!def) return null
        return (
          <button
            key={id}
            type="button"
            className="pd-thumb group relative"
            title={def.label}
            data-testid={`map-add-${id}`}
            disabled={readOnly}
            draggable={!readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-plexii-shape', id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => cmd.addShape(id)}
            onContextMenu={(e) => {
              e.preventDefault()
              toggleFav(id)
            }}
          >
            <ShapeThumb shape={id} style={{ ...thumbStyle, ...resolveNodeStyle({ shape: id, color: def.color ?? '#475569' }, themeId), strokeWidth: 1.4 }} />
            <span className="sr-only">{def.label}</span>
            {favs.has(id) && <Icon name="star" size={9} filled className="absolute top-0.5 right-0.5 text-amber-500" />}
          </button>
        )
      })}
    </div>
  )

  return (
    <>
      <div className="shrink-0 px-2 py-2">
        <div className="relative">
          <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={`Search ${SHAPES.length} shapes`}
            data-testid="diagram-shape-search"
            className="fb-field w-full h-7 pl-7 pr-2 text-[12px]"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {results ? (
          results.length ? (
            <>
              <div className="text-[10px] text-[var(--ink-50)] mb-1">{results.length} match{results.length === 1 ? '' : 'es'}</div>
              {grid(results.map((s) => s.id))}
            </>
          ) : (
            <div className="text-[11px] text-[var(--ink-50)] px-1 py-4 text-center">No shapes match “{query}”. Try the Icons tab.</div>
          )
        ) : (
          <>
            {favs.size > 0 && (
              <div className="mb-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-50)] mb-1 px-0.5">Favourites</div>
                {grid([...favs])}
              </div>
            )}
            {SHAPE_CATEGORIES.map((c) => {
              const list = shapesIn(c)
              if (!list.length) return null
              const isOpen = open.has(c)
              return (
                <div key={c} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleCat(c)}
                    data-testid={`map-stencil-cat-${catSlug(c)}`}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-1 px-0.5 py-1.5 text-[11px] font-semibold text-[var(--ink-80)] hover:text-[var(--ink-100)]"
                  >
                    <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={14} />
                    <span className="flex-1 text-left">{c}</span>
                    <span className="text-[10px] font-normal text-[var(--ink-40)]">{list.length}</span>
                  </button>
                  {isOpen && grid(list.map((s) => s.id))}
                </div>
              )
            })}
            <p className="text-[10px] text-[var(--ink-40)] px-1 pt-2">Right-click a shape to add it to Favourites. Drag to place it exactly.</p>
          </>
        )}
      </div>
    </>
  )
}

function IconsTab({ cmd, readOnly }: { cmd: Commands; readOnly: boolean }): JSX.Element {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '_')
    const list = q ? ICON_NAMES.filter((n) => n.includes(q)) : ICON_NAMES
    return { total: list.length, shown: list.slice(0, 240) }
  }, [query])
  return (
    <>
      <div className="shrink-0 px-2 py-2">
        <div className="relative">
          <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={`Search ${ICON_NAMES.length.toLocaleString()} icons`}
            data-testid="diagram-icon-search"
            className="fb-field w-full h-7 pl-7 pr-2 text-[12px]"
          />
        </div>
        <div className="text-[10px] text-[var(--ink-50)] mt-1">
          {matches.total.toLocaleString()} icon{matches.total === 1 ? '' : 's'}
          {matches.total > matches.shown.length ? ` · showing ${matches.shown.length}, refine the search` : ''}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        <div className="grid grid-cols-6 gap-0.5">
          {matches.shown.map((n) => (
            <button
              key={n}
              type="button"
              title={n.replace(/_/g, ' ')}
              disabled={readOnly}
              draggable={!readOnly}
              data-testid={`diagram-icon-${n}`}
              onDragStart={(e) => e.dataTransfer.setData('application/x-plexii-icon', n)}
              onClick={() => cmd.addIcon(n)}
              className="h-9 rounded flex items-center justify-center text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)]"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                {n}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function ImagesTab({ cmd, readOnly }: { cmd: Commands; readOnly: boolean }): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="px-3 py-3 space-y-3 text-[12px]">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) void cmd.addImageFiles(files)
        }}
      />
      <button type="button" disabled={readOnly} onClick={() => fileRef.current?.click()} className="btn-primary w-full h-8 text-[12px] inline-flex items-center justify-center gap-1.5" data-testid="diagram-image-upload">
        <Icon name="upload" size={15} />
        Upload images
      </button>
      <div>
        <div className="text-[11px] text-[var(--ink-60)] mb-1">Or add from a link</div>
        <div className="flex gap-1">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="https://…/image.png"
            className="fb-field flex-1 h-7 px-2 text-[12px] min-w-0"
            data-testid="diagram-image-url"
          />
          <button
            type="button"
            disabled={readOnly || !url.trim()}
            onClick={() => {
              const u = url.trim()
              if (!/^(https?:|data:image\/)/i.test(u)) {
                setError('Use an http(s) link to an image.')
                return
              }
              setError(null)
              cmd.addImageUrl(u)
              setUrl('')
            }}
            className="h-7 px-2 rounded bg-[var(--surface-sunken)] text-[12px] disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {error && <div className="text-[11px] text-red-600 mt-1">{error}</div>}
      </div>
      <p className="text-[11px] text-[var(--ink-50)] leading-relaxed">
        You can also drag image files onto the canvas, or paste an image (⌘V). Images up to 2.5 MB are stored inside the diagram.
      </p>
    </div>
  )
}
