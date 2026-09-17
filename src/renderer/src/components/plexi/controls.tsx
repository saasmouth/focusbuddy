/**
 * Plexii control primitives.
 *
 * The kit had eight display primitives (StatTile, RailCard, Ring, Sparkline…)
 * and no controls, which is why a grep finds 52 distinct hand-rolled spellings
 * of "a button". These are the missing half. Every one composes tokens only, so
 * all four themes work with no per-theme branch.
 *
 * They lean on plexi-kit.css for the parts CSS does better than React: focus
 * rings, press physics, popover enter/exit, container queries. Anything that
 * can be a stylesheet is one.
 */

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react'

/**
 * Joins class names, keeping only non-empty strings.
 *
 * The kit had no such helper, so components were doing `${a} ${b ?? ''}` and
 * shipping double spaces. The narrow filter matters: a guard like
 * `{count && 'is-full'}` evaluates to the NUMBER 0 when count is 0, and a
 * `filter(Boolean)` version would drop it while a naive join would emit the
 * literal class "0". Only strings survive here, so neither can happen.
 */
export function cn(...parts: unknown[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ')
}

export type Tone = 'accent' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'stone'

/** Tone → text colour. Backgrounds are always a wash of currentColor at the
 *  themed --fb-chip-wash alpha, so a call site passes one class, not three. */
const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  emerald: 'text-emerald-500 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  rose: 'text-rose-500 dark:text-rose-400',
  violet: 'text-violet-500 dark:text-violet-400',
  sky: 'text-sky-600 dark:text-sky-400',
  stone: 'text-ink-60'
}

// ── Button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'surface' | 'quiet' | 'danger'
export type ControlSize = 'sm' | 'md'

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white font-semibold shadow-soft hover:bg-accent-hover',
  surface: 'bg-surface-raised text-ink-90 shadow-card hover:shadow-card-hover',
  quiet: 'bg-transparent text-ink-70 hover:bg-surface-sunken hover:text-ink-100',
  danger:
    'bg-transparent text-rose-500 dark:text-rose-400 hover:bg-[color-mix(in_oklab,currentColor_12%,transparent)]'
}

const BTN_SIZE: Record<ControlSize, string> = {
  sm: 'h-7 px-2.5 text-[11.5px] gap-1.5 rounded-chip',
  md: 'h-8 px-3.5 text-[12.5px] gap-2 rounded-field'
}

/**
 * The one button. Replaces 52 hand-rolled signatures.
 *
 * `icon` is a leading node; `trailing` is usually a <Kbd>. Width comes from the
 * call site — deliberately, because the fb-field lesson was that a primitive
 * which sets its own width is wrong the moment it lands in a toolbar row.
 */
export function Button({
  variant = 'surface',
  size = 'md',
  icon,
  trailing,
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant
  size?: ControlSize
  icon?: ReactNode
  trailing?: ReactNode
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'plx-focus plx-press inline-flex select-none items-center justify-center whitespace-nowrap border-0 font-medium leading-none',
        'disabled:pointer-events-none disabled:opacity-45',
        BTN_SIZE[size],
        BTN_VARIANT[variant],
        className
      )}
    >
      {icon}
      {children}
      {trailing}
    </button>
  )
}

/** A square button holding one glyph. `label` is required — an icon-only
 *  control with no accessible name is the most common a11y defect in a canvas
 *  app, and the widget chrome is made entirely of these. */
export function IconButton({
  label,
  size = 'md',
  variant = 'quiet',
  className,
  children,
  ...rest
}: {
  label: string
  size?: ControlSize
  variant?: ButtonVariant
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(
        'plx-focus plx-press inline-grid place-items-center border-0',
        size === 'sm' ? 'h-6 w-6 rounded-chip' : 'h-8 w-8 rounded-field',
        BTN_VARIANT[variant],
        className
      )}
    >
      {children}
    </button>
  )
}

// ── Field ────────────────────────────────────────────────────────────────────

/** A labelled text input. Hint and error share one slot, because a field that
 *  shows both at once has never once been the clearest option. */
export function Field({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: {
  label?: string
  hint?: ReactNode
  error?: ReactNode
} & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  const auto = useId()
  const fid = id ?? auto
  const msg = error ?? hint
  return (
    <div className={cn('min-w-0', className)}>
      {label && (
        <label htmlFor={fid} className="mb-1.5 block text-[11.5px] font-semibold text-ink-80">
          {label}
        </label>
      )}
      <input
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={msg ? `${fid}-m` : undefined}
        {...rest}
        className={cn(
          'plx-field w-full px-3 py-2 text-[13px]',
          error && 'shadow-[0_0_0_1px_theme(colors.rose.400)]'
        )}
      />
      {msg && (
        <p
          id={`${fid}-m`}
          className={cn(
            'mt-1.5 text-[11.5px]',
            error ? 'text-rose-500 dark:text-rose-400' : 'text-ink-50'
          )}
        >
          {msg}
        </p>
      )}
    </div>
  )
}

/** A textarea that grows with its content instead of scrolling inside a fixed
 *  box — `field-sizing: content`, capped at 14 lines in the stylesheet. This is
 *  the composer's single biggest quality-of-life win and costs one CSS line. */
export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea {...rest} className={cn('plx-field w-full px-3 py-2 text-[13px]', className)} />
}

