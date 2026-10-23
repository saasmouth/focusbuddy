import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../../Icon'
import { BarPopover, barTip, useBarSlot } from '../../office/shell'
import {
  customDesignSize,
  describeSize,
  fromPx,
  startMenuGroups,
  toPx,
  type SizeUnit
} from '@shared/designStartMenu'
import type { DesignSize } from '@shared/design'

// One control for "what is this page, and what starts on it": every template
// and every page size, grouped, plus a custom size.
//
// It replaces two things: a grid of template chips that sat ON the canvas (the
// owner: "please find a solution to this wasted real estate") and a separate
// size panel. Two controls for "how big is this page" was one too many, and a
// permanent grid for a choice you make once was the wrong shape entirely.
//
// SELF-CONTAINED on purpose. It renders its own trigger, owns its open state
// and its custom-size form, and takes nothing from the menu bar around it —
// so when the office apps move onto the shared shell it can be dropped into
// the new top bar without being rewritten.

interface Props {
  /** The page size now, for the trigger and as the custom form's starting point. */
  size: { w: number; h: number }
  /** Apply a composed template (which brings its own size). */
  onTemplate: (templateId: string) => void
  /** Change the page size only, keeping the artwork. */
  onSize: (size: DesignSize) => void
  /**
   * Open once, unprompted, on a brand-new empty design. The chip grid used to
   * be the first-run help by simply always being there; this is the same help
   * without the permanent cost.
   *
   * The "once" is the EDITOR'S to remember, not this component's: the control
   * unmounts whenever another ContextBar tab is shown, so a flag held here
   * re-fires every time someone comes back to the Layout tab — the menu would
   * spring open again and again, and a click meant to open it would toggle it
   * shut instead.
   */
  autoOpen?: boolean
  /** Told once, when the unprompted opening has happened. */
  onAutoOpened?: () => void
}

