import { useEffect, useRef, useState } from 'react'
import { collectMenuRects, resolveCenteredTop } from '../lib/floatingChrome'
import { motion } from 'framer-motion'
import Icon from './Icon'
import { TIDY_MODES, type TidyOptions } from '../lib/autoArrange'
import LoadMeter from './LoadMeter'
import { useCognitiveLoad } from '../lib/useCognitiveLoad'

interface Props {
  /** Undefined opts = the default tidy (the button's own click). */
  onTidy: (opts?: TidyOptions) => void
  tidyDisabled: boolean
  onBuild: () => void
  onSaveTemplate: () => void
  saveDisabled: boolean
  savingTemplate: boolean
  onResume: () => void
  onStatus: () => void
  statusLabel: string
  statusIcon: string
  onFocus: () => void
  focusActive: boolean
  onChat: () => void
  onMeeting: () => void
  timerText: string | null
  timerOverdue: boolean
  /** Render as a plain row for the header instead of a floating, draggable pill. */
  docked?: boolean
}

const EASE_ENTER = [0.34, 1.2, 0.64, 1] as const
const EASE_EXIT  = [0.4, 0, 1, 1] as const

// Animated label that slides in beside an icon on hover.
// Uses maxWidth (not width:auto) so it works reliably for always-mounted elements.
function MotionLabel({ hovered, children }: { hovered: boolean; children: React.ReactNode }): JSX.Element {
  const dur = hovered ? 0.22 : 0.15
  const ease = hovered ? EASE_ENTER : EASE_EXIT
  return (
    <motion.span
      initial={false}
      animate={{ maxWidth: hovered ? 120 : 0, opacity: hovered ? 1 : 0, marginLeft: hovered ? 4 : 0 }}
      transition={{ duration: dur, ease }}
      style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
      className="inline-block text-[11px]"
    >
      {children}
    </motion.span>
  )
}

/**
 * DEC-038 — Tidy, with its modes on hover.
 *
 * The operator asked for Tidy to live in ONE place (this pill, not also the
 * desk right-click menu) and for its modes to be offered as "just the images".
 * So the labels become tooltips and accessible names; the visible menu is a
 * strip of icons. Clicking the button itself still runs the default tidy, so
 * the fast path is unchanged for anyone who never opens the menu.
 *
 * Hover-out is delayed, because the pointer has to cross a gap to reach the
 * menu — closing on the first mouseleave would make it unreachable.
 */
