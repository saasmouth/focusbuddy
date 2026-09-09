import { useEffect, useRef, useState } from 'react'
import type {
  FbRow,
  FbTable,
  FieldDefinition,
  FieldType,
  SelectOption
} from '@shared/fields'
import { defaultValue } from '@shared/fields'
import type { DocType } from '@shared/types'
import { useTablesStore } from '../../stores/tables'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'
import DocPickerModal from '../DocPickerModal'
import { useDocMetas, primeDocMeta } from '../../lib/docMetaCache'
import { fileSrc } from '../../lib/fileUrl'

// One field editor used everywhere a typed value is edited: standalone canvas
// field widgets, table cells, page-block fields. The component is variant-
// driven so it can render compactly inside a tight table cell or generously
// inside a 300px canvas widget without forking the code path.

export type FieldVariant = 'cell' | 'widget'

export interface FieldEditorProps {
  def: FieldDefinition
  value: unknown
  variant: FieldVariant
  // Called with the new value on commit (blur / enter / chip-toggle). The
  // caller is responsible for persisting — this component is value-controlled.
  onCommit: (next: unknown) => void
  // Optional autofocus on mount (used when the user just added a new row
  // and we want their cursor in the first cell).
  autoFocus?: boolean
}

export default function FieldEditor(rawProps: FieldEditorProps): JSX.Element {
  // Defensive: every sub-input reads def.config (e.g. CheckboxInput reads
  // config.label). A field/column with no config — legacy rows, an imported or
  // seeded table — must degrade to defaults, not white-screen the canvas. Make
  // config at least an empty object before dispatching.
  const props: FieldEditorProps = rawProps.def.config
    ? rawProps
    : { ...rawProps, def: { ...rawProps.def, config: {} } as unknown as FieldDefinition }
  const { def, value } = props
  switch (def.type) {
    case 'text-short':
      return <ShortText {...props} value={(value as string) ?? ''} />
    case 'text-long':
      return <LongText {...props} value={(value as string) ?? ''} />
    case 'text-rich':
      // Rich text in cells is shown as a compact preview; widget variant
      // gets the full Tiptap inline. To avoid pulling Tiptap into every
      // table render we use a textarea fallback in cell variant.
      return <LongText {...props} value={(value as string) ?? ''} />
    case 'number':
      return (
        <NumberInput {...props} value={(value as number | null) ?? null} />
      )
    case 'checkbox':
      return <CheckboxInput {...props} value={Boolean(value)} />
    case 'single-select':
      return (
        <SingleSelect {...props} value={(value as string | null) ?? null} />
      )
    case 'multi-select':
      return (
        <MultiSelect {...props} value={Array.isArray(value) ? (value as string[]) : []} />
      )
    case 'date':
      return <DateInput {...props} value={(value as number | null) ?? null} />
    case 'attachment':
      return (
        <Attachment {...props} value={Array.isArray(value) ? (value as string[]) : []} />
      )
    case 'button':
      return <ButtonField {...props} />
    case 'relation':
      return (
        <RelationField {...props} value={Array.isArray(value) ? (value as string[]) : []} />
      )
    case 'doc-ref':
      return (
        <DocRefField {...props} value={Array.isArray(value) ? (value as string[]) : []} />
      )
    default:
      // All FieldType variants are covered above; if this branch is ever
      // reached at runtime, `def` is something we don't know how to render
      // (e.g. a future type loaded from an upgraded DB).
      return <UnsupportedField type={(def as FieldDefinition).type} />
  }
}

const DOC_TYPE_ICON: Record<DocType, string> = {
  doc: 'description',
  sheet: 'table_chart',
  slides: 'slideshow',
  map: 'account_tree',
  design: 'palette'
}

