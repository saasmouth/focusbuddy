// Edit › Keyboard shortcuts…: every key PlexiiDraw answers to, searchable and
// grouped as Illustrator's dialog groups them (Tools, Menu commands), with
// Illustrator's keys for what is still to come shown greyed. A row's key can
// be changed; the change is kept per profile and refused when it would clash.

import { useEffect, useMemo, useState } from 'react'
import Icon from '../../../Icon'
import type { DrawDialog, EditorCtx } from '../editor/types'
import { filterRows, shortcutRows, type ShortcutRow } from '../commands/keyCatalog'
import {
  checkRemap,
  eventKeyString,
  formatKey,
  keyOverrides,
  setKeyOverrides,
  subscribeKeyOverrides,
  type KeyTarget
} from '../commands/keys'
import { commandById } from '../commands/registry'
import { toolById } from '../tools/registry'

type Group = 'tools' | 'menu'

function describeTarget(t: KeyTarget): string {
  if (t.kind === 'tool') return `the ${toolById(t.id)?.label ?? t.id} tool`
  return `“${commandById(t.id)?.label ?? t.id}”`
}

function Keys({ keys, muted }: { keys: string[]; muted?: boolean }): JSX.Element {
  if (!keys.length) return <span className="text-[11px] text-[var(--ink-30)]">none</span>
  return (
    <span className="flex flex-wrap gap-1 justify-end">
      {keys.map((k) => (
        <kbd
          key={k}
          className={`px-1.5 py-px rounded border border-[var(--edge-soft)] text-[11px] fb-tabular ${muted ? 'text-[var(--ink-30)]' : 'text-[var(--ink-70)] bg-[var(--surface-sunken)]'}`}
        >
          {formatKey(k)}
        </kbd>
      ))}
    </span>
  )
}

