import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import {
  tilesFor,
  tileUrl,
  pointAt,
  panBy,
  osmLink,
  OSM_ATTRIBUTION,
  TILE,
  type LatLon
} from '../../lib/slippyMap'

// A real map of a real place.
//
// The address is geocoded against OpenStreetMap's Nominatim and the tiles come
// from OSM's standard layer, so what is on screen is the actual street. There
// is no offline fallback picture and no approximate pin: if the address cannot
// be found, the widget says the address cannot be found. A map that shows the
// wrong building confidently is worse than one that admits it doesn't know.
//
// It draws its own tile grid rather than embedding a map page because the app's
// CSP permits `img-src https:` but not framing third-party pages -- and a tile
// grid is what a slippy map is anyway. See lib/slippyMap.ts.

interface MapContent {
  /** What the user typed. */
  query?: string
  /** What Nominatim resolved it to -- kept so the map opens without a lookup. */
  lat?: number
  lon?: number
  /** The matched place's full name, shown so a wrong match is visible. */
  label?: string
  zoom?: number
}

function parse(raw: string | null | undefined): MapContent {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as MapContent
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

type Lookup =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'not-found'; query: string }
  | { state: 'error'; error: string }

interface NominatimHit {
  lat: string
  lon: string
  display_name: string
}

/**
 * Geocode an address.
 *
 * Nominatim asks that clients identify themselves and stay under one request a
 * second. This only ever runs on an explicit search -- never on a keystroke,
 * never on a pan -- which keeps a widget from becoming a crawler.
 */
async function geocode(query: string, signal: AbortSignal): Promise<NominatimHit | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' +
    encodeURIComponent(query)
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  const hits = (await res.json()) as NominatimHit[]
  return hits?.[0] ?? null
}