export default function StartFromMenu({ size, onTemplate, onSize, autoOpen, onAutoOpened }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const groups = useMemo(() => startMenuGroups(), [])
  const trigger = useRef<HTMLButtonElement | null>(null)
  const firstEntry = useRef<HTMLButtonElement | null>(null)
  const opened = useRef(false)
  // In a read-only bar its slot (Layout › Start from) is off: it applies a
  // template or a size, which writes the design. It shows the size; it does
  // not open, and says why.
  const slot = useBarSlot()
  const off = slot.disabled
  useEffect(() => {
    if (off) setOpen(false)
  }, [off])

  // Put focus in the menu when it opens. Keyboard users land on the list
  // rather than nowhere, and Escape closes it — BarPopover handles Escape on
  // its own element and registers no document listener (SPEC §2.4), so with
  // focus left on the canvas the key went to the editor's handler instead and
  // the menu stayed open. That is also what a mouse user expects.
  useEffect(() => {
    if (open) firstEntry.current?.focus()
  }, [open])

  useEffect(() => {
    if (autoOpen && !off && !opened.current) {
      opened.current = true
      setOpen(true)
      onAutoOpened?.()
    }
  }, [autoOpen, off, onAutoOpened])

  // No outside-click or Escape handling here: BarPopover owns both, and it
  // must, because the panel is PORTALLED to the body. The handler this
  // replaces watched for mousedown outside the component's own wrapper — and
  // the portalled panel is outside it, so pressing any entry closed the menu
  // before the click could land. Every row looked dead.

  function choose(fn: () => void): void {
    fn()
    setOpen(false)
    setCustom(false)
  }

  return (
    <div className="relative">
      <button
        ref={trigger}
        onClick={() => !off && setOpen((v) => !v)}
        disabled={off}
        className="fb-btn-surface inline-flex h-7 items-center gap-1 rounded px-2 text-[12px] text-[var(--ink-80)] hover:border-accent disabled:opacity-60 disabled:cursor-not-allowed"
        title={barTip('Start from a template, or set the page size', undefined, off ? slot.reason : undefined)}
        data-testid="design-start-btn"
      >
        <Icon name="dashboard_customize" size={14} />
        <span className="fb-tabular">{describeSize(size.w, size.h)}</span>
        <Icon name="expand_more" size={14} className="text-[var(--ink-40)]" />
      </button>

      {open && !off && (
        <BarPopover
          anchor={trigger.current}
          onClose={() => {
            setOpen(false)
            setCustom(false)
          }}
          label="Start from"
          testid="design-start-menu"
          minWidth={288}
        >
          <div className="max-h-[70vh] w-72 overflow-auto py-1">
          <p className="px-3 py-1 fb-t-caption text-[var(--ink-40)] leading-snug">
            A template brings a layout and its size. A size changes the page and keeps your work.
          </p>

          {groups.map((g, gi) => (
            <section key={g.id}>
              <div className="px-3 pt-1.5 pb-0.5 fb-t-caption uppercase tracking-wide text-[var(--ink-40)]">
                {g.label}
              </div>
              {g.entries.map((e, i) => (
                <button
                  key={`${e.kind}-${e.id}`}
                  ref={gi === 0 && i === 0 ? firstEntry : undefined}
                  onClick={() =>
                    choose(() =>
                      e.kind === 'template'
                        ? onTemplate(e.id)
                        : onSize({ id: e.id, category: g.id, label: e.label, w: e.w, h: e.h })
                    )
                  }
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
                  data-testid={e.kind === 'template' ? `design-template-${e.id}` : `design-size-${e.id}`}
                >
                  <Icon
                    name={e.kind === 'template' ? 'dashboard' : 'crop_free'}
                    size={14}
                    className={e.kind === 'template' ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-40)]'}
                  />
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  <span className="fb-t-caption fb-tabular text-[var(--ink-40)]">{describeSize(e.w, e.h)}</span>
                </button>
              ))}
            </section>
          ))}

          <div className="mt-1 border-t border-[var(--edge-soft)] pt-1">
            {custom ? (
              <CustomSize current={size} onCancel={() => setCustom(false)} onApply={(s) => choose(() => onSize(s))} />
            ) : (
              <button
                onClick={() => setCustom(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
                data-testid="design-size-custom"
              >
                <Icon name="straighten" size={14} className="text-[var(--ink-40)]" />
                <span>Custom size…</span>
              </button>
            )}
            </div>
          </div>
        </BarPopover>
      )}
    </div>
  )
}

/** Width, height, unit and orientation — the whole of a custom page. */
function CustomSize({
  current,
  onApply,
  onCancel
}: {
  current: { w: number; h: number }
  onApply: (size: DesignSize) => void
  onCancel: () => void
}): JSX.Element {
  const [unit, setUnit] = useState<SizeUnit>('px')
  const [w, setW] = useState(String(current.w))
  const [h, setH] = useState(String(current.h))
  const [error, setError] = useState<string | null>(null)

  /** Switching units converts what is typed, rather than reinterpreting it. */
  function changeUnit(next: SizeUnit): void {
    const wPx = toPx(Number(w), unit)
    const hPx = toPx(Number(h), unit)
    setUnit(next)
    if (wPx > 0) setW(String(fromPx(wPx, next)))
    if (hPx > 0) setH(String(fromPx(hPx, next)))
  }

  function apply(orientation?: 'portrait' | 'landscape'): void {
    const s = customDesignSize({ w: Number(w), h: Number(h), unit, orientation })
    if (!s) {
      setError('Give a width and height between 16px and 20000px.')
      return
    }
    onApply(s)
  }

  return (
    <div className="px-3 py-2" data-testid="design-custom-size">
      <div className="mb-1.5 fb-t-caption uppercase tracking-wide text-[var(--ink-40)]">Custom size</div>
      <div className="flex items-center gap-1.5">
        <input
          value={w}
          onChange={(e) => setW(e.target.value)}
          inputMode="decimal"
          aria-label="Width"
          className="fb-field w-16 px-1.5 py-1 text-[12px]"
          data-testid="design-custom-w"
        />
        <span className="text-[var(--ink-40)]">×</span>
        <input
          value={h}
          onChange={(e) => setH(e.target.value)}
          inputMode="decimal"
          aria-label="Height"
          className="fb-field w-16 px-1.5 py-1 text-[12px]"
          data-testid="design-custom-h"
        />
        <select
          value={unit}
          onChange={(e) => changeUnit(e.target.value as SizeUnit)}
          aria-label="Units"
          className="fb-field px-1.5 py-1 text-[12px]"
          data-testid="design-custom-unit"
        >
          <option value="px">px</option>
          <option value="mm">mm</option>
          <option value="in">in</option>
        </select>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          onClick={() => apply('portrait')}
          className="fb-btn-surface flex-1 px-2 py-1 text-[11px] hover:border-accent"
          data-testid="design-custom-portrait"
        >
          Portrait
        </button>
        <button
          onClick={() => apply('landscape')}
          className="fb-btn-surface flex-1 px-2 py-1 text-[11px] hover:border-accent"
          data-testid="design-custom-landscape"
        >
          Landscape
        </button>
        <button
          onClick={() => apply()}
          className="rounded bg-[rgb(var(--accent))] px-2.5 py-1 text-[11px] text-white"
          data-testid="design-custom-apply"
        >
          Apply
        </button>
      </div>
      {error && (
        <p className="mt-1 fb-t-caption text-rose-600 dark:text-rose-400" data-testid="design-custom-error">
          {error}
        </p>
      )}
      <button
        onClick={onCancel}
        className="mt-1 fb-t-caption text-[var(--ink-50)] underline"
        data-testid="design-custom-cancel"
      >
        Back to the list
      </button>
    </div>
  )
}