function KeyboardShortcutsDialog(_: { ctx: EditorCtx; close: () => void }): JSX.Element {
  const [group, setGroup] = useState<Group>('tools')
  const [query, setQuery] = useState('')
  const [tick, setTick] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [message, setMessage] = useState<{ row: string; error?: string; note?: string } | null>(
    null
  )
  useEffect(() => subscribeKeyOverrides(() => setTick((n) => n + 1)), [])
  const rows = useMemo(() => shortcutRows(), [tick])
  const searching = query.trim().length > 0
  // A search covers both groups, as people search for a name, not a group.
  const shown = filterRows(searching ? rows : rows.filter((r) => r.group === group), query)
  const sections: Array<[string, ShortcutRow[]]> = []
  for (const r of shown) {
    const head = searching
      ? `${r.group === 'tools' ? 'Tools' : 'Menu commands'} · ${r.section}`
      : r.section
    const last = sections[sections.length - 1]
    if (last && last[0] === head) last[1].push(r)
    else sections.push([head, [r]])
  }
  const o = keyOverrides()
  const customised = Object.keys(o.commands).length + Object.keys(o.tools).length > 0
  const rowKey = (r: ShortcutRow): string => `${r.kind}:${r.id}`
  const isOverridden = (r: ShortcutRow): boolean =>
    r.kind === 'tool' ? r.id in o.tools : r.id in o.commands

  function save(r: ShortcutRow, key: string | null): void {
    const next = { commands: { ...o.commands }, tools: { ...o.tools } }
    const bucket = r.kind === 'tool' ? next.tools : next.commands
    const defaultKey = r.defaultKeys[0] ?? null
    // Back to the default is no override at all.
    if (key === defaultKey && r.defaultKeys.length <= 1) delete bucket[r.id]
    else bucket[r.id] = key
    setKeyOverrides(next)
  }

  function reset(r: ShortcutRow): void {
    const next = { commands: { ...o.commands }, tools: { ...o.tools } }
    delete (r.kind === 'tool' ? next.tools : next.commands)[r.id]
    setKeyOverrides(next)
    setMessage(null)
  }

  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="draw-shortcuts-dialog">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[var(--ink-50)]">Set:</span>
        <span className="font-medium text-[var(--ink-80)]" data-testid="draw-shortcuts-set">
          {customised ? 'Illustrator defaults, changed' : 'Illustrator defaults'}
        </span>
        {customised && (
          <button
            className="ml-auto text-[12px] text-accent hover:underline"
            data-testid="draw-shortcuts-reset-all"
            onClick={() => {
              setKeyOverrides({ commands: {}, tools: {} })
              setMessage(null)
            }}
          >
            Reset all to Illustrator defaults
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div
          className="inline-flex rounded border border-[var(--edge-soft)] overflow-hidden shrink-0"
          role="tablist"
        >
          {(['tools', 'menu'] as Group[]).map((g) => (
            <button
              key={g}
              role="tab"
              aria-selected={group === g && !searching}
              data-testid={`draw-shortcuts-group-${g}`}
              onClick={() => setGroup(g)}
              className={`px-2.5 py-1 text-[12px] ${group === g && !searching ? 'bg-accent/15 text-accent' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'}`}
            >
              {g === 'tools' ? 'Tools' : 'Menu commands'}
            </button>
          ))}
        </div>
        <label className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded border border-[var(--edge-soft)] bg-[var(--surface-sunken)]">
          <Icon name="search" size={14} className="text-[var(--ink-40)] shrink-0" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or key"
            aria-label="Search shortcuts"
            data-testid="draw-shortcuts-search"
            className="flex-1 min-w-0 bg-transparent outline-none text-[13px]"
          />
        </label>
      </div>

      <div className="max-h-[56vh] overflow-y-auto -mx-1 px-1" data-testid="draw-shortcuts-list">
        {!shown.length && (
          <p className="py-6 text-center text-[var(--ink-50)]" data-testid="draw-shortcuts-empty">
            No shortcut matches “{query.trim()}”.
          </p>
        )}
        {sections.map(([head, list]) => (
          <section key={head} className="mb-2">
            <h4 className="sticky top-0 bg-[var(--surface-raised,var(--surface))] py-1 text-[11px] uppercase tracking-wide text-[var(--ink-40)]">
              {head}
            </h4>
            {list.map((r) => {
              const id = rowKey(r)
              const off = r.kind === 'reserved' || !!r.reason
              return (
                <div
                  key={id}
                  data-testid={`draw-shortcut-row-${id}`}
                  className="py-1 border-b border-[var(--edge-soft)] last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div
                        className={`truncate ${off ? 'text-[var(--ink-40)]' : 'text-[var(--ink-80)]'}`}
                      >
                        {r.label}
                      </div>
                      {r.reason && (
                        <div className="text-[11px] text-[var(--ink-40)]">{r.reason}</div>
                      )}
                    </div>
                    {editing === id ? (
                      <input
                        autoFocus
                        readOnly
                        value=""
                        placeholder="Press keys…"
                        aria-label={`New key for ${r.label}`}
                        data-testid="draw-shortcut-recorder"
                        className="w-32 px-2 py-0.5 rounded border border-accent text-[12px] outline-none"
                        onBlur={() => setEditing(null)}
                        onKeyDown={(e) => {
                          e.preventDefault()
                          // Keep the press away from the app's own global keys.
                          e.stopPropagation()
                          e.nativeEvent.stopImmediatePropagation()
                          if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return
                          if (
                            e.key === 'Escape' &&
                            !e.metaKey &&
                            !e.ctrlKey &&
                            !e.altKey &&
                            !e.shiftKey
                          ) {
                            setEditing(null)
                            return
                          }
                          const k = eventKeyString(e.nativeEvent)
                          const check = checkRemap(
                            r.kind === 'tool' ? 'tool' : 'command',
                            r.id,
                            k,
                            describeTarget
                          )
                          if (check.error) {
                            setMessage({ row: id, error: check.error })
                            return
                          }
                          save(r, k)
                          setEditing(null)
                          setMessage(check.note ? { row: id, note: check.note } : null)
                        }}
                      />
                    ) : (
                      <Keys keys={r.keys} muted={off} />
                    )}
                    {r.remappable && editing !== id && (
                      <span className="flex items-center gap-0.5 shrink-0">
                        <button
                          className="icon-btn"
                          title={`Change the key for ${r.label}`}
                          aria-label={`Change the key for ${r.label}`}
                          data-testid={`draw-shortcut-edit-${id}`}
                          onClick={() => {
                            setMessage(null)
                            setEditing(id)
                          }}
                        >
                          <Icon name="edit" size={14} />
                        </button>
                        {r.keys.length > 0 && (
                          <button
                            className="icon-btn"
                            title={`Remove the key from ${r.label}`}
                            aria-label={`Remove the key from ${r.label}`}
                            data-testid={`draw-shortcut-clear-${id}`}
                            onClick={() => {
                              save(r, null)
                              setMessage(null)
                            }}
                          >
                            <Icon name="backspace" size={14} />
                          </button>
                        )}
                        {isOverridden(r) && (
                          <button
                            className="icon-btn"
                            title={`Back to Illustrator's key${r.defaultKeys.length ? ` (${r.defaultKeys.map((k) => formatKey(k)).join(', ')})` : ' (none)'}`}
                            aria-label={`Reset ${r.label}`}
                            data-testid={`draw-shortcut-reset-${id}`}
                            onClick={() => reset(r)}
                          >
                            <Icon name="restart_alt" size={14} />
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  {message?.row === id && (
                    <div
                      role={message.error ? 'alert' : 'status'}
                      data-testid="draw-shortcut-message"
                      className={`mt-0.5 text-[11px] ${message.error ? 'text-[var(--danger,#b42318)]' : 'text-[var(--ink-50)]'}`}
                    >
                      {message.error ?? message.note}
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))}
      </div>
      <p className="text-[11px] text-[var(--ink-40)]">
        Keys follow Illustrator’s defaults. Changes are kept for this profile only. Keys never fire
        while you type in a field or edit text on the canvas.
      </p>
    </div>
  )
}

const keyboardShortcuts: DrawDialog = {
  id: 'keyboard-shortcuts',
  title: 'Keyboard shortcuts',
  width: 620,
  component: KeyboardShortcutsDialog
}

export default keyboardShortcuts
