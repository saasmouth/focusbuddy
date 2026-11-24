import { useEffect, useRef, useState } from 'react'
import { useGrowToFit, GROW_MAX_HEIGHT } from '../../lib/useGrowToFit'
import { promptText } from '../plexi/PromptDialog'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import {
  saveTemplate,
  listTemplates,
  deleteTemplate,
  subscribe,
  type BlockData,
  type BlockField,
  type BlockFieldType
} from '../../lib/customBlockTemplates'
import { useSaveOnUnmount } from '../../lib/useSaveOnUnmount'
import { useWidgetReadOnly } from '../../lib/widgetSurface'

// Custom Block — a WYSIWYG form/record designer. In DESIGN mode the user drops
// typed fields and positions/resizes them freely; in USE mode the same block is
// a data-entry form whose values persist as the record. Layout + values live in
// widget.content; a layout can be saved as a personal template (cross-task).

const FIELD_TYPES: { type: BlockFieldType; icon: string; label: string }[] = [
  { type: 'text', icon: 'short_text', label: 'Text' },
  { type: 'textarea', icon: 'notes', label: 'Paragraph' },
  { type: 'number', icon: 'tag', label: 'Number' },
  { type: 'date', icon: 'calendar_today', label: 'Date' },
  { type: 'email', icon: 'alternate_email', label: 'Email' },
  { type: 'url', icon: 'link', label: 'URL' },
  { type: 'select', icon: 'arrow_drop_down_circle', label: 'Select' },
  { type: 'checkbox', icon: 'check_box', label: 'Checkbox' },
  { type: 'heading', icon: 'title', label: 'Heading' },
  { type: 'divider', icon: 'horizontal_rule', label: 'Divider' }
]

const DEFAULT_SIZE: Record<BlockFieldType, { w: number; h: number }> = {
  text: { w: 200, h: 58 },
  textarea: { w: 240, h: 96 },
  number: { w: 160, h: 58 },
  date: { w: 180, h: 58 },
  email: { w: 220, h: 58 },
  url: { w: 220, h: 58 },
  select: { w: 200, h: 58 },
  checkbox: { w: 180, h: 34 },
  heading: { w: 320, h: 34 },
  divider: { w: 320, h: 14 }
}

const DEFAULT_DATA: BlockData = { title: 'Untitled block', fields: [] }

function parse(content: string): BlockData {
  if (!content) return { ...DEFAULT_DATA, fields: [] }
  try {
    const p = JSON.parse(content) as Partial<BlockData>
    return {
      title: p.title ?? DEFAULT_DATA.title,
      fields: Array.isArray(p.fields) ? p.fields : []
    }
  } catch {
    return { ...DEFAULT_DATA, fields: [] }
  }
}

