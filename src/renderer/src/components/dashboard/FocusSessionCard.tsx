import type { FbNode } from '@shared/types'
import { useFocusSessionStore } from '../../stores/focusSession'
import { useNodeStore } from '../../stores/nodes'
import Icon from '../Icon'
import { alertDialog } from '../plexi/PromptDialog'

interface Props {
  nodes: FbNode[]
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, '0')
  const s = (Math.max(0, sec) % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

// Focus Session card — the big "press the button and start" element on
// the home dashboard. Two states:
//   - Idle:  shows the default duration (25:00) and a prominent
//            "Start Session" button. If no task is active, the button
//            picks the top-priority open task by due date.
//   - Live:  countdown from the existing focusSession store's remainingSec.
//            Engagement-aware: the store decides whether to tick.
//
// Pulls from the existing useFocusSessionStore so the card and the
// existing focus overlay never drift apart.
export default function FocusSessionCard({ nodes }: Props): JSX.Element {
  const active = useFocusSessionStore((s) => s.active)
  const remainingSec = useFocusSessionStore((s) => s.remainingSec)
  const isEngaged = useFocusSessionStore((s) => s.isEngaged)
  const startSession = useFocusSessionStore((s) => s.start)
  const finishSession = useFocusSessionStore((s) => s.finish)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const setActiveTask = useNodeStore((s) => s.setActive)

  const DEFAULT_SEC = 25 * 60
  const displaySec = active ? remainingSec : DEFAULT_SEC

  // Pick a task target: prefer the active task, else the soonest-due open
  // task in scope. If neither exists, the button is disabled with a hint.
  const candidateTask = activeTaskId
    ? nodes.find((n) => n.id === activeTaskId) ?? null
    : nodes
        .filter((n) => n.kind === 'task' && !n.archived && n.status !== 'done')
        .sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity))[0] ?? null

  async function handleStart(): Promise<void> {
    if (!candidateTask) {
      await alertDialog({ title: 'Pick a task first', body: 'Focus sessions need a target.' })
      return
    }
    if (activeTaskId !== candidateTask.id) setActiveTask(candidateTask.id)
    await startSession(candidateTask.id, DEFAULT_SEC, '25min')
  }

  return (
    <div className="fb-card p-4 fb-glass-soft">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
          <Icon name="hourglass_empty" size={12} />
          <span>Focus Session</span>
        </div>
        {active && (
          <span
            className={`text-[10px] font-mono inline-flex items-center gap-1 ${
              isEngaged
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            <span className="relative inline-flex h-1.5 w-1.5">
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-70 animate-ping ${
                  isEngaged ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
              <span
                className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                  isEngaged ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
            </span>
            {isEngaged ? 'LIVE' : 'PAUSED'}
          </span>
        )}
      </div>
      <div className="flex items-center justify-center my-2">
        <div className="text-[44px] font-semibold tabular-nums text-[var(--ink-100)] leading-none tracking-tight">
          {fmtClock(displaySec)}
        </div>
      </div>
      <div className="text-center text-[11px] text-[var(--ink-50)] mb-3 truncate px-2">
        {active
          ? 'Deep work · stay with it'
          : candidateTask
            ? `Ready: "${candidateTask.title || '(untitled)'}"`
            : 'No task picked'}
      </div>
      <div className="flex items-center justify-center">
        {active ? (
          <button
            onClick={() => void finishSession('done')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[var(--surface-sunken)] hover:bg-[var(--surface-sunken)] text-[12px] font-medium text-[var(--ink-90)]"
          >
            <Icon name="stop_circle" size={14} />
            <span>End session</span>
          </button>
        ) : (
          <button
            onClick={() => void handleStart()}
            disabled={!candidateTask}
            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-md bg-accent text-white hover:brightness-110 disabled:opacity-50 text-[12px] font-medium shadow-md"
          >
            <Icon name="play_arrow" size={14} />
            <span>Start Session</span>
          </button>
        )}
      </div>
    </div>
  )
}
