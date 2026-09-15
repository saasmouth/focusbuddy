import { useEffect, useState } from 'react'
import type { ExternalEvent, FbNode, TaskStatus, TimeBlock } from '@shared/types'
import Icon from '../Icon'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'

// One day, opened.
//
// The rule that shapes this: you can edit what this workspace owns, and you
// cannot edit what it mirrors. A task's date and status are ours; a time block
// is ours; a Google event belongs to Google. Offering an editable field for the
// third would produce a change that silently vanishes at the next sync, which
// is worse than not offering it.

export type DayItem =
  | { kind: 'task'; node: FbNode }
  | { kind: 'block'; block: TimeBlock }
  | { kind: 'external'; event: ExternalEvent }

const toDateInput = (ms: number | null | undefined): string => {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const fromDateInput = (v: string): number | null => {
  if (!v) return null
  const [y, m, d] = v.split('-').map(Number)
  return y && m && d ? new Date(y, m - 1, d).getTime() : null
}
const toTimeInput = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
const time = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export default function CalendarEntryModal({
  dayMs,
  items,
  onClose,
  onChanged
}: {
  dayMs: number
  items: DayItem[]
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(
    items.length === 1 ? keyOf(items[0]) : null
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/35 p-6"
      onClick={onClose}
      data-testid="calendar-day-modal-backdrop"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface-raised)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="calendar-day-modal"
      >
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-[var(--ink-90)]">
              {new Date(dayMs).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
              })}
            </div>
            <div className="text-[11px] text-[var(--ink-50)]">
              {items.length === 0
                ? 'Nothing scheduled'
                : `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12px] text-[var(--ink-45)]">
              Nothing falls on this day.
            </p>
          ) : (
            items.map((it) => {
              const k = keyOf(it)
              return (
                <div key={k} className="border-b border-[var(--line)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpenId(openId === k ? null : k)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-[var(--surface-sunken)]"
                  >
                    <span
                      className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                        it.kind === 'task'
                          ? 'bg-emerald-500'
                          : it.kind === 'block'
                            ? 'bg-violet-500'
                            : 'bg-sky-500'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-[var(--ink-90)]">
                        {titleOf(it)}
                      </span>
                      <span className="block truncate text-[10px] text-[var(--ink-45)]">
                        {subtitleOf(it)}
                      </span>
                    </span>
                    <Icon
                      name={openId === k ? 'expand_less' : 'expand_more'}
                      size={14}
                      className="shrink-0 text-[var(--ink-35)]"
                    />
                  </button>
                  {openId === k && (
                    <div className="px-4 pb-3">
                      {it.kind === 'task' && <TaskEditor node={it.node} onChanged={onChanged} onClose={onClose} />}
                      {it.kind === 'block' && <BlockEditor block={it.block} onChanged={onChanged} />}
                      {it.kind === 'external' && <ExternalDetail event={it.event} />}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

const keyOf = (i: DayItem): string =>
  i.kind === 'task' ? `t:${i.node.id}` : i.kind === 'block' ? `b:${i.block.id}` : `e:${i.event.id}`

const titleOf = (i: DayItem): string =>
  i.kind === 'task'
    ? i.node.title || 'Untitled task'
    : i.kind === 'block'
      ? i.block.title || 'Time block'
      : i.event.title || 'Untitled event'

const subtitleOf = (i: DayItem): string => {
  if (i.kind === 'task') return `Due · ${i.node.status}${i.node.assignee ? ` · ${i.node.assignee}` : ''}`
  if (i.kind === 'block') return `${time(i.block.startMs)} · ${i.block.durationMin}m`
  return i.event.allDay ? 'All day · subscribed' : `${time(i.event.startMs)} · subscribed`
}

const STATUSES: TaskStatus[] = ['open', 'in_progress', 'parked', 'done']

function TaskEditor({
  node,
  onChanged,
  onClose
}: {
  node: FbNode
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const update = useNodeStore((s) => s.update)
  const [title, setTitle] = useState(node.title)
  const [due, setDue] = useState(toDateInput(node.dueDate))
  const [assignee, setAssignee] = useState(node.assignee ?? '')

  useEffect(() => {
    setTitle(node.title)
    setDue(toDateInput(node.dueDate))
    setAssignee(node.assignee ?? '')
  }, [node.id, node.title, node.dueDate, node.assignee])

  const save = (patch: Record<string, unknown>): void => {
    void update(node.id, patch).then(onChanged)
  }

  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <input
        className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[12px]"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title !== node.title && save({ title })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <span className="text-[var(--ink-50)]">Due</span>
          <input
            type="date"
            className="rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
            value={due}
            onChange={(e) => {
              setDue(e.target.value)
              save({ dueDate: fromDateInput(e.target.value) })
            }}
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-[var(--ink-50)]">Status</span>
          <select
            className="rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
            value={node.status}
            onChange={(e) => save({ status: e.target.value as TaskStatus })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-1">
          <span className="shrink-0 text-[var(--ink-50)]">Who</span>
          <input
            className="min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
            placeholder="Unassigned"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={() => save({ assignee: assignee.trim() || null })}
          />
        </label>
      </div>
      <button
        type="button"
        className="self-start text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-90)]"
        onClick={() => {
          const deskId = node.parentId ?? node.id
          useViewStore.getState().goTask(deskId)
          onClose()
        }}
      >
        Open the desk this is on →
      </button>
    </div>
  )
}

function BlockEditor({ block, onChanged }: { block: TimeBlock; onChanged: () => void }): JSX.Element {
  const [title, setTitle] = useState(block.title)
  const [start, setStart] = useState(toTimeInput(block.startMs))
  const [mins, setMins] = useState(block.durationMin)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTitle(block.title)
    setStart(toTimeInput(block.startMs))
    setMins(block.durationMin)
  }, [block.id, block.title, block.startMs, block.durationMin])

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    const api = (window as unknown as { api?: { timeBlocks?: Record<string, any> } }).api
    if (!api?.timeBlocks?.update) {
      setError('Editing time blocks needs the desktop app.')
      return
    }
    try {
      await api.timeBlocks.update(block.id, patch)
      setError(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <input
        className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[12px]"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title !== block.title && void save({ title })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <span className="text-[var(--ink-50)]">Starts</span>
          <input
            type="time"
            className="rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              const [h, m] = e.target.value.split(':').map(Number)
              if (Number.isFinite(h) && Number.isFinite(m)) {
                const d = new Date(block.startMs)
                d.setHours(h, m, 0, 0)
                void save({ startMs: d.getTime() })
              }
            }}
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-[var(--ink-50)]">For</span>
          <input
            type="number"
            min={5}
            step={5}
            className="w-[64px] rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5 tabular-nums"
            value={mins}
            onChange={(e) => setMins(Number(e.target.value))}
            onBlur={() => mins !== block.durationMin && mins > 0 && void save({ durationMin: mins })}
          />
          <span className="text-[var(--ink-45)]">min</span>
        </label>
      </div>
      {error && <p className="text-[10px] text-rose-500">{error}</p>}
    </div>
  )
}

function ExternalDetail({ event }: { event: ExternalEvent }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      <div className="text-[var(--ink-70)]">
        {event.allDay
          ? 'All day'
          : `${time(event.startMs)} – ${time(event.endMs)}`}
      </div>
      {event.location && (
        <div className="flex items-center gap-1 text-[var(--ink-60)]">
          <Icon name="location_on" size={11} />
          {event.location}
        </div>
      )}
      {event.organizer && (
        <div className="flex items-center gap-1 text-[var(--ink-60)]">
          <Icon name="person" size={11} />
          {event.organizer}
        </div>
      )}
      {event.description && (
        <p className="whitespace-pre-wrap text-[11px] leading-snug text-[var(--ink-60)]">
          {event.description.slice(0, 600)}
        </p>
      )}
      {/* Read-only, and it says why. An editable field here would produce a
          change that silently vanishes at the next sync. */}
      <p className="text-[10px] text-[var(--ink-40)]">
        This comes from a subscribed calendar, so it is read-only here.
        {event.url ? ' Open it where it lives to change it.' : ''}
      </p>
      {event.url && (
        <button
          type="button"
          className="self-start text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-90)]"
          onClick={() => {
            const api = (window as unknown as { api?: { files?: { openExternal?: (u: string) => void } } })
              .api
            if (event.url) api?.files?.openExternal?.(event.url)
          }}
        >
          Open in its own calendar →
        </button>
      )}
    </div>
  )
}