// Cell/widget editor for the doc-ref field: chips referencing PlexiOffice
// documents. Click a chip to open the document; add via a searchable office-file
// picker; a table cell also accepts documents dropped onto it (handled by the
// table, which commits the id here). Renders the document's live title/type via
// the shared doc-meta cache.
function DocRefField(props: FieldEditorProps & { value: string[] }): JSX.Element {
  const { value, variant, onCommit, def } = props
  const cfg = (def.config ?? {}) as { docType?: string; multi?: boolean }
  const multi = cfg.multi !== false
  const [pickerOpen, setPickerOpen] = useState(false)
  const metas = useDocMetas(value)
  const goDocument = useViewStore((s) => s.goDocument)

  function addDoc(id: string): void {
    if (value.includes(id)) return
    onCommit(multi ? [...value, id] : [id])
  }
  function removeDoc(id: string): void {
    onCommit(value.filter((v) => v !== id))
  }

  const compact = variant === 'cell'
  return (
    <div className={`flex flex-wrap items-center gap-1 ${compact ? '' : 'p-1'}`}>
      {value.map((id) => {
        const meta = metas[id]
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 max-w-full rounded-md bg-[var(--surface-sunken)] pl-1.5 pr-1 py-0.5"
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                goDocument(id)
              }}
              className="inline-flex items-center gap-1 min-w-0"
              title={meta ? `Open ${meta.title}` : 'Open document'}
            >
              <Icon
                name={meta ? DOC_TYPE_ICON[meta.docType] : 'description'}
                size={12}
                className="text-[rgb(var(--accent))] shrink-0"
              />
              <span className="text-[11.5px] text-[var(--ink-80)] truncate">
                {meta ? meta.title || 'Untitled' : 'Document'}
              </span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                removeDoc(id)
              }}
              className="text-[var(--ink-40)] hover:text-[var(--ink-90)] shrink-0"
              title="Remove"
            >
              <Icon name="close" size={11} />
            </button>
          </span>
        )
      })}
      {(multi || value.length === 0) && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            setPickerOpen(true)
          }}
          data-testid="doc-ref-add"
          className="fb-btn-surface inline-flex items-center gap-0.5 border-dashed text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:border-[rgb(var(--accent)/0.5)] px-1.5 py-0.5 text-[11px]"
          title="Reference an office file"
        >
          <Icon name="add" size={12} /> {value.length === 0 ? 'Office file' : ''}
        </button>
      )}
      {pickerOpen && (
        <DocPickerModal
          title="Reference an office file"
          onlyType={cfg.docType as DocType | undefined}
          onPick={(d) => {
            primeDocMeta(d.id, { title: d.title, docType: d.docType })
            addDoc(d.id)
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

function UnsupportedField({ type }: { type: FieldType }): JSX.Element {
  return (
    <span className="text-[10px] text-amber-700 dark:text-amber-400">
      unsupported field: {type}
    </span>
  )
}

// ── Subcomponents ────────────────────────────────────────────────────────────
// Each one is intentionally small. The cell variant uses a tight chromeless
// input that expands to fill the cell; the widget variant gets a labelled
// chromed input.

interface SubProps<V> {
  def: FieldDefinition
  value: V
  variant: FieldVariant
  onCommit: (next: unknown) => void
  autoFocus?: boolean
}

function ShortText({ def, value, variant, onCommit, autoFocus }: SubProps<string>): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const config = def.config as { placeholder?: string }
  return (
    <input
      autoFocus={autoFocus}
      value={draft}
      placeholder={config.placeholder ?? def.label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className={
        variant === 'cell'
          ? 'w-full bg-transparent px-2 py-1 fb-body focus:bg-[var(--surface-raised)]'
          : 'fb-field w-full bg-[var(--surface-raised)] px-2 py-1.5 fb-body'
      }
    />
  )
}

function LongText({ def, value, variant, onCommit }: SubProps<string>): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const config = def.config as { placeholder?: string }
  return (
    <textarea
      value={draft}
      placeholder={config.placeholder ?? def.label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft)
      }}
      rows={variant === 'cell' ? 1 : 4}
      className={
        variant === 'cell'
          ? 'w-full bg-transparent px-2 py-1 fb-body resize-none focus:bg-[var(--surface-raised)]'
          : 'fb-field w-full bg-[var(--surface-raised)] px-2 py-1.5 fb-body resize-y'
      }
    />
  )
}

function NumberInput({
  def,
  value,
  variant,
  onCommit
}: SubProps<number | null>): JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  useEffect(() => {
    setDraft(value === null ? '' : String(value))
  }, [value])
  const config = def.config as { prefix?: string; suffix?: string }
  return (
    <div className="inline-flex items-center gap-1 w-full">
      {config.prefix && (
        <span className="text-[11px] text-[var(--ink-50)]">
          {config.prefix}
        </span>
      )}
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = draft === '' ? null : Number(draft)
          if (n === null || Number.isFinite(n)) {
            if (n !== value) onCommit(n)
          }
        }}
        className={
          variant === 'cell'
            ? 'flex-1 bg-transparent px-1 py-1 fb-body text-right focus:bg-[var(--surface-raised)]'
            : 'fb-field flex-1 bg-[var(--surface-raised)] px-2 py-1.5 fb-body text-right'
        }
      />
      {config.suffix && (
        <span className="text-[11px] text-[var(--ink-50)]">
          {config.suffix}
        </span>
      )}
    </div>
  )
}

