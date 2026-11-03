import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import { alarm, beep } from '../../lib/audioBeep'

interface TimerData {
  targetSec: number
  elapsedSec: number
  state: 'idle' | 'running' | 'paused' | 'done'
  startedAt: number | null
}

/** Past this many seconds over, a finished run is shown as done without the alarm. */
const LATE_ALARM_SEC = 60

const DEFAULT: TimerData = { targetSec: 600, elapsedSec: 0, state: 'idle', startedAt: null }

function parse(content: string): TimerData {
  try {
    const obj = JSON.parse(content) as Partial<TimerData>
    return {
      targetSec: obj.targetSec ?? DEFAULT.targetSec,
      elapsedSec: obj.elapsedSec ?? DEFAULT.elapsedSec,
      state: (obj.state ?? DEFAULT.state) as TimerData['state'],
      startedAt: obj.startedAt ?? DEFAULT.startedAt
    }
  } catch {
    return DEFAULT
  }
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function TimerWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [data, setData] = useState<TimerData>(() => parse(widget.content))
  const [, setTick] = useState(0) // force re-render every tick
  const lastFiredRef = useRef<Set<number>>(new Set())
  // The run this widget has already finished, by its start time. The threshold
  // effect below runs after EVERY render, and finishing a run writes the widget
  // store, whose subscribers re-render SYNCHRONOUSLY — before setData(done), an
  // ordinary-priority update, has landed. So the timer still read "running" and
  // finished the same run again on every one of those renders, until React's
  // nested-update limit: "Minified React error #185" on every launch for a
  // timer that came back running with its time already up (owner's crash log,
  // 2026-11-03; tests/unit/timerFinishesOnce). A run is finished once.
  const finishedRunRef = useRef<string | null>(null)
  const [editingMins, setEditingMins] = useState(Math.floor(data.targetSec / 60))
  const [editingSecs, setEditingSecs] = useState(data.targetSec % 60)

  // Reset when widget.content changes from outside
  useEffect(() => {
    const parsed = parse(widget.content)
    setData(parsed)
    setEditingMins(Math.floor(parsed.targetSec / 60))
    setEditingSecs(parsed.targetSec % 60)
    lastFiredRef.current = new Set()
  }, [widget.id, widget.content])

  // Tick when running
  useEffect(() => {
    if (data.state !== 'running') return
    const id = window.setInterval(() => {
      setTick((t) => t + 1)
    }, 250)
    return () => window.clearInterval(id)
  }, [data.state])

  function persist(next: TimerData): void {
    setData(next)
    void update(widget.id, { content: JSON.stringify(next) })
  }

  function currentElapsed(): number {
    if (data.state === 'running' && data.startedAt) {
      return data.elapsedSec + (Date.now() - data.startedAt) / 1000
    }
    return data.elapsedSec
  }

  const elapsed = currentElapsed()
  const remaining = Math.max(0, data.targetSec - elapsed)
  const pct = Math.min(1, elapsed / Math.max(1, data.targetSec))

  // Threshold beeps + alarm
  useEffect(() => {
    if (data.state !== 'running') return
    const r = Math.ceil(remaining)
    const thresholds = [60, 30, 10, 5, 4, 3, 2, 1]
    for (const t of thresholds) {
      if (r === t && !lastFiredRef.current.has(t)) {
        lastFiredRef.current.add(t)
        beep(t <= 5 ? 880 : t <= 10 ? 760 : 660, 120, 0.12 + (1 - t / 60) * 0.08)
      }
    }
    if (remaining <= 0 && data.state === 'running') {
      const run = `${data.startedAt ?? 'none'}:${data.targetSec}`
      if (finishedRunRef.current === run) {
        // Already finished. Its "running" copy came back (the synchronous
        // re-render above, or a synced copy of the same run): show it as done
        // here, with no second alarm and no second write.
        setData((d) => (d.state === 'running' && d.startedAt === data.startedAt ? { ...d, state: 'done', elapsedSec: d.targetSec, startedAt: null } : d))
        return
      }
      finishedRunRef.current = run
      lastFiredRef.current = new Set()
      // The alarm is for time running out NOW. A run that ended while the app
      // was closed (or on another device) finishes quietly: an alarm for a
      // 15-minute timer that ran out hours ago is noise.
      if (elapsed - data.targetSec < LATE_ALARM_SEC) alarm()
      persist({ ...data, state: 'done', elapsedSec: data.targetSec, startedAt: null })
    }
  })

  function handleStart(): void {
    if (data.state === 'done') {
      // restart from 0
      persist({ targetSec: data.targetSec, elapsedSec: 0, state: 'running', startedAt: Date.now() })
      lastFiredRef.current = new Set()
      return
    }
    persist({ ...data, state: 'running', startedAt: Date.now() })
  }

  function handlePause(): void {
    const e = currentElapsed()
    persist({ ...data, state: 'paused', elapsedSec: e, startedAt: null })
  }

  function handleReset(): void {
    lastFiredRef.current = new Set()
    persist({ targetSec: data.targetSec, elapsedSec: 0, state: 'idle', startedAt: null })
  }

  function commitTarget(): void {
    const sec = Math.max(1, editingMins * 60 + editingSecs)
    persist({ targetSec: sec, elapsedSec: 0, state: 'idle', startedAt: null })
    lastFiredRef.current = new Set()
  }

  const isUrgent = data.state === 'running' && remaining <= 10 && remaining > 0
  const isDone = data.state === 'done' || (data.state === 'running' && remaining <= 0)
  const ringColor =
    isDone ? '#ef4444' : isUrgent ? '#ef4444' : pct > 0.75 ? '#f59e0b' : pct > 0.5 ? '#eab308' : '#10b981'

  const display = isDone ? "Time's up" : fmt(remaining)

  const body = (
    <div className="h-full w-full bg-[var(--surface-sunken)] flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3 relative">
        <div
          className={`relative ${isUrgent ? 'animate-pulse' : ''}`}
          style={{
            width: inline ? 220 : 140,
            height: inline ? 220 : 140
          }}
        >
          <svg viewBox="0 0 100 100" className="absolute inset-0">
            <circle cx="50" cy="50" r="46" fill="none" stroke="#e7e5e4" strokeWidth="6" />
            <circle
              cx="50"
              cy="50"
              r="46"
              fill="none"
              stroke={ringColor}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${(1 - pct) * 2 * Math.PI * 46} ${2 * Math.PI * 46}`}
              transform="rotate(-90 50 50)"
              style={{ transition: 'stroke-dasharray 0.25s ease-out, stroke 0.25s' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div
              className={`font-mono font-semibold ${
                inline ? 'text-5xl' : 'text-2xl'
              } ${isDone ? 'text-red-600' : isUrgent ? 'text-red-600' : 'text-[var(--ink-100)]'}`}
            >
              {display}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-[var(--ink-50)] mt-1">
              of {fmt(data.targetSec)}
            </div>
          </div>
        </div>

        {data.state === 'idle' && (
          <div className="flex items-center gap-1 text-xs text-[var(--ink-70)]">
            <input
              type="number"
              min={0}
              max={999}
              value={editingMins}
              onChange={(e) => setEditingMins(Math.max(0, parseInt(e.target.value || '0', 10)))}
              onBlur={commitTarget}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="fb-field w-12 text-center bg-[var(--surface-raised)] px-1 py-0.5"
            />
            <span>min</span>
            <input
              type="number"
              min={0}
              max={59}
              value={editingSecs}
              onChange={(e) =>
                setEditingSecs(Math.max(0, Math.min(59, parseInt(e.target.value || '0', 10))))
              }
              onBlur={commitTarget}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="fb-field w-12 text-center bg-[var(--surface-raised)] px-1 py-0.5"
            />
            <span>sec</span>
          </div>
        )}
      </div>

      <div className="px-3 pb-3 flex items-center justify-center gap-2">
        {(data.state === 'idle' || data.state === 'paused' || data.state === 'done') && (
          <button onClick={handleStart} className="btn-primary">
            <Icon name={data.state === 'done' ? 'restart_alt' : 'play_arrow'} size={14} />
            <span>{data.state === 'done' ? 'Again' : data.state === 'paused' ? 'Resume' : 'Start'}</span>
          </button>
        )}
        {data.state === 'running' && (
          <button onClick={handlePause} className="fb-btn-surface btn-ghost">
            <Icon name="pause" size={14} />
            <span>Pause</span>
          </button>
        )}
        {data.state !== 'idle' && (
          <button onClick={handleReset} className="btn-ghost">
            <Icon name="restart_alt" size={14} />
            <span>Reset</span>
          </button>
        )}
      </div>
    </div>
  )

  if (inline) return body

  return (
    <WidgetFrame widget={widget} headerLabel="timer" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]">
      {body}
    </WidgetFrame>
  )
}