function TidyControl({
  onTidy,
  disabled,
  hovered,
  rounded
}: {
  onTidy: (opts?: TidyOptions) => void
  disabled: boolean
  hovered: boolean
  rounded: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = (): void => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 220)
  }
  useEffect(() => cancelClose, [])

  const pick = (opts: TidyOptions): void => {
    setOpen(false)
    onTidy(opts)
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        if (!disabled) {
          cancelClose()
          setOpen(true)
        }
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        onClick={() => onTidy()}
        disabled={disabled}
        className={`inline-flex items-center h-6 px-1.5 ${rounded} text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] disabled:opacity-30 transition-colors`}
        title="Tidy"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="pill-tidy"
      >
        <Icon name="grid_view" size={12} />
        <MotionLabel hovered={hovered}>Tidy</MotionLabel>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          aria-label="Tidy layout"
          data-testid="tidy-menu"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-[400] rounded-xl border border-[var(--edge-soft)] bg-[var(--surface-raised)] shadow-xl px-1.5 py-1.5"
        >
          <div className="flex items-center gap-0.5">
            {TIDY_MODES.map((m) => (
              <button
                key={m.icon + m.label}
                role="menuitem"
                onClick={() => pick(m.opts)}
                title={m.label}
                aria-label={m.label}
                data-testid={`tidy-mode-${m.opts.mode}`}
                className="inline-flex items-center justify-center h-7 w-7 rounded-lg text-[var(--ink-60)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] fb-press transition-colors"
              >
                <Icon name={m.icon} size={15} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Horizontal mode: single unified button row — icons always visible, labels slide in.
// Vertical mode: icon-column header + single AnimatePresence labeled dropdown (no duplication).
export default function FloatingPill({
  onTidy, tidyDisabled, onBuild, onSaveTemplate, saveDisabled, savingTemplate, onResume,
  onStatus, statusLabel, statusIcon, onFocus, focusActive,
  onChat, onMeeting, timerText, timerOverdue, docked = false
}: Props): JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null)
  // The pill is ALWAYS horizontally centered (product decision 2026-08-21):
  // dragging adjusts only its vertical position, so it can never end up
  // parked off-center. posY null = sit at defaultY.
  const [posY, setPosY] = useState<number | null>(null)
  const [defaultY, setDefaultY] = useState(60)
  // Vertical-only dodge applied while the pill is in its default centered mode
  // (pos === null). Kept separate from pos so dodging never costs the pill its
  // left:50% centering. Null = sit at defaultY.
  const [dodgeY, setDodgeY] = useState<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { tier } = useCognitiveLoad()
  const overloaded = tier.label === 'Overloaded'

  const dragData = useRef<{
    startMX: number; startMY: number; startPX: number; startPY: number
  } | null>(null)

  const onMove = useRef((e: MouseEvent): void => {
    if (!dragData.current) return
    setPosY(dragData.current.startPY + (e.clientY - dragData.current.startMY))
  })

  const onUp = useRef((): void => {
    dragData.current = null
    window.removeEventListener('mousemove', onMove.current)
    window.removeEventListener('mouseup', onUp.current)
  })

  useEffect(() => {
    function measure(): void {
      const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
      if (el) setDefaultY(el.getBoundingClientRect().top + 12)
    }
    measure()
    window.addEventListener('resize', measure)
    const t = setTimeout(measure, 300)
    return () => { window.removeEventListener('resize', measure); clearTimeout(t) }
  }, [])

  useEffect(() => {
    const move = onMove.current, up = onUp.current
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const rect = pillRef.current?.getBoundingClientRect()
    if (!rect) return
    dragData.current = { startMX: e.clientX, startMY: e.clientY, startPX: rect.left, startPY: rect.top }
    window.addEventListener('mousemove', onMove.current)
    window.addEventListener('mouseup', onUp.current)
  }

  function handleMouseEnter(): void {
    if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
    setHovered(true)
  }

  function handleMouseLeave(): void {
    hoverTimer.current = setTimeout(() => setHovered(false), 300)
  }

  useEffect(() => () => { if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current) }, [])

  // The pill is persistent chrome, not a transient popover, so it must NOT latch
  // the global edge-pan disable (that stuck edge-pan off, especially when the
  // pill relocated out from under a still cursor and never fired mouseleave).
  // Edge-pan is instead suppressed by pointer-over: useEdgePan treats the cursor
  // being over any floating menu (the pill is tagged data-floating-menu) the
  // same as leaving the canvas, so panning is paused only while you are actually
  // on the pill and resumes the instant you move off it.

  // Keep the pill on screen and clear of the other floating menus. Runs after a
  // drag settles, after the labels collapse, shortly after mount (so the
  // breadcrumb has measured), and on resize.
  //
  // Two rules keep this from fighting the user (the old behavior teleported the
  // pill out from under a still-hovering cursor, which fired mouseleave and
  // collapsed the labels before a button could be clicked):
  //  - Never relocate while the cursor is on the pill or a drag is in flight.
  //    A transient overlap during hover-expansion is fine; it re-resolves on
  //    mouseleave once the labels have collapsed.
  //  - In default centered mode (pos === null) dodge VERTICALLY only, via
  //    dodgeY, so the pill keeps its left:50% centering instead of being
  //    side-pushed over the sidebar. Only a user drag (pos set) uses the free
  //    resolvePosition dodge.
  useEffect(() => {
    function resolve(): void {
      const el = pillRef.current
      if (!el) return
      if (hovered || dragData.current) return
      const r = el.getBoundingClientRect()
      const obstacles = collectMenuRects(el)
      const base = posY ?? defaultY
      const top = resolveCenteredTop(base, r.width, r.height, obstacles)
      setDodgeY((cur) => {
        const effective = cur ?? base
        if (Math.round(top) === Math.round(effective)) return cur
        return Math.round(top) === Math.round(base) ? null : top
      })
    }
    resolve()
    const t = setTimeout(resolve, 350)
    window.addEventListener('resize', resolve)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', resolve)
    }
  }, [hovered, posY, defaultY])

  // Always horizontal — the pill never leaves the centered column, so the
  // side-edge vertical orientation can no longer be reached.
  // Cast keeps the union type so the (now unreachable) vertical render path
  // still typechecks without dead-code warnings.
  const orient = 'h' as 'h' | 'v'

  const posStyle = { left: '50%', transform: 'translateX(-50%)', top: dodgeY ?? posY ?? defaultY }

  const ringStyle = {
    boxShadow: `0 0 0 2px ${tier.ringColor}, 0 6px 24px ${tier.shadowColor}`,
    transition: 'box-shadow 700ms ease'
  }

  const sharedOuter = {
    ref: pillRef,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onMouseDown: handleMouseDown,
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      setPosY(null)
      setDodgeY(null)
    },
    title: 'Drag up or down to reposition · Double-click to reset',
    'data-testid': 'floating-pill',
    'data-floating-menu': true,
    style: { ...posStyle, ...ringStyle }
  }

  if (orient === 'v') {
    // ── Vertical (near left or right edge) ────────────────────────────────────
    // Single unified column: icons always visible, labels slide in to the right on hover.
    // Same MotionLabel pattern as horizontal — no duplication, no competing sections.
    return (
      <div
        {...sharedOuter}
        className={[
          'fb-pill fixed z-[50] flex flex-col items-stretch fb-glass-chrome rounded-2xl',
          'select-none cursor-grab active:cursor-grabbing',
          overloaded ? 'animate-pulse' : ''
        ].join(' ')}
      >
        {/* Drag affordance */}
        <div className="flex justify-center pt-2 pb-0.5 shrink-0">
          <Icon name="drag_indicator" size={12} className="text-[var(--ink-25,var(--ink-30))] pointer-events-none" />
        </div>

        {/* Unified button column */}
        <div className="flex flex-col px-1 pb-1.5 pt-0.5 gap-0.5">

          <button onClick={onStatus} className="inline-flex items-center h-6 px-1.5 rounded-lg text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors" title={statusLabel} data-testid="pill-status">
            <Icon name={statusIcon} size={12} />
            <MotionLabel hovered={hovered}>{statusLabel}</MotionLabel>
          </button>

          <div className="h-px bg-[var(--edge-firm)] mx-1 my-0.5 shrink-0" />

          {focusActive ? (
            <span className="inline-flex items-center h-6 px-1.5 rounded-lg text-accent cursor-default" title="Focus session active" data-testid="pill-focus-active">
              <Icon name="bolt" size={12} filled />
              <MotionLabel hovered={hovered}>Focused</MotionLabel>
            </span>
          ) : (
            <motion.button
              onClick={onFocus}
              animate={{
                backgroundColor: hovered ? 'rgb(var(--accent))' : 'transparent',
                color: hovered ? '#ffffff' : 'rgb(var(--accent))',
              }}
              transition={{ duration: 0.18 }}
              className="inline-flex items-center h-6 px-1.5 rounded-lg transition-none"
              title="Focus"
              data-testid="pill-focus"
            >
              <Icon name="bolt" size={12} />
              <MotionLabel hovered={hovered}>Focus</MotionLabel>
            </motion.button>
          )}

          <button onClick={onChat} className="inline-flex items-center h-6 px-1.5 rounded-lg text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)] transition-colors" title="Chat" data-testid="pill-chat">
            <Icon name="forum" size={12} />
            <MotionLabel hovered={hovered}>Chat</MotionLabel>
          </button>

          <button onClick={onMeeting} className="inline-flex items-center h-6 px-1.5 rounded-lg text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)] transition-colors" title="Meeting" data-testid="pill-meeting">
            <Icon name="videocam" size={12} />
            <MotionLabel hovered={hovered}>Meeting</MotionLabel>
          </button>

          {timerText && (
            <span className={`text-[10px] font-mono tabular-nums px-1.5 ${timerOverdue ? 'text-red-500 animate-pulse' : 'text-[var(--ink-50)]'}`}>
              {timerText}
            </span>
          )}

          <div className="h-px bg-[var(--edge-firm)] mx-1 my-0.5 shrink-0" />

          <TidyControl onTidy={onTidy} disabled={tidyDisabled} hovered={hovered} rounded="rounded-lg" />

          <button onClick={onBuild} className="inline-flex items-center h-6 px-1.5 rounded-lg text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)] transition-colors" title="Build with AI" data-testid="pill-build">
            <Icon name="auto_awesome" size={12} />
            <MotionLabel hovered={hovered}>Build</MotionLabel>
          </button>

          <button onClick={onSaveTemplate} disabled={saveDisabled} className="inline-flex items-center h-6 px-1.5 rounded-lg text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] disabled:opacity-30 transition-colors" title={savingTemplate ? 'Saving…' : 'Save as template'} data-testid="pill-save-template">
            <Icon name={savingTemplate ? 'hourglass_empty' : 'bookmark_add'} size={12} />
            <MotionLabel hovered={hovered}>{savingTemplate ? 'Saving…' : 'Template'}</MotionLabel>
          </button>

          <button onClick={onResume} className="inline-flex items-center h-6 px-1.5 rounded-lg text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors" title="Resume handoff document" data-testid="pill-resume">
            <Icon name="description" size={12} />
            <MotionLabel hovered={hovered}>Resume</MotionLabel>
          </button>

          <div className="h-px bg-[var(--edge-firm)] mx-1 my-0.5 shrink-0" />

          {/* LoadMeter collapses like MotionLabel: maxWidth 24 shows only the colored dot,
              maxWidth 120 reveals the full button with number + label. */}
          <motion.div
            initial={false}
            animate={{ maxWidth: hovered ? 120 : 24 }}
            transition={{ duration: hovered ? 0.22 : 0.15, ease: hovered ? EASE_ENTER : EASE_EXIT }}
            style={{ overflow: 'hidden' }}
            className="py-0.5"
          >
            <LoadMeter />
          </motion.div>

        </div>
      </div>
    )
  }

  // The button row, defined ONCE. Rendered inside the floating pill and, when
  // docked, straight into the header. Two copies would drift the moment a
  // button was added to one of them.
  const buttonRow = (
      <div className="flex items-center pr-2 py-0.5 gap-0 shrink-0">

        <button onClick={onStatus} className="inline-flex items-center h-6 px-1.5 rounded-full text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors" title={statusLabel} data-testid="pill-status">
          <Icon name={statusIcon} size={12} />
          <MotionLabel hovered={hovered}>{statusLabel}</MotionLabel>
        </button>

        <div className="w-px h-3 bg-[var(--edge-firm)] mx-0.5 shrink-0" />

        {focusActive ? (
          <span className="inline-flex items-center h-6 px-1.5 rounded-full text-accent cursor-default" title="Focus session active" data-testid="pill-focus-active">
            <Icon name="bolt" size={12} filled />
            <MotionLabel hovered={hovered}>Focused</MotionLabel>
          </span>
        ) : (
          <motion.button
            onClick={onFocus}
            animate={{
              backgroundColor: hovered ? 'rgb(var(--accent))' : 'transparent',
              color: hovered ? '#ffffff' : 'rgb(var(--accent))',
            }}
            transition={{ duration: 0.18 }}
            className="inline-flex items-center h-6 px-1.5 rounded-full transition-none"
            title="Focus"
            data-testid="pill-focus"
          >
            <Icon name="bolt" size={12} />
            <MotionLabel hovered={hovered}>Focus</MotionLabel>
          </motion.button>
        )}

        <button onClick={onChat} className="inline-flex items-center h-6 px-1.5 rounded-full text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)] transition-colors" title="Chat" data-testid="pill-chat">
          <Icon name="forum" size={12} />
          <MotionLabel hovered={hovered}>Chat</MotionLabel>
        </button>

        <button onClick={onMeeting} className="inline-flex items-center h-6 px-1.5 rounded-full text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)] transition-colors" title="Meeting" data-testid="pill-meeting">
          <Icon name="videocam" size={12} />
          <MotionLabel hovered={hovered}>Meeting</MotionLabel>
        </button>

        {timerText && (
          <span className={`text-[10px] font-mono tabular-nums px-1 ${timerOverdue ? 'text-red-500 animate-pulse' : 'text-[var(--ink-50)]'}`}>
            {timerText}
          </span>
        )}

        <div className="w-px h-3 bg-[var(--edge-firm)] mx-0.5 shrink-0" />

        <TidyControl onTidy={onTidy} disabled={tidyDisabled} hovered={hovered} rounded="rounded-full" />

        <button onClick={onBuild} className="inline-flex items-center h-6 px-1.5 rounded-full text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)] transition-colors" title="Build with AI" data-testid="pill-build">
          <Icon name="auto_awesome" size={12} />
          <MotionLabel hovered={hovered}>Build</MotionLabel>
        </button>

        <button onClick={onSaveTemplate} disabled={saveDisabled} className="inline-flex items-center h-6 px-1.5 rounded-full text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] disabled:opacity-30 transition-colors" title={savingTemplate ? 'Saving…' : 'Save as template'} data-testid="pill-save-template">
          <Icon name={savingTemplate ? 'hourglass_empty' : 'bookmark_add'} size={12} />
          <MotionLabel hovered={hovered}>{savingTemplate ? 'Saving…' : 'Template'}</MotionLabel>
        </button>

        <button onClick={onResume} className="inline-flex items-center h-6 px-1.5 rounded-full text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors" title="Resume handoff document" data-testid="pill-resume">
          <Icon name="description" size={12} />
          <MotionLabel hovered={hovered}>Resume</MotionLabel>
        </button>

        <div className="w-px h-3 bg-[var(--edge-firm)] mx-0.5 shrink-0" />

        <LoadMeter />

      </div>
  )

  // ── Docked (in the header) ────────────────────────────────────────────────
  // Asked for 2026-10-09: "Integrate this into the heading menu, so its not
  // floating over the canvas." Docked drops everything that only made sense
  // while floating — the fixed positioning, the drag handle, the dodge logic
  // that kept it clear of other chrome, and the hover-expanding labels — and
  // renders the same buttons, with the same handlers and the same test ids,
  // as a plain row. Nothing about what the buttons DO changes; only where they
  // live and how they are laid out.
  if (docked) {
    return (
      <div className="flex items-center" data-testid="desk-action-bar">
        {buttonRow}
      </div>
    )
  }

  // ── Horizontal (default — top center or dragged mid-screen) ───────────────
  // Single unified button row: icons always visible, labels slide in via MotionLabel.
  // No icon strip + separate expanded section = no duplication, no competing blocks.
  return (
    <div
      {...sharedOuter}
      className={[
        'fb-pill fixed z-[50] flex items-center fb-glass-chrome rounded-full',
        'select-none cursor-grab active:cursor-grabbing',
        overloaded ? 'animate-pulse' : ''
      ].join(' ')}
    >
      {/* Drag affordance */}
      <div className="pl-2 pr-0.5 py-1.5 shrink-0">
        <Icon name="drag_indicator" size={12} className="text-[var(--ink-25,var(--ink-30))] pointer-events-none" />
      </div>

      {/* Unified button row — each button: icon always, label slides in on hover */}
      {buttonRow}
    </div>
  )
}