function CheckboxInput({ def, value, onCommit }: SubProps<boolean>): JSX.Element {
  const config = def.config as { label?: string }
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onCommit(e.target.checked)}
        className="h-3.5 w-3.5 rounded accent-emerald-600 cursor-pointer"
      />
      {config.label && (
        <span className="text-[12px] text-[var(--ink-70)]">
          {config.label}
        </span>
      )}
    </label>
  )
}

function chipStyleFor(opt: SelectOption | undefined): React.CSSProperties {
  if (!opt) return {}
  const color = opt.color ?? '#78716c'
  return { backgroundColor: `${color}26`, color }
}

function SingleSelect({
  def,
  value,
  onCommit
}: SubProps<string | null>): JSX.Element {
  const [open, setOpen] = useState(false)
  const config = def.config as { options?: SelectOption[] }
  const options = config.options ?? []
  const ref = useRef<HTMLDivElement | null>(null)
  const selected = options.find((o) => o.id === value) ?? null
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2 py-1 text-[12px] hover:bg-[var(--surface-sunken)] rounded inline-flex items-center gap-1"
      >
        {selected ? (
          <span
            className="px-1.5 py-0.5 rounded text-[11px]"
            style={chipStyleFor(selected)}
          >
            {selected.label}
          </span>
        ) : (
          <span className="text-[var(--ink-40)]">—</span>
        )}
      </button>
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 mt-1 left-0 min-w-[160px] py-1">
          <button
            onClick={() => {
              onCommit(null)
              setOpen(false)
            }}
            className="block w-full text-left text-[11px] px-2 py-1 hover:bg-[var(--surface-sunken)] text-[var(--ink-40)]"
          >
            (none)
          </button>
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => {
                onCommit(opt.id)
                setOpen(false)
              }}
              className="block w-full text-left px-2 py-1 hover:bg-[var(--surface-sunken)]"
            >
              <span
                className="px-1.5 py-0.5 rounded text-[11px]"
                style={chipStyleFor(opt)}
              >
                {opt.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MultiSelect({
  def,
  value,
  onCommit
}: SubProps<string[]>): JSX.Element {
  const [open, setOpen] = useState(false)
  const config = def.config as { options?: SelectOption[] }
  const options = config.options ?? []
  const ref = useRef<HTMLDivElement | null>(null)
  const selected = options.filter((o) => value.includes(o.id))
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  function toggle(id: string): void {
    const next = value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    onCommit(next)
  }
  return (
    <div ref={ref} className="relative w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2 py-1 text-[12px] hover:bg-[var(--surface-sunken)] rounded inline-flex flex-wrap items-center gap-1"
      >
        {selected.length === 0 ? (
          <span className="text-[var(--ink-40)]">—</span>
        ) : (
          selected.map((opt) => (
            <span
              key={opt.id}
              className="px-1.5 py-0.5 rounded text-[11px]"
              style={chipStyleFor(opt)}
            >
              {opt.label}
            </span>
          ))
        )}
      </button>
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 mt-1 left-0 min-w-[160px] py-1 max-h-60 overflow-y-auto">
          {options.map((opt) => {
            const checked = value.includes(opt.id)
            return (
              <button
                key={opt.id}
                onClick={() => toggle(opt.id)}
                className="block w-full text-left px-2 py-1 hover:bg-[var(--surface-sunken)] inline-flex items-center gap-1.5"
              >
                <span className="h-3 w-3 rounded-sm inline-flex items-center justify-center border border-[var(--edge-firm)]">
                  {checked && <Icon name="check" size={10} />}
                </span>
                <span
                  className="px-1.5 py-0.5 rounded text-[11px]"
                  style={chipStyleFor(opt)}
                >
                  {opt.label}
                </span>
              </button>
            )
          })}
          {options.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-[var(--ink-40)]">
              No options defined
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DateInput({ def, value, variant, onCommit }: SubProps<number | null>): JSX.Element {
  const config = def.config as { withTime?: boolean }
  const asString = value
    ? config.withTime
      ? new Date(value).toISOString().slice(0, 16)
      : new Date(value).toISOString().slice(0, 10)
    : ''
  return (
    <input
      type={config.withTime ? 'datetime-local' : 'date'}
      value={asString}
      onChange={(e) => {
        const v = e.target.value
        if (!v) onCommit(null)
        else onCommit(new Date(v).getTime())
      }}
      className={
        variant === 'cell'
          ? 'w-full bg-transparent px-1 py-1 fb-body focus:bg-[var(--surface-raised)]'
          : 'fb-field w-full bg-[var(--surface-raised)] px-2 py-1.5 fb-body'
      }
    />
  )
}

function Attachment({
  value,
  onCommit
}: SubProps<string[]>): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  async function onPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    const buffer = await file.arrayBuffer()
    const ingested = await window.api.files.ingestBuffer({
      buffer,
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream'
    })
    onCommit([...value, ingested.id])
    if (inputRef.current) inputRef.current.value = ''
  }
  async function onRemove(id: string): Promise<void> {
    onCommit(value.filter((v) => v !== id))
    await window.api.files.delete(id)
  }
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {value.map((id) => (
        <AttachmentChip key={id} fileId={id} onRemove={() => void onRemove(id)} />
      ))}
      <button
        onClick={() => inputRef.current?.click()}
        className="fb-btn-surface inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 border-dashed text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
      >
        <Icon name="add" size={10} />
        attach
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => void onPick(e)}
      />
    </div>
  )
}

