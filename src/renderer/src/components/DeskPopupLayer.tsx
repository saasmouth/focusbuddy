import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from './Icon'
import {
  CARD_HEADER_PX,
  cardLayout,
  popupHostLabel,
  popupTitleLabel,
  type DeskPopupInfo
} from '@shared/deskPopup'

// Web pop-ups on the desk.
//
// A sign-in or scripted pop-up from a desk browser object or a connected app is
// hosted by main as a native view inside this window (deskPopups.ts). Native
// views always paint above the page, so this layer draws everything AROUND the
// page — the dimmed backdrop, the card, its header — and leaves an empty slot
// where the page goes, reporting the slot's rect to main every time it moves.
//
// The layer covers the content area it is mounted in (the desk / segment pane),
// not the app header or footer. Cards stack in open order, last on top; a lower
// card's header peeks out and clicking it brings that card forward. Esc or the
// close button closes the top card; a page that calls window.close() or blanks
// itself after a hand-off removes its own card from main.

type Api = NonNullable<typeof window.api>['deskPopups']

function popupApi(): Api | null {
  try {
    return window.api?.deskPopups ?? null
  } catch {
    return null
  }
}

export default function DeskPopupLayer(): JSX.Element {
  const [popups, setPopups] = useState<DeskPopupInfo[]>([])
  // A marker in the pane: the layer covers the marker's PARENT. It is laid out
  // `fixed` over that rect rather than `absolute` so the pane does not have to
  // become a positioned element — making it one would re-anchor every
  // absolutely positioned descendant of every view it hosts.
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0
  })

  useEffect(() => {
    const api = popupApi()
    if (!api) return
    let alive = true
    // Pop-ups outlive this component (it remounts when the pane switches
    // between the desk and a segment), so start from main's list.
    api
      .list()
      .then((list) => {
        if (alive) setPopups(list)
      })
      .catch(() => {})
    const offs = [
      api.onOpened((info) => setPopups((p) => (p.some((x) => x.id === info.id) ? p : [...p, info]))),
      api.onUpdated((info) => setPopups((p) => p.map((x) => (x.id === info.id ? { ...x, ...info } : x)))),
      api.onClosed(({ id }) => setPopups((p) => p.filter((x) => x.id !== id)))
    ]
    return () => {
      alive = false
      for (const off of offs) off()
    }
  }, [])

  // The area the cards are laid out in: the pane, in viewport coordinates.
  const open = popups.length > 0
  useLayoutEffect(() => {
    const pane = anchorRef.current?.parentElement
    if (!open || !pane) return
    const measure = (): void => {
      const r = pane.getBoundingClientRect()
      setFrame((f) =>
        f.left === r.left && f.top === r.top && f.width === r.width && f.height === r.height
          ? f
          : { left: r.left, top: r.top, width: r.width, height: r.height }
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(pane)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])

  const close = useCallback((id: string) => {
    setPopups((p) => p.filter((x) => x.id !== id))
    void popupApi()?.close(id).catch(() => {})
  }, [])

  const bringToFront = useCallback((id: string) => {
    setPopups((p) => {
      const i = p.findIndex((x) => x.id === id)
      if (i < 0 || i === p.length - 1) return p
      const next = p.slice()
      const [moved] = next.splice(i, 1)
      next.push(moved)
      return next
    })
    void popupApi()?.focus(id).catch(() => {})
  }, [])

  // Esc on the desk closes the top card. (Esc inside the pop-up page is heard
  // by main, which closes it the same way.)
  useEffect(() => {
    if (popups.length === 0) return
    const top = popups[popups.length - 1]
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close(top.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [popups, close])

  const area = { width: frame.width, height: frame.height }
  return (
    <>
      <span ref={anchorRef} hidden aria-hidden="true" />
      {open && (
        <div
          className="fixed z-[200] bg-black/40"
          style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
          data-testid="desk-popup-layer"
          // The backdrop deliberately does not close on click: a stray click must
          // never abort a sign-in half-way through.
        >
          {area.width > 0 &&
            popups.map((p, i) => (
              <DeskPopupCard
                key={p.id}
                info={p}
                index={i}
                isTop={i === popups.length - 1}
                area={area}
                onClose={close}
                onFocus={bringToFront}
              />
            ))}
        </div>
      )}
    </>
  )
}

function DeskPopupCard(props: {
  info: DeskPopupInfo
  index: number
  isTop: boolean
  area: { width: number; height: number }
  onClose: (id: string) => void
  onFocus: (id: string) => void
}): JSX.Element {
  const { info, index, isTop, area, onClose, onFocus } = props
  const slotRef = useRef<HTMLDivElement | null>(null)
  const layout = cardLayout(area, { width: info.preferredWidth, height: info.preferredHeight }, index)
  const title = popupTitleLabel(info.title, info.url)
  const host = popupHostLabel(info.url)

  // Report the slot to main whenever it moves or resizes. A ResizeObserver
  // misses pure moves (the sidebar collapsing shifts the pane without resizing
  // the card), so this follows the slot every frame and only crosses IPC when
  // the rect actually changed — a handful of calls per layout change, none at
  // rest.
  useEffect(() => {
    const api = popupApi()
    if (!api) return
    let raf = 0
    let last = ''
    const tick = (): void => {
      const el = slotRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const key = `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`
        if (key !== last) {
          last = key
          void api
            .setBounds(info.id, { x: r.left, y: r.top, width: r.width, height: r.height })
            .catch(() => {})
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [info.id])

  return (
    <div
      role="dialog"
      aria-label={title}
      aria-modal={isTop ? 'true' : undefined}
      className="absolute flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface-raised)] shadow-2xl ring-1 ring-black/10"
      style={{ left: layout.left, top: layout.top, width: layout.width, height: layout.height }}
      data-testid="desk-popup-card"
      data-popup-id={info.id}
      data-top={isTop ? 'true' : 'false'}
      onMouseDown={() => {
        if (!isTop) onFocus(info.id)
      }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-3"
        style={{ height: CARD_HEADER_PX }}
      >
        <Icon name="lock" size={14} className="shrink-0 text-[var(--ink-50)]" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-semibold text-[var(--ink-90)]" data-testid="desk-popup-title">
            {title}
          </div>
          {host && (
            <div className="truncate text-[10.5px] text-[var(--ink-50)]" data-testid="desk-popup-host">
              {host}
            </div>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
          aria-label="Open in browser"
          title="Open in your browser"
          data-testid="desk-popup-open-external"
          onClick={(e) => {
            e.stopPropagation()
            void popupApi()?.openExternal(info.id).catch(() => {})
          }}
        >
          <Icon name="open_in_new" size={15} />
        </button>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
          aria-label="Close pop-up"
          title="Close (Esc)"
          data-testid="desk-popup-close"
          onClick={(e) => {
            e.stopPropagation()
            onClose(info.id)
          }}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {/* The page itself is a native view main places exactly over this slot.
          What is drawn here only shows before the page's first paint. */}
      <div
        ref={slotRef}
        className="flex min-h-0 flex-1 items-center justify-center bg-white text-[11px] text-[var(--ink-40)]"
        data-testid="desk-popup-slot"
      >
        {isTop ? 'Loading…' : 'Click to bring this pop-up forward'}
      </div>
    </div>
  )
}
