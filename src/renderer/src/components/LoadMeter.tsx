import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWidgetStore } from '../stores/widgets'
import { chimeOut, chimeIn } from '../lib/audioBeep'
import Icon from './Icon'

// Cognitive Load = a weighted count of "things demanding attention" on the canvas.
// Tuned so a single browser feels heavier than a single sticky.
const KIND_WEIGHT: Record<string, number> = {
  webview: 1.5,
  pdf: 1.5,
  gdoc: 1.3,
  gsheet: 1.3,
  gslide: 1.3,
  email: 1.3,
  video: 1.2,
  markdown: 1.1,
  note: 1.0,
  sticky: 0.7,
  timer: 0.6,
  calculator: 0.5,
  color: 0.4,
  image: 0.6,
  section: 0.5
}

interface LoadTier {
  label: string
  color: string
  bg: string
  cap: number
}

const TIERS: LoadTier[] = [
  { label: 'Light', color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-500', cap: 5 },
  { label: 'Comfortable', color: 'text-sky-700 dark:text-sky-400', bg: 'bg-sky-500', cap: 9 },
  { label: 'Heavy', color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-500', cap: 14 },
  { label: 'Overloaded', color: 'text-red-700 dark:text-red-400', bg: 'bg-red-500', cap: Infinity }
]

function tierForLoad(load: number): LoadTier {
  for (const t of TIERS) if (load <= t.cap) return t
  return TIERS[TIERS.length - 1]
}

function tierIndexForLoad(load: number): number {
  for (let i = 0; i < TIERS.length; i++) if (load <= TIERS[i].cap) return i
  return TIERS.length - 1
}

/**
 * How far PAST overloaded, 0..1.
 *
 * The tier alone cannot answer "more overloaded": everything from 15 widgets
 * to fifty read as the same flat "Overloaded". This saturates one tier-width
 * beyond the threshold, so the alarm keeps growing while the desk keeps
 * filling and then stops — an indicator that grew without limit would end up
 * larger than the button it sits beside.
 */
function overloadDepth(load: number): number {
  const heavyCap = TIERS[TIERS.length - 2].cap
  return Math.max(0, Math.min(1, (load - heavyCap) / heavyCap))
}

/**
 * The alarm's size and urgency for a given load.
 *
 * Both scale: a heavier desk gets a bigger light AND a faster one, because
 * size alone is easy to stop noticing once it stops changing.
 */
function alarmFor(load: number): {
  size: number
  rings: number
  spin: number
  loud: boolean
} {
  const idx = tierIndexForLoad(load)
  const depth = overloadDepth(load)
  const base = [9, 11, 14, 17][idx] ?? 9
  return {
    size: Math.round(base + depth * 6),
    // Light/Comfortable sit still: an indicator that animates when nothing is
    // wrong teaches you to ignore it.
    rings: idx < 2 ? 0 : idx === 2 ? 1 : 2,
    // Seconds per pulse — 1.6s at Heavy down to 0.55s deep into Overloaded.
    spin: idx < 2 ? 0 : Number((1.6 - (idx === 3 ? 0.5 + depth * 0.55 : 0)).toFixed(2)),
    loud: idx === 3
  }
}

export default function LoadMeter({
  variant = 'pill'
}: {
  /**
   * 'header' is the prominent one, centred beside Add widget. The meter used
   * to be a 3px dot in the bottom pill, which is where you look least and is
   * why an overloaded desk could go unnoticed — the operator asked for it
   * where the eye already is.
   */
  variant?: 'pill' | 'header'
} = {}): JSX.Element {
  const widgets = useWidgetStore((s) => s.widgets)
  const restore = useWidgetStore((s) => s.restore)
  const parkAll = useWidgetStore((s) => s.parkAll)
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  const visible = widgets.filter((w) => !w.archived)
  const archived = widgets.filter((w) => w.archived)
  const load = visible.reduce((sum, w) => sum + (KIND_WEIGHT[w.kind] ?? 1), 0)
  const tier = tierForLoad(load)

  async function handlePark(): Promise<void> {
    const count = await parkAll(true)
    if (count > 0) chimeOut()
    setOpen(false)
  }

  async function handleRestore(id: string): Promise<void> {
    await restore(id)
    chimeIn()
  }

  const alarm = alarmFor(load)
  const header = variant === 'header'
  // At Heavy and above the tier is named, not just coloured: a colour alone
  // asks the viewer to remember a legend.
  const showLabel = header && tierIndexForLoad(load) >= 2

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        data-testid="load-meter"
        data-tier={tier.label.toLowerCase()}
        data-load={Math.round(load)}
        className={`inline-flex items-center rounded-lg transition-colors ${
          header ? 'gap-2 px-2.5 h-8' : 'gap-1.5 px-2 py-1'
        } ${
          alarm.loud && header
            ? 'bg-red-500/10 border border-red-500/40 hover:bg-red-500/15'
            : header
              ? 'border border-transparent hover:bg-[var(--surface-sunken)]'
              : 'hover:bg-[var(--surface-sunken)]'
        }`}
        title={`Cognitive load: ${tier.label} (${load.toFixed(1)} weighted) — click to park widgets`}
      >
        {/* The alarm light. Sized and paced from the real load, so it grows and
            quickens as the desk fills rather than switching between two
            states. */}
        <span
          className="relative inline-flex items-center justify-center shrink-0"
          style={{ height: alarm.size, width: alarm.size }}
        >
          {alarm.rings > 0 && (
            <span
              className={`absolute inset-[-4px] rounded-full ${tier.bg} opacity-25 animate-ping`}
              style={{ animationDuration: `${alarm.spin}s` }}
            />
          )}
          {alarm.rings > 1 && (
            <span
              className={`absolute inset-[-8px] rounded-full ${tier.bg} opacity-15 animate-ping`}
              style={{ animationDuration: `${alarm.spin * 1.35}s`, animationDelay: '0.2s' }}
            />
          )}
          <span
            className={`absolute inset-0 rounded-full ${tier.bg}`}
            style={{
              opacity: alarm.loud ? 1 : 0.8,
              boxShadow: alarm.loud ? '0 0 10px 2px rgb(239 68 68 / 0.55)' : undefined
            }}
          />
        </span>
        <span
          className={`font-mono tabular-nums ${tier.color} ${
            header ? (alarm.loud ? 'text-[14px] font-bold' : 'text-[13px] font-semibold') : 'text-[11px]'
          }`}
        >
          {Math.round(load)}
        </span>
        {showLabel && (
          <span className={`text-[11px] font-semibold ${tier.color} whitespace-nowrap`}>
            {tier.label}
          </span>
        )}
        {archived.length > 0 && (
          <span className="text-[10px] text-[var(--ink-50)]">
            +{archived.length}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <LoadMeterPopover
            load={load}
            tier={tier}
            visibleCount={visible.length}
            archived={archived.map((w) => ({ id: w.id, kind: w.kind, title: w.title }))}
            anchorEl={btnRef.current}
            onClose={() => setOpen(false)}
            onPark={handlePark}
            onRestore={handleRestore}
          />,
          document.body
        )}
    </>
  )
}

interface PopoverProps {
  load: number
  tier: LoadTier
  visibleCount: number
  archived: Array<{ id: string; kind: string; title: string }>
  anchorEl: HTMLElement | null
  onClose: () => void
  onPark: () => Promise<void>
  onRestore: (id: string) => Promise<void>
}

function LoadMeterPopover({
  load,
  tier,
  visibleCount,
  archived,
  anchorEl,
  onClose,
  onPark,
  onRestore
}: PopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    function onClick(e: MouseEvent): void {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && anchorEl !== t) onClose()
    }
    window.addEventListener('keydown', onKey)
    const armId = window.setTimeout(() => window.addEventListener('mousedown', onClick), 50)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.clearTimeout(armId)
    }
  }, [onClose, anchorEl])

  const rect = anchorEl?.getBoundingClientRect()
  const style: React.CSSProperties = rect
    ? { top: rect.bottom + 6, right: window.innerWidth - rect.right }
    : { top: 60, right: 12 }

  // Visual gauge fill: load relative to "heavy" cap so users see the cliff coming
  const gaugePct = Math.min(100, Math.round((load / 14) * 100))

  return (
    <div
      ref={ref}
      className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in fixed z-[180] w-80"
      style={style}
    >
      <div className="px-3 py-2 border-b border-[var(--edge-soft)] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon name="speed" size={14} className={tier.color} />
          <span className="text-[12px] font-semibold text-[var(--ink-100)]">
            Cognitive load
          </span>
        </div>
        <span className={`text-[11px] font-mono ${tier.color}`}>{tier.label}</span>
      </div>

      <div className="px-3 py-3">
        <div className="h-2 w-full rounded-full bg-[var(--surface-sunken)] overflow-hidden mb-2">
          <div
            className={`h-full ${tier.bg} transition-all duration-300`}
            style={{ width: `${gaugePct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between text-[11px] text-[var(--ink-70)]">
          <span>
            <span className="font-semibold text-[var(--ink-100)] tabular-nums">
              {visibleCount}
            </span>{' '}
            widget{visibleCount === 1 ? '' : 's'} visible
          </span>
          <span className="font-mono tabular-nums">{load.toFixed(1)} weighted</span>
        </div>

        <button
          onClick={onPark}
          disabled={visibleCount <= 1}
          className="mt-3 w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-md btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Icon name="inventory_2" size={14} />
          <span>Park everything except the active widget</span>
        </button>
        <p className="mt-1.5 text-[10px] text-[var(--ink-50)] text-center leading-snug">
          Hides widgets from the canvas — restore any of them below or later.
        </p>
      </div>

      {archived.length > 0 && (
        <div className="border-t border-[var(--edge-soft)] px-3 py-2 max-h-56 overflow-auto">
          <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-1.5">
            Parked ({archived.length})
          </div>
          <div className="space-y-0.5">
            {archived.map((w) => (
              <button
                key={w.id}
                onClick={() => void onRestore(w.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] transition-colors group"
              >
                <Icon
                  name="unarchive"
                  size={13}
                  className="text-[var(--ink-40)] group-hover:text-accent shrink-0"
                />
                <span className="truncate flex-1 min-w-0">
                  {w.title || <em className="text-[var(--ink-40)]">{w.kind}</em>}
                </span>
                <span className="text-[10px] text-[var(--ink-40)] font-mono shrink-0">
                  {w.kind}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