function uid(): string {
  try {
    return crypto.randomUUID().slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function CustomBlockWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [data, setData] = useState<BlockData>(() => parse(widget.content))
  // A fresh, empty block opens in design mode; an existing one opens in use mode.
  // A viewer (read-only, lib/widgetSurface) sees the filled-in form: never the
  // designer, no title or mode or template controls, each field's value as text.
  const readOnly = useWidgetReadOnly()
  const [modeChosen, setMode] = useState<'design' | 'use'>(() =>
    parse(widget.content).fields.length === 0 ? 'design' : 'use'
  )
  const mode = readOnly ? 'use' : modeChosen
  const [selected, setSelected] = useState<string | null>(null)
  const [tplMenu, setTplMenu] = useState(false)
  const [, forceTpl] = useState(0)
  const growRef = useRef<HTMLDivElement | null>(null)
  // Show the whole form without the reader having to resize first.
  // Grow-only and capped — see useGrowToFit.
  useGrowToFit(widget, growRef, { maxHeight: GROW_MAX_HEIGHT['custom-block'], disabled: inline }, [widget.content, mode])
  const lastSaved = useRef(widget.content)

  useEffect(() => subscribe(() => forceTpl((n) => n + 1)), [])

  useEffect(() => {
    const next = JSON.stringify(data)
    if (next === lastSaved.current) return
    const h = window.setTimeout(() => {
      lastSaved.current = next
      void update(widget.id, { content: next })
    }, 300)
    return () => window.clearTimeout(h)
  }, [data, widget.id, update])

  // Write an edit still waiting for its debounce when the widget goes away (lib/useSaveOnUnmount).
  useSaveOnUnmount(() => {
    const next = JSON.stringify(data)
    if (next === lastSaved.current) return
    lastSaved.current = next
    void update(widget.id, { content: next })
  })

  // Adopt fields/values pushed in from a synced sibling (live sync), so a linked
  // copy updates without a remount/refresh. Compared against lastSaved so our
  // own debounced save doesn't re-trigger; design mode + selection are untouched.
  useEffect(() => {
    if (widget.content !== lastSaved.current) {
      lastSaved.current = widget.content
      setData(parse(widget.content))
    }
  }, [widget.content])

  const setFields = (fn: (f: BlockField[]) => BlockField[]): void =>
    setData((d) => ({ ...d, fields: fn(d.fields) }))
  const patchField = (id: string, patch: Partial<BlockField>): void =>
    setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  function addField(type: BlockFieldType): void {
    const size = DEFAULT_SIZE[type]
    // Stagger new fields so they don't stack exactly.
    const n = data.fields.length
    const field: BlockField = {
      id: uid(),
      type,
      label:
        type === 'heading'
          ? 'Section heading'
          : type === 'divider'
            ? ''
            : FIELD_TYPES.find((t) => t.type === type)?.label ?? 'Field',
      x: 16 + (n % 3) * 16,
      y: 16 + n * 14,
      w: size.w,
      h: size.h,
      ...(type === 'select' ? { options: ['Option 1', 'Option 2'] } : {})
    }
    setFields((fs) => [...fs, field])
    setSelected(field.id)
  }

  // ── Drag / resize a field within the block (design mode) ──────────────────
  function beginFieldDrag(e: React.PointerEvent, id: string, mode: 'move' | 'resize'): void {
    e.stopPropagation()
    e.preventDefault()
    const field = data.fields.find((f) => f.id === id)
    if (!field) return
    const start = { x: e.clientX, y: e.clientY, fx: field.x, fy: field.y, fw: field.w, fh: field.h }
    const zoom = useWidgetStore.getState().zoom || 1
    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - start.x) / zoom
      const dy = (ev.clientY - start.y) / zoom
      if (mode === 'move') {
        patchField(id, { x: Math.max(0, Math.round(start.fx + dx)), y: Math.max(0, Math.round(start.fy + dy)) })
      } else {
        patchField(id, { w: Math.max(60, Math.round(start.fw + dx)), h: Math.max(24, Math.round(start.fh + dy)) })
      }
    }
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const sel = data.fields.find((f) => f.id === selected) ?? null
  const templates = listTemplates()

  function doSaveTemplate(): void {
    void promptText({
      title: 'Save as template',
      label: 'Name this layout so you can spawn it again from the palette.',
      initial: data.title || 'My block',
      confirmLabel: 'Save template'
    }).then((name) => {
      if (name === null) return
      saveTemplate(name, data)
    })
  }
  function applyTemplate(tplId: string): void {
    const tpl = listTemplates().find((t) => t.id === tplId)
    if (!tpl) return
    // Re-id the fields so multiple instances of the same template are independent.
    setData({
      title: tpl.data.title,
      fields: tpl.data.fields.map((f) => ({ ...f, id: uid(), value: undefined }))
    })
    setSelected(null)
    setTplMenu(false)
    setMode('use')
  }

  const content = (
    <div className="flex flex-col h-full w-full bg-[var(--surface-raised)]">
      {/* Toolbar */}
      {readOnly ? (
        data.title && (
          <div className="shrink-0 px-2 py-1.5 border-b border-[var(--edge-soft)] text-[13px] font-semibold text-[var(--ink-100)] truncate">{data.title}</div>
        )
      ) : (
      <div
        className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-[var(--edge-soft)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          value={data.title}
          onChange={(e) => setData((d) => ({ ...d, title: e.target.value }))}
          className="flex-1 min-w-0 bg-transparent text-[13px] font-semibold text-[var(--ink-100)]"
          placeholder="Block title"
        />
        <div className="flex items-center rounded-full bg-[var(--surface-sunken)] p-0.5 text-[11px]">
          {(['design', 'use'] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m)
                setSelected(null)
              }}
              className={`px-2 py-0.5 rounded-full capitalize transition-colors ${
                mode === m
                  ? 'bg-[var(--surface-raised)] text-[var(--ink-100)] shadow-sm'
                  : 'text-[var(--ink-50)]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="relative">
          <button
            onClick={() => setTplMenu((v) => !v)}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            title="Templates"
            aria-label="Templates"
          >
            <Icon name="bookmarks" size={14} />
          </button>
          {tplMenu && (
            <div
              className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 top-7 z-20 w-56 py-1 text-[12px]"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  doSaveTemplate()
                  setTplMenu(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--surface-sunken)] text-[var(--ink-90)]"
              >
                <Icon name="bookmark_add" size={14} />
                Save as template…
              </button>
              {templates.length > 0 && (
                <div className="my-1 h-px bg-[var(--surface-sunken)]" />
              )}
              <div className="max-h-48 overflow-y-auto">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className="group/tpl flex items-center px-3 py-1.5 hover:bg-[var(--surface-sunken)]"
                  >
                    <button
                      onClick={() => applyTemplate(t.id)}
                      className="flex-1 min-w-0 text-left truncate text-[var(--ink-90)]"
                      title={`Insert "${t.name}"`}
                    >
                      {t.name}
                    </button>
                    <button
                      onClick={() => deleteTemplate(t.id)}
                      className="opacity-0 group-hover/tpl:opacity-100 group-focus-within/tpl:opacity-100 text-[var(--ink-40)] hover:text-rose-500"
                      aria-label="Delete template"
                    >
                      <Icon name="delete" size={13} />
                    </button>
                  </div>
                ))}
                {templates.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-[var(--ink-40)]">No templates yet.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      )}
      {/* Field palette (design mode) */}
      {mode === 'design' && (
        <div
          className="shrink-0 flex flex-wrap gap-1 px-2 py-1.5 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {FIELD_TYPES.map((t) => (
            <button
              key={t.type}
              onClick={() => addField(t.type)}
              className="fb-btn-surface inline-flex items-center gap-1 px-1.5 py-1 hover:border-accent text-[10px] text-[var(--ink-70)]"
              title={`Add ${t.label}`}
            >
              <Icon name={t.icon} size={13} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Selected-field config bar (design mode) */}
      {mode === 'design' && sel && (
        <div
          className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--edge-soft)] bg-accent/5"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sel.type !== 'divider' && (
            <input
              value={sel.label}
              onChange={(e) => patchField(sel.id, { label: e.target.value })}
              placeholder="Label"
              className="fb-field flex-1 min-w-0 bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
            />
          )}
          {sel.type === 'select' && (
            <input
              value={(sel.options ?? []).join(', ')}
              onChange={(e) =>
                patchField(sel.id, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
              }
              placeholder="Option A, Option B"
              className="fb-field flex-1 min-w-0 bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
            />
          )}
          {sel.type !== 'divider' && sel.type !== 'heading' && (
            <label className="flex items-center gap-1 text-[11px] text-[var(--ink-70)] whitespace-nowrap">
              <input
                type="checkbox"
                checked={!!sel.required}
                onChange={(e) => patchField(sel.id, { required: e.target.checked })}
                className="accent-accent"
              />
              required
            </label>
          )}
          <button
            onClick={() => {
              setFields((fs) => fs.filter((f) => f.id !== sel.id))
              setSelected(null)
            }}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-50)] hover:text-rose-500 hover:bg-rose-500/10"
            title="Delete field"
            aria-label="Delete field"
          >
            <Icon name="delete" size={14} />
          </button>
        </div>
      )}

      {/* Field surface */}
      <div
        ref={growRef}
        className={`relative flex-1 min-h-0 overflow-auto ${
          mode === 'design'
            ? 'bg-[radial-gradient(circle,_rgba(120,113,108,0.18)_1px,_transparent_1px)] [background-size:16px_16px]'
            : ''
        }`}
        onMouseDown={() => mode === 'design' && setSelected(null)}
      >
        {data.fields.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-[var(--ink-40)] pointer-events-none">
            {mode === 'design'
              ? 'Add fields from the palette, then drag to arrange them.'
              : 'This block has no fields yet.'}
          </div>
        )}
        {data.fields.map((f) => (
          <div
            key={f.id}
            style={{ position: 'absolute', left: f.x, top: f.y, width: f.w, height: f.h }}
            className={
              mode === 'design'
                ? `rounded border ${selected === f.id ? 'border-accent ring-1 ring-accent/40' : 'border-[var(--edge-soft)]'} bg-[color-mix(in_oklab,var(--surface-raised)_70%,transparent)]`
                : ''
            }
            onMouseDown={(e) => {
              if (mode === 'design') {
                e.stopPropagation()
                setSelected(f.id)
              }
            }}
          >
            {/* Drag handle (design) */}
            {mode === 'design' && f.type !== 'divider' && (
              <div
                onPointerDown={(e) => beginFieldDrag(e, f.id, 'move')}
                className="absolute -top-0.5 left-0 right-0 h-4 cursor-move flex items-center justify-center"
                title="Drag to move"
              >
                <Icon name="drag_indicator" size={12} className="text-[var(--ink-40)] rotate-90" />
              </div>
            )}
            {mode === 'design' && f.type === 'divider' && (
              <div
                onPointerDown={(e) => beginFieldDrag(e, f.id, 'move')}
                className="absolute inset-0 cursor-move"
                title="Drag to move"
              />
            )}

            <div className={mode === 'design' ? 'p-1.5 pt-4 h-full' : 'h-full'}>
              {readOnly ? <FieldValue field={f} /> : <FieldControl field={f} mode={mode} onValue={(v) => patchField(f.id, { value: v })} />}
            </div>

            {/* Resize handle (design) */}
            {mode === 'design' && f.type !== 'divider' && (
              <div
                onPointerDown={(e) => beginFieldDrag(e, f.id, 'resize')}
                className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
                title="Resize"
              >
                <span className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 border-r-2 border-b-2 border-[var(--edge-firm)]" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="custom block" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]">
      {content}
    </WidgetFrame>
  )
}

// A field as a viewer reads it: its label and its value, as text.
function FieldValue({ field }: { field: BlockField }): JSX.Element {
  if (field.type === 'heading') return <div className="text-[15px] font-semibold text-[var(--ink-100)] truncate">{field.label}</div>
  if (field.type === 'divider') return <div className="h-px w-full bg-[var(--surface-sunken)] mt-1.5" />
  if (field.type === 'checkbox') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--ink-90)]">
        <span role="img" aria-label={field.value === true ? 'Ticked' : 'Not ticked'} className="text-[var(--ink-70)]">
          <Icon name={field.value === true ? 'check_box' : 'check_box_outline_blank'} size={16} />
        </span>
        {field.label}
      </div>
    )
  }
  const value = typeof field.value === 'string' ? field.value : ''
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--ink-50)] mb-0.5 truncate">{field.label}</div>
      <div className={`text-[12px] text-[var(--ink-100)] break-words ${field.type === 'textarea' ? 'whitespace-pre-wrap overflow-auto' : 'truncate'}`}>{value}</div>
    </div>
  )
}

// Renders a field as a label + control. In design mode controls are disabled
// (the surface is for layout); in use mode they're live data-entry inputs.
function FieldControl({
  field,
  mode,
  onValue
}: {
  field: BlockField
  mode: 'design' | 'use'
  onValue: (v: string | boolean) => void
}): JSX.Element {
  const disabled = mode === 'design'
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  const inputCls =
    'fb-card w-full px-2 py-1 text-[12px] text-[var(--ink-100)] focus:border-accent disabled:bg-[var(--surface-sunken)]'
  const labelEl =
    field.type !== 'divider' && field.type !== 'heading' && field.type !== 'checkbox' ? (
      <div className="text-[10px] uppercase tracking-wide text-[var(--ink-50)] mb-0.5 truncate">
        {field.label}
        {field.required && <span className="text-rose-500"> *</span>}
      </div>
    ) : null

  if (field.type === 'heading') {
    return <div className="text-[15px] font-semibold text-[var(--ink-100)] truncate">{field.label}</div>
  }
  if (field.type === 'divider') {
    return <div className="h-px w-full bg-[var(--surface-sunken)] mt-1.5" />
  }
  if (field.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-[12px] text-[var(--ink-90)]">
        <input
          type="checkbox"
          checked={field.value === true}
          disabled={disabled}
          onMouseDown={stop}
          onChange={(e) => onValue(e.target.checked)}
          className="accent-accent h-4 w-4"
        />
        {field.label}
      </label>
    )
  }
  if (field.type === 'textarea') {
    return (
      <div className="flex flex-col h-full">
        {labelEl}
        <textarea
          value={(field.value as string) ?? ''}
          disabled={disabled}
          onMouseDown={stop}
          onChange={(e) => onValue(e.target.value)}
          className={`${inputCls} flex-1 min-h-0 resize-none`}
        />
      </div>
    )
  }
  if (field.type === 'select') {
    return (
      <div>
        {labelEl}
        <select
          value={(field.value as string) ?? ''}
          disabled={disabled}
          onMouseDown={stop}
          onChange={(e) => onValue(e.target.value)}
          className={inputCls}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    )
  }
  const inputType =
    field.type === 'number'
      ? 'number'
      : field.type === 'date'
        ? 'date'
        : field.type === 'email'
          ? 'email'
          : field.type === 'url'
            ? 'url'
            : 'text'
  return (
    <div>
      {labelEl}
      <input
        type={inputType}
        value={(field.value as string) ?? ''}
        disabled={disabled}
        onMouseDown={stop}
        onChange={(e) => onValue(e.target.value)}
        className={inputCls}
      />
    </div>
  )
}