export default function LocationMapWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const model = useMemo(() => parse(widget.content), [widget.content])

  const [draft, setDraft] = useState(model.query ?? '')
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' })
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [failedTiles, setFailedTiles] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // The pinned place, and the (possibly panned-away) view centre. Panning moves
  // the view without moving the pin -- the pin is the answer to the address,
  // and a drag should never silently change it.
  const pin: LatLon | null =
    typeof model.lat === 'number' && typeof model.lon === 'number'
      ? { lat: model.lat, lon: model.lon }
      : null
  const [centre, setCentre] = useState<LatLon | null>(pin)
  const [zoom, setZoom] = useState(model.zoom ?? 16)

  useEffect(() => {
    if (pin && !centre) setCentre(pin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lon])

  // The tile grid must match the rendered size, which the user can resize.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setBox({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    setBox({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  const search = useCallback(
    async (query: string): Promise<void> => {
      const q = query.trim()
      if (!q) return
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setLookup({ state: 'searching' })
      setFailedTiles(0)
      try {
        const hit = await geocode(q, ac.signal)
        if (ac.signal.aborted) return
        if (!hit) {
          setLookup({ state: 'not-found', query: q })
          return
        }
        const found = { lat: Number(hit.lat), lon: Number(hit.lon) }
        setLookup({ state: 'idle' })
        setCentre(found)
        void update(widget.id, {
          content: JSON.stringify({
            ...model,
            query: q,
            lat: found.lat,
            lon: found.lon,
            label: hit.display_name,
            zoom
          })
        })
      } catch (e) {
        if (ac.signal.aborted) return
        setLookup({
          state: 'error',
          error: e instanceof Error ? e.message : String(e)
        })
      }
    },
    [update, widget.id, model, zoom]
  )

  const setZoomSaved = (z: number): void => {
    const next = Math.max(2, Math.min(19, z))
    setZoom(next)
    void update(widget.id, { content: JSON.stringify({ ...model, zoom: next }) })
  }

  // Drag to pan. Pointer capture keeps the gesture even when the cursor leaves
  // the widget, and stopPropagation keeps the canvas from dragging the widget
  // itself while the user is dragging the map inside it.
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    if (!centre) return
    e.stopPropagation()
    dragRef.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const start = dragRef.current
    if (!start || !centre) return
    e.stopPropagation()
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (dx === 0 && dy === 0) return
    dragRef.current = { x: e.clientX, y: e.clientY }
    setCentre(panBy(centre, zoom, dx, dy))
  }
  const endDrag = (e: React.PointerEvent): void => {
    if (!dragRef.current) return
    e.stopPropagation()
    dragRef.current = null
  }

  const tiles = useMemo(
    () => (centre && box.width > 0 ? tilesFor(centre, zoom, box.width, box.height) : []),
    [centre, zoom, box.width, box.height]
  )
  const pinAt =
    pin && centre && box.width > 0 ? pointAt(pin, centre, zoom, box.width, box.height) : null
  const pinOffScreen =
    pinAt !== null &&
    (pinAt.left < 0 || pinAt.top < 0 || pinAt.left > box.width || pinAt.top > box.height)

  const openExternal = (): void => {
    if (!centre) return
    const href = osmLink(centre, zoom)
    const api = (window as { api?: { files?: { openExternal?: (u: string) => void } } }).api
    if (api?.files?.openExternal) api.files.openExternal(href)
    else window.open(href, '_blank', 'noopener')
  }

  return (
    <WidgetFrame
      widget={widget}
      headerLabel="Map"
      headerAccent="bg-teal-200/50 dark:bg-teal-400/10"
    >
      <div className="flex h-full flex-col bg-[var(--surface)]">
        <form
          className="flex items-center gap-1 border-b border-[var(--line)] px-2 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void search(draft)
          }}
        >
          <Icon name="location_on" className="text-[14px] text-[var(--ink-40)]" />
          <input
            className="widget-nodrag min-w-0 flex-1 bg-transparent text-[12px] text-[var(--ink-80)] outline-none placeholder:text-[var(--ink-35)]"
            placeholder="Search an address or place"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="widget-nodrag grid h-6 w-6 place-items-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            title="Find"
            disabled={lookup.state === 'searching'}
          >
            <Icon
              name={lookup.state === 'searching' ? 'hourglass_empty' : 'search'}
              className="text-[14px]"
            />
          </button>
        </form>

        <div
          ref={hostRef}
          className="widget-nodrag relative flex-1 select-none overflow-hidden bg-[var(--surface-sunken)]"
          style={{ cursor: centre ? 'grab' : 'default', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={(e) => {
            if (!centre) return
            e.stopPropagation()
            setZoomSaved(zoom + (e.deltaY < 0 ? 1 : -1))
          }}
        >
          {tiles.map((t) => (
            <img
              key={`${t.z}/${t.x}/${t.y}/${t.left}`}
              src={tileUrl(t)}
              alt=""
              draggable={false}
              width={TILE}
              height={TILE}
              onError={() => setFailedTiles((n) => n + 1)}
              style={{
                position: 'absolute',
                left: `${t.left}px`,
                top: `${t.top}px`,
                width: `${TILE}px`,
                height: `${TILE}px`,
                pointerEvents: 'none'
              }}
            />
          ))}

          {pinAt && !pinOffScreen && (
            <div
              className="pointer-events-none absolute"
              style={{ left: `${pinAt.left}px`, top: `${pinAt.top}px` }}
            >
              <div className="-translate-x-1/2 -translate-y-full drop-shadow">
                <Icon name="location_on" className="text-[30px] text-rose-600" />
              </div>
            </div>
          )}

          {/* Panned away from the pin: offer the way back rather than leaving
              the user to find a building by hand. */}
          {pin && pinOffScreen && (
            <button
              type="button"
              className="widget-nodrag absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[color-mix(in_oklab,var(--surface)_95%,transparent)] px-2 py-1 text-[10px] text-[var(--ink-70)] shadow ring-1 ring-[var(--line)]"
              onClick={() => setCentre(pin)}
            >
              Back to {model.query || 'the pin'}
            </button>
          )}

          {centre && (
            <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
              <MapBtn icon="add" title="Zoom in" onClick={() => setZoomSaved(zoom + 1)} />
              <MapBtn icon="remove" title="Zoom out" onClick={() => setZoomSaved(zoom - 1)} />
              <MapBtn icon="open_in_new" title="Open in OpenStreetMap" onClick={openExternal} />
            </div>
          )}

          {!centre && (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
              <Icon name="map" className="text-[24px] text-[var(--ink-30)]" />
              {lookup.state === 'searching' ? (
                <span className="text-[12px] text-[var(--ink-60)]">Looking it up…</span>
              ) : lookup.state === 'not-found' ? (
                <>
                  <span className="text-[12px] font-medium text-[var(--ink-70)]">
                    No match for “{lookup.query}”
                  </span>
                  <span className="text-[11px] text-[var(--ink-45)]">
                    Try adding the suburb or postcode.
                  </span>
                </>
              ) : lookup.state === 'error' ? (
                <>
                  <span className="text-[12px] font-medium text-[var(--ink-70)]">
                    Couldn’t reach the map service
                  </span>
                  <span className="text-[11px] text-[var(--ink-45)]">{lookup.error}</span>
                </>
              ) : (
                <span className="text-[11px] text-[var(--ink-45)]">
                  Search an address to put it on the map.
                </span>
              )}
            </div>
          )}

          {/* Tiles are images over the network. When they don't arrive, say so
              -- an empty grey rectangle otherwise reads as "nothing here". */}
          {centre && failedTiles > 0 && tiles.length > 0 && failedTiles >= tiles.length && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[color-mix(in_oklab,var(--surface)_90%,transparent)] px-6 text-center">
              <Icon name="wifi_off" className="text-[20px] text-[var(--ink-40)]" />
              <span className="text-[11px] text-[var(--ink-60)]">
                Map tiles couldn’t load. The location is saved.
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 border-t border-[var(--line)] px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--ink-45)]">
            {model.label || (centre ? 'Dropped pin' : '')}
          </span>
          <span className="shrink-0 text-[9px] text-[var(--ink-35)]">{OSM_ATTRIBUTION}</span>
        </div>
      </div>
    </WidgetFrame>
  )
}

function MapBtn({
  icon,
  title,
  onClick
}: {
  icon: string
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="widget-nodrag grid h-6 w-6 place-items-center rounded bg-[color-mix(in_oklab,var(--surface)_95%,transparent)] text-[var(--ink-60)] shadow ring-1 ring-[var(--line)] hover:text-[var(--ink-90)]"
    >
      <Icon name={icon} className="text-[14px]" />
    </button>
  )
}