function AttachmentChip({
  fileId,
  onRemove
}: {
  fileId: string
  onRemove: () => void
}): JSX.Element {
  const [name, setName] = useState<string>('…')
  useEffect(() => {
    let cancelled = false
    void window.api.files.get(fileId).then((f) => {
      if (!cancelled && f) setName(f.originalName)
    })
    return () => {
      cancelled = true
    }
  }, [fileId])
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--surface-sunken)]">
      <Icon name="attach_file" size={10} />
      <a
        href={fileSrc(fileId)}
        target="_blank"
        rel="noreferrer"
        className="max-w-[100px] truncate underline-offset-2 hover:underline"
      >
        {name}
      </a>
      <button
        onClick={onRemove}
        className="text-[var(--ink-40)] hover:text-red-600"
        title="Remove"
      >
        <Icon name="close" size={10} />
      </button>
    </span>
  )
}

function ButtonField({ def }: SubProps<unknown>): JSX.Element {
  const config = def.config as {
    action: 'shell' | 'ai-prompt'
    payload: string
    label?: string
  }
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  async function run(): Promise<void> {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      if (config.action === 'ai-prompt') {
        // Reuse the existing chat:send IPC. Single-shot prompt; result shown
        // inline. Future: stream to a target field instead.
        const r = await window.api.chat.send({
          taskId: null,
          messages: [{ role: 'user', content: config.payload, ts: Date.now() }]
        })
        setResult(
          r.ok ? r.message?.content ?? '(empty response)' : r.error ?? 'failed'
        )
      } else {
        // Shell execution lives on the renderer side via a future shell IPC.
        // For MVP we surface a friendly placeholder so the field is usable
        // immediately even before the shell handler ships.
        setResult('Shell execution not yet enabled — coming soon.')
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => void run()}
        disabled={busy}
        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-accent text-white hover:opacity-90 disabled:opacity-60"
      >
        <Icon name={busy ? 'autorenew' : 'play_arrow'} size={11} />
        <span>{busy ? 'Running…' : config.label ?? 'Run'}</span>
      </button>
      {result !== null && (
        <div className="text-[10px] text-[var(--ink-70)] whitespace-pre-wrap break-words max-h-32 overflow-y-auto bg-[var(--surface-sunken)] rounded px-1.5 py-1">
          {result}
        </div>
      )}
    </div>
  )
}

// Small helper used by callers that need a fresh default — avoids importing
// `defaultValue` separately from a value-bearing component.
export function emptyValueFor(type: FieldType): unknown {
  return defaultValue(type)
}

