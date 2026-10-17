import { useEffect, useState } from 'react'
import type { Widget } from '@shared/types'
import type { FieldDefinition, FieldType } from '@shared/fields'
import {
  FIELD_TYPE_ICONS,
  FIELD_TYPE_LABELS,
  defaultConfig,
  defaultValue
} from '@shared/fields'
import WidgetFrame from './WidgetFrame'
import FieldEditor from '../fields/FieldEditor'
import RelationConfigEditor from '../fields/RelationConfigEditor'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import ConnectedToolMenu from '../contextMenu/UnifiedConnectedMenu'

interface Props {
  widget: Widget
  inline?: boolean
}

// widget.content holds the field's JSON state:
//   { def: FieldDefinition, value: unknown }
//
// Stored as a single blob so the existing widget update path doesn't need to
// know anything about fields. Type-safe parsing on read.

interface FieldState {
  def: FieldDefinition
  value: unknown
}

function parseFieldState(raw: string): FieldState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.def && typeof parsed.def.type === 'string') {
      return parsed as FieldState
    }
  } catch {
    // fall through
  }
  return null
}

function stringifyFieldState(state: FieldState): string {
  return JSON.stringify(state)
}

export default function FieldWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [state, setState] = useState<FieldState | null>(() =>
    parseFieldState(widget.content)
  )
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setState(parseFieldState(widget.content))
  }, [widget.content])

  async function chooseType(type: FieldType): Promise<void> {
    const def: FieldDefinition = {
      id: 'f1',
      type,
      label: FIELD_TYPE_LABELS[type],
      config: defaultConfig(type) as never
    } as FieldDefinition
    const next: FieldState = { def, value: defaultValue(type) }
    setState(next)
    await update(widget.id, {
      content: stringifyFieldState(next),
      title: FIELD_TYPE_LABELS[type]
    })
  }

  async function commit(nextValue: unknown): Promise<void> {
    if (!state) return
    const next: FieldState = { def: state.def, value: nextValue }
    setState(next)
    await update(widget.id, { content: stringifyFieldState(next) })
  }

  async function updateLabel(label: string): Promise<void> {
    if (!state) return
    const next: FieldState = { def: { ...state.def, label } as FieldDefinition, value: state.value }
    setState(next)
    await update(widget.id, { content: stringifyFieldState(next), title: label })
  }

  async function updateConfig(config: unknown): Promise<void> {
    if (!state) return
    const next: FieldState = {
      def: { ...state.def, config } as FieldDefinition,
      value: state.value
    }
    setState(next)
    await update(widget.id, { content: stringifyFieldState(next) })
  }

  // Picker — shown when no type chosen yet.
  if (!state) {
    const body = (
      <div className="min-h-full w-full bg-[var(--surface-sunken)] p-3">
        <div className="flex items-center gap-1.5 mb-3">
          <Icon name="tune" size={14} className="text-accent shrink-0" />
          <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--ink-70)]">
            Pick a field type
          </div>
        </div>
        <p className="text-[11px] text-[var(--ink-50)] mb-3 leading-snug">
          Choose what this work widget captures — once set, you can type its label and enter a value.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
            <button
              key={t}
              onClick={() => void chooseType(t)}
              className="fb-btn-surface inline-flex items-center gap-1.5 px-2 py-2 hover:border-accent hover:bg-accent/5 text-left transition-colors"
            >
              <Icon name={FIELD_TYPE_ICONS[t]} size={15} className="text-accent shrink-0" />
              <span className="text-[12px] text-[var(--ink-70)] leading-tight">
                {FIELD_TYPE_LABELS[t]}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
    if (inline) return body
    return (
      <WidgetFrame widget={widget} headerLabel="Field" headerAccent="bg-stone-300/60 dark:bg-white/[0.09]">
        {body}
      </WidgetFrame>
    )
  }

  const body = (
    <div
      className="min-h-full w-full bg-[var(--surface-raised)] p-3 flex flex-col gap-2.5"
      onContextMenu={(e) => {
        // Right-click anywhere on the field body opens the "Create +
        // connect" menu. Shift bypass restores the native menu on
        // inputs/selects for cut/copy/paste.
        if (e.shiftKey) return
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="flex items-center gap-1.5 pb-1.5 border-b border-[var(--edge-soft)]">
        <Icon
          name={FIELD_TYPE_ICONS[state.def.type]}
          size={15}
          className="text-accent shrink-0"
        />
        <input
          value={state.def.label}
          onChange={(e) => void updateLabel(e.target.value)}
          placeholder="Field label"
          className="flex-1 bg-transparent text-[13px] font-semibold text-[var(--ink-90)] placeholder:text-[var(--ink-30)]"
        />
        <span className="text-[9px] uppercase tracking-wider text-[var(--ink-40)]">
          {FIELD_TYPE_LABELS[state.def.type]}
        </span>
      </div>

      <div className="text-[10px] uppercase tracking-wider text-[var(--ink-40)]">
        Value
      </div>
      <div className="flex-1">
        <FieldEditor
          def={state.def}
          value={state.value}
          variant="widget"
          onCommit={(next) => void commit(next)}
        />
      </div>

      {(state.def.type === 'single-select' || state.def.type === 'multi-select') && (
        <SelectOptionsEditor
          options={
            (state.def.config as { options: { id: string; label: string; color?: string }[] })
              .options ?? []
          }
          onChange={(options) => void updateConfig({ ...state.def.config, options })}
        />
      )}

      {state.def.type === 'button' && (
        <ButtonConfigEditor
          config={state.def.config as {
            action: 'shell' | 'ai-prompt'
            payload: string
            label?: string
          }}
          onChange={(c) => void updateConfig(c)}
        />
      )}

      {state.def.type === 'relation' && (
        <div className="border-t border-[var(--edge-soft)] pt-2 mt-1">
          <RelationConfigEditor
            config={state.def.config as {
              tableId: string | null
              displayColumnId?: string | null
              multi?: boolean
            }}
            onChange={(c) => void updateConfig(c)}
          />
        </div>
      )}
      {ctxMenu && (
        <ConnectedToolMenu
          sourceWidgetId={widget.id}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame
      widget={widget}
      headerLabel={state.def.label || FIELD_TYPE_LABELS[state.def.type]}
      headerAccent="bg-stone-300/60 dark:bg-white/[0.09]"
    >
      {body}
    </WidgetFrame>
  )
}

// ── Inline option editor for select fields ───────────────────────────────────
// Tucked at the bottom of the field widget when type is single/multi select.
// Lets the user define labels without leaving the canvas.
function SelectOptionsEditor({
  options,
  onChange
}: {
  options: { id: string; label: string; color?: string }[]
  onChange: (next: { id: string; label: string; color?: string }[]) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899']
  function add(): void {
    const label = draft.trim()
    if (!label) return
    const id = `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const color = palette[options.length % palette.length]
    onChange([...options, { id, label, color }])
    setDraft('')
  }
  function remove(id: string): void {
    onChange(options.filter((o) => o.id !== id))
  }
  return (
    <div className="border-t border-[var(--edge-soft)] pt-2 mt-1">
      <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-1">
        Options
      </div>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {options.map((o) => (
          <span
            key={o.id}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
            style={{ backgroundColor: `${o.color ?? '#78716c'}26`, color: o.color ?? '#78716c' }}
          >
            {o.label}
            <button
              onClick={() => remove(o.id)}
              className="opacity-60 hover:opacity-100"
              title="Remove"
            >
              <Icon name="close" size={9} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder="New option…"
          className="fb-field flex-1 bg-[var(--surface-raised)] px-2 py-1 text-[11px]"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="text-[10px] px-2 py-1 rounded bg-accent text-white disabled:opacity-50"
        >
          add
        </button>
      </div>
    </div>
  )
}

function ButtonConfigEditor({
  config,
  onChange
}: {
  config: { action: 'shell' | 'ai-prompt'; payload: string; label?: string }
  onChange: (next: typeof config) => void
}): JSX.Element {
  return (
    <div className="border-t border-[var(--edge-soft)] pt-2 mt-1 space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)]">
        Button setup
      </div>
      <select
        value={config.action}
        onChange={(e) =>
          onChange({ ...config, action: e.target.value as 'shell' | 'ai-prompt' })
        }
        className="fb-field w-full text-[11px] bg-[var(--surface-raised)] px-2 py-1"
      >
        <option value="ai-prompt">AI prompt</option>
        <option value="shell">Shell command</option>
      </select>
      <input
        value={config.label ?? ''}
        onChange={(e) => onChange({ ...config, label: e.target.value })}
        placeholder="Button label"
        className="fb-field w-full text-[11px] bg-[var(--surface-raised)] px-2 py-1"
      />
      <textarea
        value={config.payload}
        onChange={(e) => onChange({ ...config, payload: e.target.value })}
        placeholder={
          config.action === 'ai-prompt'
            ? 'Prompt for Claude…'
            : 'Shell command — e.g. say "hello"'
        }
        rows={3}
        className="fb-field w-full text-[11px] bg-[var(--surface-raised)] px-2 py-1 resize-y"
      />
    </div>
  )
}
