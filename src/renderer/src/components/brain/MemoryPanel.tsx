import { useEffect, useState } from 'react'
import Icon from '../Icon'
import type { MemoryItem, MemoryKind } from '@shared/types'
import { noLocalModelNote } from '../../lib/localAiOffer'

// Manage what the assistant durably knows about you: view facts, standing
// preferences and open commitments, remember something by hand, forget an item,
// or have the local model learn from your documents. Honest throughout — an empty
// store says so, and extraction with no local model says why rather than pretending.

const GROUPS: { kind: MemoryKind; label: string; icon: string }[] = [
  { kind: 'commitment', label: 'Open commitments', icon: 'event' },
  { kind: 'preference', label: 'Standing preferences', icon: 'tune' },
  { kind: 'fact', label: 'Facts', icon: 'info' }
]

export default function MemoryPanel(): JSX.Element {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryKind>('fact')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function reload(): Promise<void> {
    try {
      setItems(await window.api.memory.list())
    } catch {
      setItems([])
    }
  }
  useEffect(() => {
    void reload()
  }, [])

  async function remember(): Promise<void> {
    const t = text.trim()
    if (!t) return
    await window.api.memory.remember({ kind, text: t })
    setText('')
    void reload()
  }
  async function forget(id: string): Promise<void> {
    await window.api.memory.forget(id)
    void reload()
  }
  async function learn(): Promise<void> {
    setBusy(true)
    setNote(null)
    try {
      const r = await window.api.memory.extractDocuments()
      if (r.reason === 'no_local_model') {
        // Say what is actually missing on THIS computer (the bundled model is
        // the engine; Ollama is only an advanced fallback).
        const st = await window.api.localAi?.getStatus?.().catch(() => null)
        setNote(noLocalModelNote(st ?? null))
      } else {
        setNote(`Learned ${r.added} item${r.added === 1 ? '' : 's'} from ${r.scanned} document${r.scanned === 1 ? '' : 's'}.`)
      }
    } catch (e) {
      setNote(`Could not learn from documents: ${(e as Error).message || 'unknown error'}`)
    } finally {
      setBusy(false)
      void reload()
    }
  }

  const btn =
    'text-[11px] px-2 py-1 fb-btn-surface fb-press text-[var(--ink-70)] disabled:opacity-50'

  return (
    <div className="mt-3 pt-3 border-t border-[var(--edge-soft)]" data-testid="memory-panel">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-[var(--ink-50)]">
          What the assistant knows about you
        </span>
        <button onClick={() => void learn()} disabled={busy} className={btn} data-testid="memory-learn">
          {busy ? 'Learning…' : 'Learn from my documents'}
        </button>
      </div>

      <div className="flex gap-1.5 mb-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind)}
          className="fb-field text-[11px] px-1.5"
        >
          <option value="fact">Fact</option>
          <option value="preference">Preference</option>
          <option value="commitment">Commitment</option>
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void remember()
          }}
          placeholder="Remember this…"
          className="fb-field flex-1 min-w-0 text-[12px] px-2 py-1"
        />
        <button onClick={() => void remember()} disabled={!text.trim()} className={btn} data-testid="memory-remember">
          Remember
        </button>
      </div>

      {note && <div className="text-[11px] text-[var(--ink-60)] mb-2 leading-snug">{note}</div>}

      {items.length === 0 ? (
        <div className="text-[11px] text-[var(--ink-40)] italic">
          Nothing remembered yet. Add something above, or learn from your documents.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {GROUPS.map((g) => {
            const group = items.filter((m) => m.kind === g.kind)
            if (group.length === 0) return null
            return (
              <div key={g.kind}>
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--ink-40)] mb-0.5">
                  <Icon name={g.icon} size={11} />
                  {g.label}
                </div>
                <ul className="space-y-0.5">
                  {group.map((m) => (
                    <li key={m.id} className="flex items-start gap-1.5 text-[11px] group">
                      <span className="flex-1 text-[var(--ink-70)] leading-snug">
                        {m.text}
                        {m.due ? <span className="text-[var(--ink-40)]"> (due {m.due})</span> : null}
                        {m.source === 'extracted' ? (
                          <span className="text-[var(--ink-30)]"> · learned</span>
                        ) : null}
                      </span>
                      <button
                        onClick={() => void forget(m.id)}
                        title="Forget this"
                        className="opacity-0 group-hover:opacity-100 text-[var(--ink-40)] hover:text-red-500 shrink-0"
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