// ── Toggles ──────────────────────────────────────────────────────────────────

/** A checkbox whose tick draws itself. No icon font, no SVG import. */
export function Checkbox({
  label,
  className,
  ...rest
}: { label?: ReactNode } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <label className={cn('group inline-flex cursor-pointer items-center gap-2.5', className)}>
      <span className="relative inline-grid h-[18px] w-[18px] place-items-center">
        <input type="checkbox" {...rest} className="peer plx-focus absolute inset-0 m-0 appearance-none rounded-chip shadow-[inset_0_0_0_1.5px_var(--edge-firm)] transition-all duration-quick ease-crisp checked:bg-accent checked:shadow-none" />
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className="pointer-events-none relative h-2.5 w-2.5 scale-50 text-white opacity-0 transition-all duration-quick ease-soft peer-checked:scale-100 peer-checked:opacity-100"
          fill="none"
          stroke="currentColor"
          strokeWidth={3.6}
          strokeLinecap="round"
        >
          <path d="M4 12l6 6L20 6" />
        </svg>
      </span>
      {label && <span className="text-[13px] text-ink-90">{label}</span>}
    </label>
  )
}

/** An on/off switch. The knob travels on a spring; the track colours on state. */
export function Switch({
  label,
  className,
  ...rest
}: { label?: ReactNode } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2.5', className)}>
      <input
        type="checkbox"
        role="switch"
        {...rest}
        className="peer plx-focus h-[22px] w-[38px] appearance-none rounded-full bg-surface-sunken shadow-[inset_0_0_0_1px_var(--edge-hairline)] transition-colors duration-base ease-crisp checked:bg-accent"
      />
      <span className="pointer-events-none -ml-[35px] h-4 w-4 rounded-full bg-white shadow-soft transition-transform duration-base ease-snap peer-checked:translate-x-4" />
      {label && <span className="ml-[21px] text-[13px] text-ink-90">{label}</span>}
    </label>
  )
}

// ── Segmented control ────────────────────────────────────────────────────────

/**
 * A segmented control whose selection slides. The moving pill is a single
 * ::before driven by two custom properties, so adding an option costs nothing
 * and there is no per-option animation state to keep in sync.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className
}: {
  options: Array<{ value: T; label: ReactNode; count?: number }>
  value: T
  onChange: (v: T) => void
  className?: string
}): JSX.Element {
  const wrap = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<CSSProperties>({})

  useLayoutEffect(() => {
    const root = wrap.current
    if (!root) return
    const el = root.querySelector<HTMLButtonElement>(`[data-v="${CSS.escape(value)}"]`)
    if (!el) return
    setPill({
      ['--plx-seg-x' as string]: `${el.offsetLeft - 3}px`,
      ['--plx-seg-w' as string]: `${el.offsetWidth}px`
    })
  }, [value, options])

  return (
    <div ref={wrap} role="tablist" style={pill} className={cn('plx-seg', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          data-v={o.value}
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'plx-focus inline-flex items-center gap-1.5 rounded-chip border-0 bg-transparent px-3 py-1.5 text-[12px] font-medium transition-colors duration-quick ease-crisp',
            o.value === value ? 'text-ink-100' : 'text-ink-70 hover:text-ink-100'
          )}
        >
          {o.label}
          {o.count != null && <span className="plx-num font-mono text-[10.5px] text-ink-50">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

// ── Kbd ──────────────────────────────────────────────────────────────────────

/** A keycap. Used liberally — a shortcut nobody can see is a shortcut nobody
 *  learns, and this app is keyboard-first by doctrine. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <kbd
      className={cn(
        'plx-num rounded-[5px] bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-50 shadow-hairline',
        className
      )}
    >
      {children}
    </kbd>
  )
}

// ── Menu ─────────────────────────────────────────────────────────────────────

/**
 * A menu built on the native popover API and CSS anchor positioning.
 *
 * No portal, no positioning library, no outside-click handler, no focus trap —
 * the platform does all four. Light-dismiss, Esc, and the top layer are free.
 * Enter/exit animation lives in plexi-kit.css via @starting-style.
 */
