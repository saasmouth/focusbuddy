import { useEffect, useRef, useState } from 'react'
import type { FbNode } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useFocusSessionStore } from '../stores/focusSession'
import { enableBodyDouble, useBodyDouble } from '../lib/bodyDouble'
import { chimeIn, futuristicPowerOn } from '../lib/audioBeep'
import Icon from './Icon'

const COUNTDOWN_SEC = 15

// Heuristic: tasks that are emotionally hard to start.
// "Low interest" or "high stakes + unstarted" both predict avoidance.
function isAvoidance(task: FbNode | null): boolean {
  if (!task || task.kind !== 'task') return false
  if (task.status !== 'open') return false
  if (task.interest <= 2) return true
  if (task.importance >= 4) return true
  return false
}

// The Pre-Task Mood Bridge appears when the user activates an "avoidance" task —
// a 15-second bridge offering three friction-reducers before they have to face the work.
// Addresses the EMOTIONAL entrance to a task, which is what blocks ADHD starts more than complexity.
export default function PreTaskBridge(): JSX.Element | null {
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const nodes = useNodeStore((s) => s.nodes)
  const updateNode = useNodeStore((s) => s.update)
  const startSession = useFocusSessionStore((s) => s.start)
  const bodyDouble = useBodyDouble()

  const seenRef = useRef<Set<string>>(new Set())
  const [activeTask, setActiveTask] = useState<FbNode | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number>(COUNTDOWN_SEC)

  useEffect(() => {
    if (!activeTaskId) {
      setActiveTask(null)
      return
    }
    if (seenRef.current.has(activeTaskId)) return
    const task = nodes.find((n) => n.id === activeTaskId) ?? null
    if (!isAvoidance(task)) {
      seenRef.current.add(activeTaskId) // skip re-evaluation if not avoidance
      return
    }
    seenRef.current.add(activeTaskId)
    setActiveTask(task)
    setSecondsLeft(COUNTDOWN_SEC)
  }, [activeTaskId, nodes])

  useEffect(() => {
    if (!activeTask) return
    if (secondsLeft <= 0) {
      setActiveTask(null)
      return
    }
    const id = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => window.clearTimeout(id)
  }, [activeTask, secondsLeft])

  // The bridge is an offer, not a gate: Escape always dismisses it.
  useEffect(() => {
    if (!activeTask) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setActiveTask(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeTask])

  if (!activeTask) return null

  function close(): void {
    setActiveTask(null)
  }

  function handleFivePromise(): void {
    if (!activeTask) return
    futuristicPowerOn()
    void startSession(activeTask.id, 5 * 60, '5min')
    // Also nudge status to in_progress so the timer shows
    if (activeTask.status === 'open') {
      void updateNode(activeTask.id, { status: 'in_progress' })
    }
    close()
  }

  function handleBodyDouble(): void {
    if (!bodyDouble.enabled) enableBodyDouble()
    chimeIn()
    close()
  }

  function handleAIDraft(): void {
    if (!activeTask) return
    // Reuse the proactive-welcome flow already wired in the chat store. This is
    // a click, so it is the person asking: { asked: true } lets it through with
    // Background AI tasks off (main/deskWelcomeGate.ts).
    void import('../stores/chat').then((m) => {
      void m.useChatStore.getState().sendProactiveWelcome(activeTask.id, { asked: true })
    })
    chimeIn()
    close()
  }

  const reasons: string[] = []
  if (activeTask.interest <= 2) reasons.push(`low interest (${activeTask.interest}/5)`)
  if (activeTask.importance >= 4) reasons.push(`high stakes (${activeTask.importance}/5)`)
  const reasonLine = reasons.join(' · ')

  return (
    <div
      className="fb-scrim fixed inset-0 z-[170] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="fb-card relative w-full max-w-md mx-4 overflow-hidden">
        <button
          onClick={close}
          aria-label="Close"
          title="Close (Esc)"
          data-testid="pre-task-bridge-close"
          className="icon-btn absolute top-2.5 right-2.5 text-[var(--ink-50)]"
        >
          <Icon name="close" size={16} />
        </button>
        <div className="px-5 pt-5 pb-3 text-center">
          <div className="text-2xl mb-1">🌱</div>
          <h3 className="text-base font-semibold text-[var(--ink-100)]">
            What would make this 10% easier right now?
          </h3>
          <p className="text-[12px] text-[var(--ink-50)] mt-1 truncate">
            <em className="not-italic text-[var(--ink-70)]">{activeTask.title}</em>
            {reasonLine && <span className="text-[var(--ink-40)]"> · {reasonLine}</span>}
          </p>
        </div>

        <div className="px-5 pb-3 space-y-2">
          <button
            onClick={handleFivePromise}
            className="fb-btn-surface w-full flex items-start gap-3 p-3 hover:border-accent hover:bg-accent/5 transition-colors text-left group"
          >
            <Icon name="bolt" size={18} className="text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--ink-100)]">
                Just 5 minutes
              </div>
              <div className="text-[11px] text-[var(--ink-50)] leading-snug mt-0.5">
                Hard ceiling. No commitment past 5. The only initiation technique that consistently works.
              </div>
            </div>
          </button>

          <button
            onClick={handleBodyDouble}
            className="fb-btn-surface w-full flex items-start gap-3 p-3 hover:border-accent hover:bg-accent/5 transition-colors text-left group"
          >
            <Icon name="group" size={18} className="text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--ink-100)] flex items-center gap-1.5">
                Body double me
                {bodyDouble.enabled && (
                  <span className="text-[9px] font-mono px-1 rounded bg-accent/15 text-accent">
                    already on
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--ink-50)] leading-snug mt-0.5">
                Quiet AI presence sitting beside you. Drops a short observation every ~10 min.
              </div>
            </div>
          </button>

          <button
            onClick={handleAIDraft}
            className="fb-btn-surface w-full flex items-start gap-3 p-3 hover:border-accent hover:bg-accent/5 transition-colors text-left group"
          >
            <Icon name="auto_awesome" size={18} className="text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--ink-100)]">
                Have AI suggest the first step
              </div>
              <div className="text-[11px] text-[var(--ink-50)] leading-snug mt-0.5">
                One concrete first action, drafted in the assistant panel. Removes the "where do I even start" tax.
              </div>
            </div>
          </button>
        </div>

        <div className="px-5 py-3 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex items-center justify-between">
          <span className="text-[10px] text-[var(--ink-50)] font-mono">
            auto-opens in {secondsLeft}s
          </span>
          <button onClick={close} className="btn-ghost">
            Just open it
          </button>
        </div>
      </div>
    </div>
  )
}
