import { useCallback, useEffect, useState } from 'react'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { PLEXI_CARD } from '../plexi'
import ModuleDashboard from '../ModuleDashboard'
import { useQuickCreate } from '../../stores/quickCreate'
import { useLandOnContent } from '../../hooks/useLandOnContent'
import { bucketByWeek, periodDelta } from '../../lib/dashboardMetrics'
import FieldEditor from '../fields/FieldEditor'
import { useFormsStore } from '../../stores/forms'
import type { PlexiForm } from '@shared/forms'
import {
  type FbTable,
  type FbRow,
  type FieldDefinition,
  type FieldType,
  defaultConfig,
  defaultValue,
  FIELD_TYPE_LABELS
} from '@shared/fields'

// PlexiForms: design a form, fill it, and watch responses land as rows in its
// backing table (so they are instantly chartable and filterable). The fields ARE
// the table's columns. Reads only real responses; a new form is honestly empty.

const FORM_FIELD_TYPES: FieldType[] = ['text-short', 'text-long', 'number', 'single-select', 'date', 'checkbox']

type Tab = 'build' | 'fill' | 'responses'

export default function PlexiFormsView(): JSX.Element {
  const forms = useFormsStore((s) => s.forms)
  const loaded = useFormsStore((s) => s.loaded)
  const load = useFormsStore((s) => s.load)
  const createForm = useFormsStore((s) => s.create)
  const updateForm = useFormsStore((s) => s.update)
  const removeForm = useFormsStore((s) => s.remove)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const selected = forms.find((f) => f.id === selectedId) ?? null
  const { showOverview } = useLandOnContent(loaded, forms, selectedId, setSelectedId)
  const now = Date.now()

  async function addForm(): Promise<void> {
    const created = await createForm('New form')
    if (created) setSelectedId(created.id)
  }

  // Global quick-create (Cmd+K "New form").
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'forms' && useQuickCreate.getState().consume('forms')) void addForm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPending])

  return (
    <div className="h-full w-full flex bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexiforms-view">
      <div className="w-[280px] shrink-0 border-r border-[var(--edge-soft)] flex flex-col">
        <div className="px-4 py-3.5 border-b border-[var(--edge-soft)]">
          <div className="flex items-center gap-2">
            <PlexiiIcon kind="tool" id="forms" size={20} fallback="dynamic_form" fallbackFilled fallbackClassName="text-fuchsia-500" className="shrink-0" />
            <h1 className="text-[15px] font-bold tracking-tight text-[var(--ink-100)]">PlexiiForms</h1>
          </div>
          <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)]">Capture requests, leads and data.</p>
        </div>
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void addForm()}
              data-testid="form-new"
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-[rgb(var(--accent))] text-white text-[12px] font-medium hover:bg-[rgb(var(--accent-hover))]"
            >
              <Icon name="add" size={15} /> New form
            </button>
            {forms.length > 0 && (
              <button
                onClick={showOverview}
                data-testid="form-overview"
                title="Module overview"
                aria-label="Module overview"
                className={`inline-flex items-center justify-center h-[30px] w-[30px] rounded-md border text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] ${selectedId ? 'border-[var(--edge-soft)]' : 'border-[rgb(var(--accent)/0.40)] text-[rgb(var(--accent))]'}`}
              >
                <Icon name="dashboard" size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {!loaded ? (
            <div className="px-3 py-10 flex items-center justify-center gap-2 text-[12px] text-[var(--ink-70)]">
              <Icon name="progress_activity" size={15} className="text-[rgb(var(--accent))] animate-spin" /> Loading…
            </div>
          ) : forms.length === 0 ? (
            <div className="px-3 py-10 text-center" data-testid="forms-empty">
              <PlexiiIcon kind="tool" id="forms" size={32} fallback="dynamic_form" fallbackClassName="text-[var(--ink-30)]" className="mx-auto block" />
            </div>
          ) : (
            forms.map((f) => (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                data-testid={`form-row-${f.id}`}
                className={`w-full text-left rounded-lg px-3 py-2 mb-1 transition-colors ${
                  f.id === selectedId ? 'bg-[rgb(var(--accent)/0.10)] border border-[rgb(var(--accent)/0.30)]' : 'hover:bg-[var(--surface-sunken)] border border-transparent'
                }`}
              >
                <span className="text-[13px] font-medium text-[var(--ink-100)] truncate block">{f.title}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        {selected ? (
          <FormEditor
            key={selected.id}
            form={selected}
            onChangeMeta={(patch) => void updateForm(selected.id, patch)}
            onDelete={() => {
              void removeForm(selected.id)
              setSelectedId(null)
            }}
          />
        ) : (
          <ModuleDashboard
            moduleKey="forms"
            title="Forms"
            subtitle="Design a form and watch responses land as rows in a real, chartable table"
            icon="dynamic_form"
            accentClass="text-fuchsia-500"
            stats={[
              {
                icon: 'dynamic_form',
                label: 'Forms',
                value: forms.length,
                tone: 'violet',
                delta: periodDelta(forms.map((f) => f.createdAt), 7 * 86400000, now),
                sparkline: bucketByWeek(forms.map((f) => f.createdAt), 8, now)
              },
              { icon: 'edit_note', label: 'Described', value: forms.filter((f) => f.description.trim().length > 0).length, tone: 'accent' }
            ]}
            timeline={{
              title: 'Forms created',
              points: bucketByWeek(forms.map((f) => f.createdAt), 8, now),
              bucketLabel: 'last 8 weeks',
              unit: 'forms',
              tone: 'violet',
              emptyHint: 'Create your first form to start collecting responses.'
            }}
            recentItems={{
              label: 'Your forms',
              items: forms.slice(0, 6).map((f) => ({
                id: f.id,
                title: f.title,
                subtitle: f.description || 'No description yet',
                meta: `Updated ${new Date(f.updatedAt).toLocaleDateString()}`,
                onOpen: () => setSelectedId(f.id)
              })),
              onCreate: () => void addForm(),
              createLabel: 'New form',
              emptyHint: 'No forms yet. Create one to capture requests, leads or data, with each response saved as a real row.'
            }}
          />
        )}
      </div>
    </div>
  )
}

function FormEditor({
  form,
  onChangeMeta,
  onDelete
}: {
  form: PlexiForm
  onChangeMeta: (patch: { title?: string; description?: string }) => void
  onDelete: () => void
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('build')
  const [title, setTitle] = useState(form.title)
  const [table, setTable] = useState<FbTable | null>(null)
  const [rows, setRows] = useState<FbRow[]>([])

  const loadTable = useCallback(async () => {
    const t = await window.api.tables.get(form.tableId).catch(() => null)
    setTable(t)
    const r = await window.api.tables.listRows(form.tableId).catch(() => [] as FbRow[])
    setRows(r)
  }, [form.tableId])

  useEffect(() => {
    void loadTable()
  }, [loadTable])

  const columns: FieldDefinition[] = table?.schema.columns ?? []

  async function setColumns(next: FieldDefinition[]): Promise<void> {
    if (!table) return
    await window.api.tables.update(form.tableId, { schema: { ...table.schema, columns: next } }).catch(() => null)
    await loadTable()
  }
  async function addField(type: FieldType): Promise<void> {
    const id = `c-${Math.random().toString(36).slice(2, 8)}`
    const col = { id, type, label: FIELD_TYPE_LABELS[type], config: defaultConfig(type) } as FieldDefinition
    await setColumns([...columns, col])
  }
  async function patchField(id: string, p: Partial<FieldDefinition>): Promise<void> {
    await setColumns(columns.map((c) => (c.id === id ? ({ ...c, ...p } as FieldDefinition) : c)))
  }
  async function removeField(id: string): Promise<void> {
    await setColumns(columns.filter((c) => c.id !== id))
  }

  return (
    <div className="h-full flex flex-col" data-testid="form-editor">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--edge-soft)]">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== form.title && onChangeMeta({ title })}
          className="flex-1 bg-transparent text-[17px] font-bold text-[var(--ink-100)]"
          data-testid="form-title"
        />
        <div className="inline-flex rounded-md bg-[var(--surface-sunken)] overflow-hidden text-[12px] font-medium">
          {(['build', 'fill', 'responses'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              data-testid={`form-tab-${t}`}
              className={`px-3 py-1.5 capitalize ${tab === t ? 'bg-[rgb(var(--accent))] text-white' : 'text-[var(--ink-90)]'}`}
            >
              {t === 'responses' ? `Responses${rows.length ? ` (${rows.length})` : ''}` : t}
            </button>
          ))}
        </div>
        <button onClick={onDelete} className="p-1.5 rounded-md text-[var(--ink-40)] hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" title="Delete form" aria-label="Delete form" data-testid="form-delete">
          <Icon name="delete" size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-[620px] px-6 py-6">
          {tab === 'build' && (
            <BuildTab
              form={form}
              columns={columns}
              onChangeMeta={onChangeMeta}
              onAdd={addField}
              onPatch={patchField}
              onRemove={removeField}
            />
          )}
          {tab === 'fill' && <FillTab form={form} columns={columns} onSubmitted={loadTable} />}
          {tab === 'responses' && <ResponsesTab columns={columns} rows={rows} />}
        </div>
      </div>
    </div>
  )
}

function BuildTab({
  form,
  columns,
  onChangeMeta,
  onAdd,
  onPatch,
  onRemove
}: {
  form: PlexiForm
  columns: FieldDefinition[]
  onChangeMeta: (p: { description?: string }) => void
  onAdd: (t: FieldType) => void
  onPatch: (id: string, p: Partial<FieldDefinition>) => void
  onRemove: (id: string) => void
}): JSX.Element {
  const [desc, setDesc] = useState(form.description)
  const inputCls =
    'text-[12px] bg-[var(--surface-sunken)] rounded px-2 py-1 text-[var(--ink-100)] placeholder:text-[var(--ink-50)]'
  return (
    <div className="space-y-5">
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => desc !== form.description && onChangeMeta({ description: desc })}
        placeholder="Form description (optional)"
        rows={2}
        className="fb-card w-full resize-y px-3 py-2 text-[13px] text-[var(--ink-90)] placeholder:text-[var(--ink-50)]"
      />

      <div>
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-70)] mb-2">Fields</h2>
        <div className="space-y-2">
          {columns.map((c) => (
            <div key={c.id} className={`${PLEXI_CARD} flex items-center gap-2 px-3 py-2`} data-testid="form-field-row">
              <Icon name="drag_indicator" size={14} className="text-[var(--ink-30)]" />
              <input value={c.label} onChange={(e) => onPatch(c.id, { label: e.target.value })} className={`${inputCls} flex-1`} />
              <span className="text-[11px] text-[var(--ink-70)]">{FIELD_TYPE_LABELS[c.type]}</span>
              <button onClick={() => onRemove(c.id)} className="p-1 text-[var(--ink-70)] hover:text-red-600" title="Remove field" aria-label="Remove field">
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          {columns.length === 0 && <p className="text-[12px] text-[var(--ink-70)]">No fields yet. Add one below.</p>}
        </div>
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-[var(--ink-70)] mr-1">Add field</span>
          {FORM_FIELD_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => onAdd(t)}
              data-testid={`form-add-${t}`}
              className="fb-btn-surface px-2 py-1 text-[11.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
            >
              {FIELD_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function FillTab({ form, columns, onSubmitted }: { form: PlexiForm; columns: FieldDefinition[]; onSubmitted: () => Promise<void> }): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (submitting) return // guard against a double submit creating duplicate rows
    setSubmitting(true)
    setError(null)
    const cells: Record<string, unknown> = {}
    for (const c of columns) cells[c.id] = values[c.id] ?? defaultValue(c.type)
    try {
      const row = await window.api.tables.createRow({ tableId: form.tableId, cells })
      // Only confirm a save that actually happened. A null result means the
      // backing table is gone or the write failed; say so honestly and keep the
      // entered values so the response is not lost.
      if (!row) {
        setError('Could not save your response. The form may no longer be connected to a table.')
        return
      }
      setValues({})
      setDone(true)
      await onSubmitted()
      setTimeout(() => setDone(false), 2500)
    } catch {
      setError('Could not save your response. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (columns.length === 0) {
    return <p className="text-[12.5px] text-[var(--ink-70)] py-8 text-center">Add fields in Build mode first, then this form becomes fillable.</p>
  }

  return (
    <div className="space-y-4" data-testid="form-fill">
      {form.description && <p className="text-[13px] text-[var(--ink-90)]">{form.description}</p>}
      {columns.map((c) => (
        <label key={c.id} className="block">
          <span className="block text-[12.5px] font-medium text-[var(--ink-90)] mb-1">{c.label}</span>
          <FieldEditor
            def={c}
            value={values[c.id] ?? defaultValue(c.type)}
            variant="cell"
            onCommit={(v) => setValues((prev) => ({ ...prev, [c.id]: v }))}
          />
        </label>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => void submit()}
          disabled={submitting}
          data-testid="form-submit"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-semibold hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40"
        >
          <Icon name="send" size={15} /> {submitting ? 'Saving…' : 'Submit'}
        </button>
        {done && (
          <span className="text-[12px] text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1" data-testid="form-submitted">
            <Icon name="check_circle" size={14} /> Response saved
          </span>
        )}
        {error && (
          <span className="text-[12px] text-rose-500 inline-flex items-center gap-1" data-testid="form-submit-error">
            <Icon name="error_outline" size={14} /> {error}
          </span>
        )}
      </div>
    </div>
  )
}

function ResponsesTab({ columns, rows }: { columns: FieldDefinition[]; rows: FbRow[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="py-12 text-center">
        <Icon name="inbox" size={26} className="text-[var(--ink-30)]" />
        <p className="mt-2 text-[12.5px] text-[var(--ink-70)]">No responses yet. They appear here, and as rows in this form's table.</p>
      </div>
    )
  }
  return (
    <div className="overflow-auto" data-testid="form-responses">
      <table className="w-full text-[12px] fb-tabular">
        <thead>
          <tr className="border-b border-[var(--edge-soft)] text-left text-[var(--ink-70)]">
            {columns.map((c) => (
              <th key={c.id} className="px-2 py-1.5 font-medium">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[var(--edge-soft)]">
              {columns.map((c) => (
                <td key={c.id} className="px-2 py-1.5 text-[var(--ink-90)]">
                  {formatCell(r.cells[c.id])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}
