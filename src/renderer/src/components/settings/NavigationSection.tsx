import { useEffect, useRef } from 'react'
import {
  type NavPrefs,
  useNavPrefs,
  setNavPrefs,
  resetNavPrefs,
  frictionFromGlide
} from '../../lib/navPrefs'
import Icon from '../Icon'

// ── Navigation settings ─────────────────────────────────────────────────────
// Tunes every way you move the camera, with a live, flick-able preview so each
// control has a visible meaning. The preview puck obeys the SAME physics as the
// real canvas (slingshot × sensitivity launch, glide friction) and auto-demos
// itself when you're not touching it — an always-moving "what it looks like".

function Toggle({
  label,
  desc,
  checked,
  onChange
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <label className="flex items-start justify-between gap-3 py-1.5 cursor-pointer">
      <div className="min-w-0">
        <div className="text-xs text-[var(--ink-70)]">{label}</div>
        <div className="fb-t-caption text-[var(--ink-50)] leading-snug">{desc}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-accent cursor-pointer shrink-0"
      />
    </label>
  )
}

function Slider({
  label,
  desc,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled
}: {
  label: string
  desc: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div className={`py-1.5 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--ink-70)]">{label}</span>
        <span className="fb-t-caption font-mono text-[var(--ink-50)]">
          {format(value)}
        </span>
      </div>
      <div className="fb-t-caption text-[var(--ink-50)] leading-snug mb-1">{desc}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 accent-accent cursor-pointer"
      />
    </div>
  )
}

// ── Live preview ────────────────────────────────────────────────────────────
// A puck you can drag + flick. Velocity is launched with the SAME slingshot ×
// sensitivity gain and decays with the SAME glide friction as the canvas. It
// bounces off the walls to stay in view, and auto-flicks itself when idle so
// the panel always shows motion (the "example gif").
function NavPreview({ nav }: { nav: NavPrefs }): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const puckRef = useRef<HTMLDivElement | null>(null)
  const navRef = useRef(nav)
  navRef.current = nav
  const s = useRef({
    x: 70,
    y: 55,
    vx: 0,
    vy: 0,
    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    velX: 0,
    velY: 0,
    idleSince: 0
  })

  useEffect(() => {
    const R = 9 // puck radius
    let raf = 0
    function size(): { w: number; h: number } {
      const el = boxRef.current
      return { w: el?.clientWidth ?? 240, h: el?.clientHeight ?? 120 }
    }
    function autoFlick(): void {
      const ang = (s.current.x + s.current.y) % (Math.PI * 2) || 1 // deterministic-ish, no Math.random needed
      const speed = 6 + (navRef.current.slingshot / 6) * 6
      s.current.vx = Math.cos(ang * 1.7) * speed
      s.current.vy = Math.sin(ang * 2.3) * speed
    }
    function frame(t: number): void {
      const st = s.current
      const { w, h } = size()
      if (!st.dragging) {
        st.x += st.vx
        st.y += st.vy
        const fr = navRef.current.momentumEnabled ? frictionFromGlide(navRef.current.glide) : 0.7
        st.vx *= fr
        st.vy *= fr
        // Wall bounce (a little energy loss) so it stays inside the box.
        if (st.x < R) {
          st.x = R
          st.vx = Math.abs(st.vx) * 0.7
        } else if (st.x > w - R) {
          st.x = w - R
          st.vx = -Math.abs(st.vx) * 0.7
        }
        if (st.y < R) {
          st.y = R
          st.vy = Math.abs(st.vy) * 0.7
        } else if (st.y > h - R) {
          st.y = h - R
          st.vy = -Math.abs(st.vy) * 0.7
        }
        // Idle → auto-flick every ~1.8s so the preview always shows motion.
        if (Math.hypot(st.vx, st.vy) < 0.25) {
          if (st.idleSince === 0) st.idleSince = t
          else if (t - st.idleSince > 1800) {
            autoFlick()
            st.idleSince = 0
          }
        } else {
          st.idleSince = 0
        }
      }
      if (puckRef.current) {
        puckRef.current.style.transform = `translate(${st.x - R}px, ${st.y - R}px)`
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  function onDown(e: React.PointerEvent): void {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return
    const st = s.current
    st.dragging = true
    st.moved = false
    st.vx = 0
    st.vy = 0
    st.lastX = e.clientX
    st.lastY = e.clientY
    st.lastT = performance.now()
    st.velX = 0
    st.velY = 0
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }
  function onMove(e: React.PointerEvent): void {
    const st = s.current
    if (!st.dragging) return
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return
    const sens = navRef.current.dragSensitivity
    st.x += (e.clientX - st.lastX) * sens
    st.y += (e.clientY - st.lastY) * sens
    const now = performance.now()
    const dt = Math.max(1, now - st.lastT)
    st.velX = st.velX * 0.35 + ((e.clientX - st.lastX) / dt) * 16 * 0.65
    st.velY = st.velY * 0.35 + ((e.clientY - st.lastY) / dt) * 16 * 0.65
    st.lastX = e.clientX
    st.lastY = e.clientY
    st.lastT = now
    st.moved = true
  }
  function onUp(): void {
    const st = s.current
    if (!st.dragging) return
    st.dragging = false
    if (navRef.current.momentumEnabled && st.moved) {
      const launch = navRef.current.slingshot * navRef.current.dragSensitivity
      st.vx = Math.max(-40, Math.min(40, st.velX * launch))
      st.vy = Math.max(-40, Math.min(40, st.velY * launch))
    }
  }

  return (
    <div className="mt-1">
      <div
        ref={boxRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="relative h-[120px] w-full rounded-[var(--radius-field)] overflow-hidden cursor-grab active:cursor-grabbing shadow-[0_0_0_1px_var(--edge-hairline)] touch-none"
        style={{
          backgroundColor: 'rgb(var(--accent) / 0.04)',
          backgroundImage:
            'radial-gradient(rgb(var(--accent) / 0.18) 1px, transparent 1px)',
          backgroundSize: '14px 14px'
        }}
      >
        <div
          ref={puckRef}
          className="absolute top-0 left-0 h-[18px] w-[18px] rounded-full bg-accent shadow-md"
          style={{ willChange: 'transform' }}
        />
      </div>
      <div className="fb-t-caption text-[var(--ink-50)] mt-1 text-center">
        Flick the dot — it slingshots and glides exactly like your canvas. (Auto-demos when idle.)
      </div>
    </div>
  )
}

export default function NavigationSection(): JSX.Element {
  const nav = useNavPrefs()
  const x = (v: number): string => `${v.toFixed(1)}×`

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-soft)]">
      <div className="flex items-center justify-between mb-1">
        <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">
          Canvas navigation
        </div>
        <button
          onClick={() => resetNavPrefs()}
          className="fb-t-caption text-[var(--ink-50)] hover:text-[var(--ink-90)] inline-flex items-center gap-0.5"
          title="Reset all navigation settings to defaults"
        >
          <Icon name="restart_alt" size={12} />
          Reset
        </button>
      </div>

      <NavPreview nav={nav} />

      {/* Click-drag pan */}
      <div className="mt-3 fb-t-caption uppercase tracking-wider text-[var(--ink-40)]">
        Click-drag pan
      </div>
      <Toggle
        label="Drag the canvas to pan"
        desc="Press an empty part of the desk and drag to move the camera."
        checked={nav.dragPanEnabled}
        onChange={(v) => setNavPrefs({ dragPanEnabled: v })}
      />
      <div className={nav.dragPanEnabled ? '' : 'opacity-40 pointer-events-none'}>
        <Slider
          label="Sensitivity"
          desc="How far the camera moves for a given drag. 1× tracks your cursor exactly."
          value={nav.dragSensitivity}
          min={0.5}
          max={2.5}
          step={0.1}
          format={x}
          onChange={(v) => setNavPrefs({ dragSensitivity: v })}
        />
        <Toggle
          label="Momentum (slingshot)"
          desc="Keep gliding after you let go instead of stopping dead."
          checked={nav.momentumEnabled}
          onChange={(v) => setNavPrefs({ momentumEnabled: v })}
        />
        <Slider
          label="Slingshot strength"
          desc="How hard a flick launches the camera. Higher = flings further."
          value={nav.slingshot}
          min={1}
          max={6}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => setNavPrefs({ slingshot: v })}
          disabled={!nav.momentumEnabled}
        />
        <Slider
          label="Glide"
          desc="How long it coasts before settling. Low = stops soon, high = drifts a while."
          value={nav.glide}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setNavPrefs({ glide: v })}
          disabled={!nav.momentumEnabled}
        />
        <Toggle
          label="Sonar feedback on grab"
          desc="A soft sonar ping + pulse ring when you grab the canvas."
          checked={nav.sonarOnGrab}
          onChange={(v) => setNavPrefs({ sonarOnGrab: v })}
        />
      </div>

      {/* Edge pan */}
      <div className="mt-3 fb-t-caption uppercase tracking-wider text-[var(--ink-40)]">
        Edge pan
      </div>
      <Toggle
        label="Pan when the cursor nears an edge"
        desc="Move the mouse to the edge of the desk and the camera scrolls that way."
        checked={nav.edgePanEnabled}
        onChange={(v) => setNavPrefs({ edgePanEnabled: v })}
      />
      <Slider
        label="Edge-pan speed"
        desc="How fast the camera scrolls when the cursor is at the very edge."
        value={nav.edgePanSpeed}
        min={0.3}
        max={2.5}
        step={0.1}
        format={x}
        onChange={(v) => setNavPrefs({ edgePanSpeed: v })}
        disabled={!nav.edgePanEnabled}
      />

      {/* Trackpad / wheel + zoom */}
      <div className="mt-3 fb-t-caption uppercase tracking-wider text-[var(--ink-40)]">
        Trackpad &amp; zoom
      </div>
      <Slider
        label="Two-finger / wheel pan speed"
        desc="Sensitivity of trackpad swipe and mouse-wheel panning."
        value={nav.wheelSensitivity}
        min={0.3}
        max={2.5}
        step={0.1}
        format={x}
        onChange={(v) => setNavPrefs({ wheelSensitivity: v })}
      />
      <Slider
        label="Zoom speed"
        desc="How fast ⌘-scroll / pinch zooms toward the cursor."
        value={nav.zoomSensitivity}
        min={0.3}
        max={2.5}
        step={0.1}
        format={x}
        onChange={(v) => setNavPrefs({ zoomSensitivity: v })}
      />
      <Slider
        label="Arrow-key zoom"
        desc="How large a widget is made when you arrow to it. 1× keeps it at its designed size; higher fills more of the screen. A widget too big to fit is always zoomed out to fit."
        value={nav.navZoom}
        min={1}
        max={2}
        step={0.05}
        format={x}
        onChange={(v) => setNavPrefs({ navZoom: v })}
      />
    </div>
  )
}
