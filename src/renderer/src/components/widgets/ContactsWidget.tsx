import { useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'

// The people on this desk.
//
// Deliberately the desk's OWN list rather than a filtered view of a global
// address book, because no such book exists: peopleDirectory is an in-memory
// list the renderer pushes each session for @-mentions, and there is no table
// tying a person to a desk. A widget that implied otherwise would be showing a
// filter over nothing.
//
// So this holds its own people. That is the honest version today, and it is
// also the useful one: the four people on a deal are not a filter of four
// hundred, they are a short list somebody curated. If a contacts store arrives
// later, this reads from it and keeps the same face.

export interface DeskContact {
  name: string
  role?: string
  /** A short state worth seeing at a glance: Hot, Warm, Vendor, Solicitor. */
  tag?: string
  tone?: 'hot' | 'warm' | 'cool' | 'neutral'
  phone?: string
  email?: string
}

interface ContactsContent {
  groups?: string[]
  contacts: DeskContact[]
  activeGroup?: string
}

function parse(raw: string | null | undefined): ContactsContent {
  if (!raw) return { contacts: [] }
  try {
    const p = JSON.parse(raw) as ContactsContent
    return Array.isArray(p?.contacts) ? p : { contacts: [] }
  } catch {
    return { contacts: [] }
  }
}

const TONES: Record<string, string> = {
  hot: 'bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300',
  warm: 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
  cool: 'bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--ink-60)]'
}

const initials = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'

export default function ContactsWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const model = useMemo(() => parse(widget.content), [widget.content])
  const [copied, setCopied] = useState<string | null>(null)

  const groups = model.groups ?? []
  const active = model.activeGroup ?? 'All'
  const shown = active === 'All' ? model.contacts : model.contacts.filter((c) => c.role === active || c.tag === active)

  const setGroup = (g: string): void => {
    void update(widget.id, { content: JSON.stringify({ ...model, activeGroup: g }) })
  }

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      window.setTimeout(() => setCopied(null), 1400)
    } catch {
      /* clipboard refused; the value is on screen either way */
    }
  }

  return (
    <WidgetFrame widget={widget} headerLabel="Contacts" headerAccent="bg-teal-200/50 dark:bg-teal-400/10">
      <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]">
        {groups.length > 0 && (
          <div className="flex items-center gap-1 px-2 pt-1.5 pb-1 flex-wrap">
            {['All', ...groups].map((g) => (
              <button
                key={g}
                onClick={() => setGroup(g)}
                className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                  g === active ? 'bg-accent/10 text-accent font-medium' : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto px-1 pb-1">
          {shown.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-4">
              <Icon name="group" size={18} className="text-[var(--ink-40)]" />
              <div className="fb-t-caption text-[var(--ink-60)]">Nobody here yet</div>
              <div className="text-[10px] text-[var(--ink-40)] leading-snug max-w-[200px]">
                The handful of people this desk is actually about.
              </div>
            </div>
          ) : (
            shown.map((c, i) => (
              <div key={c.name + i} className="group flex items-center gap-2 px-1.5 py-[6px] rounded hover:bg-[var(--surface-sunken)]">
                <span className="h-6 w-6 rounded-full shrink-0 grid place-items-center text-[10px] font-semibold bg-accent/15 text-accent">
                  {initials(c.name)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] text-[var(--ink-90)] truncate">{c.name}</span>
                  {c.role && <span className="block text-[10px] text-[var(--ink-50)] truncate">{c.role}</span>}
                </span>
                {c.tag && (
                  <span className={`shrink-0 px-1.5 py-[1px] rounded-full text-[10px] font-medium ${TONES[c.tone ?? 'neutral']}`}>
                    {c.tag}
                  </span>
                )}
                {c.phone && (
                  <button
                    onClick={() => void copy(c.phone!)}
                    title={`Copy ${c.phone}`}
                    className="shrink-0 text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-90)] tabular-nums opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    {copied === c.phone ? 'copied' : c.phone}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </WidgetFrame>
  )
}