// ── Relation field ──────────────────────────────────────────────────────────
//
// Renders a list of chips for currently-linked rows, plus a "+ link" button
// that opens a picker over the configured target table. Rows are looked up
// via the tables store so we benefit from the in-memory cache and don't have
// to refetch every render.
//
// "Display column" picking — if config.displayColumnId is set, we show that
// column's value as the chip label; otherwise we show the row's first
// text-like cell value, falling back to the row id's first segment.
function RelationField({
  def,
  value,
  variant,
  onCommit
}: SubProps<string[]>): JSX.Element {
  const config = def.config as {
    tableId: string | null
    displayColumnId?: string | null
    multi?: boolean
  }
  const tables = useTablesStore((s) => s.tables)
  const rowsByTable = useTablesStore((s) => s.rows)
  const ensureTable = useTablesStore((s) => s.ensureTableLoaded)
  const ensureRows = useTablesStore((s) => s.ensureRowsLoaded)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // Load the bound table + its rows lazily so we don't fetch every relation
  // on canvas mount.
  useEffect(() => {
    if (!config.tableId) return
    void ensureTable(config.tableId)
    void ensureRows(config.tableId)
  }, [config.tableId, ensureTable, ensureRows])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const table: FbTable | null = config.tableId ? tables[config.tableId] ?? null : null
  const rows: FbRow[] = config.tableId ? rowsByTable[config.tableId] ?? [] : []

  if (!config.tableId || !table) {
    // No target table picked yet — show a compact "configure" affordance.
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
        <Icon name="link_off" size={11} />
        <span>Set target table</span>
      </span>
    )
  }

  function rowLabel(row: FbRow): string {
    if (config.displayColumnId && config.displayColumnId in row.cells) {
      const v = row.cells[config.displayColumnId]
      if (typeof v === 'string' && v) return v
      if (typeof v === 'number') return String(v)
    }
    // Fallback: first text-like column.
    if (!table) return row.id.slice(0, 6)
    for (const col of table.schema.columns) {
      if (col.type === 'text-short' || col.type === 'text-long') {
        const v = row.cells[col.id]
        if (typeof v === 'string' && v) return v
      }
    }
    return row.id.slice(0, 6)
  }

  const linked = value.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as FbRow[]
  const available = rows.filter((r) => !value.includes(r.id))
  const multi = config.multi !== false

  function toggle(rowId: string): void {
    if (multi) {
      onCommit(value.includes(rowId) ? value.filter((v) => v !== rowId) : [...value, rowId])
    } else {
      onCommit(value.includes(rowId) ? [] : [rowId])
      setOpen(false)
    }
  }

  function remove(rowId: string): void {
    onCommit(value.filter((v) => v !== rowId))
  }

  return (
    <div ref={ref} className="relative w-full">
      <div className="flex flex-wrap items-center gap-1">
        {linked.length === 0 && (
          <span className="text-[var(--ink-40)] text-[11px]">—</span>
        )}
        {linked.map((row) => (
          <span
            key={row.id}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-accent/10 text-accent border border-accent/20"
          >
            <Icon name="link" size={9} />
            <span className="max-w-[120px] truncate">{rowLabel(row)}</span>
            <button
              onClick={() => remove(row.id)}
              className="opacity-60 hover:opacity-100"
              title="Unlink"
            >
              <Icon name="close" size={9} />
            </button>
          </span>
        ))}
        <button
          onClick={() => setOpen((v) => !v)}
          className={
            variant === 'cell'
              ? 'fb-btn-surface inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 border-dashed text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
              : 'fb-btn-surface inline-flex items-center gap-0.5 text-[11px] px-2 py-0.5 border-dashed text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
          }
        >
          <Icon name="add" size={10} />
          link
        </button>
      </div>
      {open && (
        <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 mt-1 left-0 min-w-[200px] max-h-64 overflow-y-auto py-1">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--ink-40)] border-b border-[var(--edge-soft)]">
            {table.title} — pick {multi ? 'records' : 'a record'}
          </div>
          {available.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-[var(--ink-40)] text-center">
              {rows.length === 0 ? 'No rows in target table yet.' : 'All rows linked.'}
            </div>
          )}
          {available.map((row) => (
            <button
              key={row.id}
              onClick={() => toggle(row.id)}
              className="w-full text-left px-2 py-1 hover:bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-70)] truncate"
            >
              {rowLabel(row)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