export function Menu({
  trigger,
  items,
  label = 'More'
}: {
  trigger: ReactNode
  items: Array<
    | { kind: 'sep' }
    | { kind?: 'item'; label: string; icon?: ReactNode; kbd?: string; tone?: Tone; onSelect?: () => void }
  >
  label?: string
}): JSX.Element {
  const id = `plxm-${useId().replace(/:/g, '')}`
  const anchor = `--${id}`
  return (
    <>
      <span
        // @ts-expect-error popovertarget is a valid DOM attribute; React 18 has no type for it.
        popovertarget={id}
        aria-haspopup="menu"
        aria-label={label}
        style={{ ['anchorName' as string]: anchor } as CSSProperties}
        className="inline-flex"
      >
        {trigger}
      </span>
      <div
        id={id}
        // @ts-expect-error popover is a valid DOM attribute; React 18 has no type for it.
        popover="auto"
        role="menu"
        style={{ ['--plx-anchor' as string]: anchor } as CSSProperties}
        className="plx-pop plx-anchored min-w-[190px]"
      >
        {items.map((it, i) =>
          it.kind === 'sep' ? (
            <div key={i} className="my-1 h-px bg-edge-soft" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              onClick={it.onSelect}
              className={cn(
                'plx-focus flex w-full items-center gap-2.5 rounded-row border-0 bg-transparent px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-quick ease-crisp hover:bg-surface-sunken',
                it.tone ? TONE_TEXT[it.tone] : 'text-ink-90'
              )}
            >
              {it.icon}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.kbd && <Kbd>{it.kbd}</Kbd>}
            </button>
          )
        )}
      </div>
    </>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

/**
 * The primitive with the most leverage in the app: 66 views, every one of them
 * hand-rolling its own empty.
 *
 * It carries the no-fakery rule structurally — there is no `sample` prop and no
 * skeleton-of-imaginary-rows variant, because an honest empty beats a
 * convincing fake and the component should make the honest one easiest.
 */
export function EmptyState({
  icon,
  tone = 'stone',
  title,
  body,
  action,
  className
}: {
  icon?: ReactNode
  tone?: Tone
  title: string
  body?: ReactNode
  action?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      {icon && (
        <span
          className={cn(
            'mb-3.5 grid h-11 w-11 place-items-center rounded-chip bg-[color-mix(in_oklab,currentColor_var(--fb-chip-wash),transparent)]',
            TONE_TEXT[tone]
          )}
        >
          {icon}
        </span>
      )}
      <h4 className="plx-title text-[15px] font-semibold text-ink-100">{title}</h4>
      {body && <p className="plx-prose mt-1.5 max-w-[42ch] text-[13px] leading-relaxed text-ink-50">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ── Widget frame ─────────────────────────────────────────────────────────────

/**
 * The canvas widget shell, and the fix for the 28-always-on-buttons problem.
 *
 * Chrome is hover- and focus-revealed, so a resting desk shows titles and
 * nothing else, while every control stays tab-reachable. The frame is a
 * container, so its contents respond to the widget's own width — the right
 * answer for an object the user resizes by dragging, and the reason this no
 * longer needs a ResizeObserver in JS.
 */
export function WidgetFrame({
  title,
  icon,
  tone = 'stone',
  selected = false,
  badge,
  menu,
  children,
  className
}: {
  title: string
  icon?: ReactNode
  tone?: Tone
  selected?: boolean
  badge?: ReactNode
  menu?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section data-selected={selected} className={cn('plx-widget', className)}>
      <header className="flex items-center gap-2 px-3 py-2.5">
        {icon && <span className={cn('shrink-0', TONE_TEXT[tone])}>{icon}</span>}
        <h3 className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-[-0.008em] text-ink-100">
          {title}
        </h3>
        {badge}
        <span className="plx-widget-chrome shrink-0">{menu}</span>
      </header>
      <div className="px-3 pb-3">{children}</div>
    </section>
  )
}

// ── Meter, presence, skeleton ────────────────────────────────────────────────

/** A bar. `value` is 0–1. The fill animates because --plx-fill is a registered
 *  percentage, so this is two elements and no transition wrangling. */
export function Meter({
  value,
  tone = 'accent',
  className
}: {
  value: number
  tone?: Tone
  className?: string
}): JSX.Element {
  const pct = Math.max(0, Math.min(1, value))
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('plx-meter', TONE_TEXT[tone], className)}
    >
      <i style={{ ['--plx-fill' as string]: `${pct * 100}%` } as CSSProperties} />
    </div>
  )
}

/** Overlapping avatars with an honest overflow count. Shows what is real —
 *  `extra` is a number you pass, never an invented "+3". */
export function PresenceStack({
  people,
  extra = 0,
  className
}: {
  people: Array<{ initials: string; color: string }>
  extra?: number
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex', className)}>
      {people.map((p, i) => (
        <span
          key={i}
          className="-ml-2 grid h-6 w-6 place-items-center rounded-full text-[9.5px] font-bold text-white shadow-[0_0_0_2px_var(--surface-raised)] first:ml-0"
          style={{ background: p.color }}
        >
          {p.initials}
        </span>
      ))}
      {extra > 0 && (
        <span className="plx-num -ml-2 grid h-6 w-6 place-items-center rounded-full bg-surface-sunken text-[9.5px] font-bold text-ink-70 shadow-[0_0_0_2px_var(--surface-raised)]">
          +{extra}
        </span>
      )}
    </div>
  )
}

/** A loading shape. Never sample content. */
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div aria-hidden className={cn('plx-skeleton h-4 w-full', className)} />
}
