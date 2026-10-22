import { useEffect, useMemo, useState } from 'react'
import type { FbTable } from '@shared/fields'
import type { MapNode } from '@shared/types'
import type { GenerateKind } from '@shared/diagram/data'
import { primaryColumn } from '@shared/diagram/data'
import { useTablesStore } from '../../../stores/tables'
import { SEGMENT_APPS } from '../../../lib/segmentApps'
import { WIDGET_CATALOG } from '../../../lib/widgetCatalog'
import WidgetPickerDialog from '../embed/WidgetPickerDialog'
import Icon from '../../Icon'
import PlexiiIcon from '../../PlexiiIcon'
import { segmentAppEntity } from '../../../lib/plexiiIconMap'
import AnsweredBy from '../../ai/AnsweredBy'
import { useAiBusyLabel } from '../../../lib/localAiEngine'
import * as ops from '@shared/diagram/ops'
import type { Commands } from './commands'
import type { MapTemplateId } from '../map/mapTemplates'

// Modal dialogs for PlexiDiagrams. Each is a thin form over a command.

function Modal({ title, icon, onClose, children, width = 460, testid }: { title: string; icon: string; onClose: () => void; children: React.ReactNode; width?: number; testid?: string }): JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="fb-scrim absolute inset-0 z-40 flex items-center justify-center" onMouseDown={onClose}>
      <div className="fb-card max-w-[92%] max-h-[88%] overflow-auto p-4 space-y-3" style={{ width }} onMouseDown={(e) => e.stopPropagation()} data-testid={testid}>
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink-90)]">
          <Icon name={icon} size={16} className="text-[#2563eb]" />
          <span className="flex-1">{title}</span>
          <button type="button" onClick={onClose} className="icon-btn" title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ModeToggle({ mode, setMode }: { mode: 'add' | 'replace'; setMode: (m: 'add' | 'replace') => void }): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-[11px] text-[var(--ink-70)]">
      <label className="flex items-center gap-1">
        <input type="radio" checked={mode === 'add'} onChange={() => setMode('add')} className="accent-[#2563eb]" /> Add to this page
      </label>
      <label className="flex items-center gap-1">
        <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} className="accent-[#2563eb]" /> Replace this page
      </label>
    </div>
  )
}

/** AI generation, rendered in the shared right side pane (owner: AI panels live in ShellSidePane). */
export function AiPane({ cmd }: { cmd: Commands }): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const warmLabel = useAiBusyLabel()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'add' | 'replace'>('replace')
  const run = async (): Promise<void> => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const err = await cmd.aiGenerate(prompt.trim(), mode)
      if (err) setError(err)
      else setDone(mode === 'replace' ? 'Diagram generated. Undo (⌘Z) restores the previous page.' : 'Added to the page. Undo (⌘Z) removes it.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="p-3 flex flex-col gap-2">
      <p className="text-[11px] text-[var(--ink-50)]">Describe a process, decision flow, system or structure. The model returns the steps and connections; PlexiiDiagrams lays them out.</p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
        }}
        rows={4}
        placeholder="e.g. Customer onboarding from signup to first value, with an approval step"
        className="fb-field w-full px-2 py-1.5 text-[12px]"
        data-testid="diagram-ai-prompt"
      />
      <ModeToggle mode={mode} setMode={setMode} />
      {error && <div className="text-[11px] text-red-600">{error}</div>}
      {done && <div role="status" className="text-[11px] text-[var(--ink-60)]" data-testid="diagram-ai-done">{done}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => void run()} disabled={busy || !prompt.trim()} className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50" data-testid="map-ai-run">
          {busy ? warmLabel('Generating…') : 'Generate'}
        </button>
      </div>
      <AnsweredBy feature="office" className="mt-1" />
      <p className="text-[10px] text-[var(--ink-40)]">⌘/Ctrl+Enter to run. Undo (⌘Z) restores the previous page.</p>
    </div>
  )
}

export function MermaidDialog({ cmd, onClose }: { cmd: Commands; onClose: () => void }): JSX.Element {
  const [text, setText] = useState('flowchart TD\n  A[Start] --> B{Approved?}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Revise]\n  D --> B')
  const [mode, setMode] = useState<'add' | 'replace'>('add')
  const [warnings, setWarnings] = useState<string[]>([])
  return (
    <Modal title="Import Mermaid" icon="code" onClose={onClose} width={520} testid="diagram-mermaid-dialog">
      <p className="text-[11px] text-[var(--ink-50)]">Paste a Mermaid flowchart, ER diagram or class diagram. Shapes, labels, line styles and subgraphs come across; the result is laid out automatically.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} rows={10} className="fb-field w-full px-2 py-1.5 text-[12px] font-mono" data-testid="diagram-mermaid-text" />
      <ModeToggle mode={mode} setMode={setMode} />
      {warnings.length > 0 && (
        <ul className="text-[11px] text-amber-700 list-disc pl-4 max-h-24 overflow-auto">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="text-[12px] px-3 py-1.5 text-[var(--ink-50)]">
          Close
        </button>
        <button
          type="button"
          className="btn-primary text-[12px] px-3 py-1.5"
          data-testid="diagram-mermaid-import"
          onClick={() => {
            const w = cmd.importMermaid(text, mode)
            setWarnings(w)
            if (!w.length) onClose()
          }}
        >
          Import
        </button>
      </div>
    </Modal>
  )
}

const TEMPLATES: { id: MapTemplateId; label: string; icon: string; blurb: string }[] = [
  { id: 'flowchart', label: 'Flowchart', icon: 'schema', blurb: 'Start, steps, a decision and an end.' },
  { id: 'orgchart', label: 'Org chart', icon: 'account_tree', blurb: 'A reporting tree.' },
  { id: 'mindmap', label: 'Mind map', icon: 'hub', blurb: 'A central idea with branches.' },
  { id: 'swimlane', label: 'Approval flow', icon: 'view_column', blurb: 'Swimlanes by role.' }
]

export function TemplatesDialog({ cmd, onClose, onMermaid }: { cmd: Commands; onClose: () => void; onMermaid: () => void }): JSX.Element {
  const [mode, setMode] = useState<'add' | 'replace'>('replace')
  return (
    <Modal title="Templates" icon="dashboard" onClose={onClose} width={520} testid="diagram-templates-dialog">
      <div className="grid grid-cols-2 gap-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              cmd.applyTemplate(t.id, mode)
              onClose()
            }}
            data-testid={`diagram-template-${t.id}`}
            className="text-left rounded-lg border border-[var(--edge-soft)] hover:border-[#2563eb] p-3"
          >
            <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--ink-90)]">
              <Icon name={t.icon} size={16} className="text-[#2563eb]" />
              {t.label}
            </div>
            <div className="text-[11px] text-[var(--ink-50)] mt-1">{t.blurb}</div>
          </button>
        ))}
      </div>
      <ModeToggle mode={mode} setMode={setMode} />
      <p className="text-[11px] text-[var(--ink-50)]">
        Need something else? Describe it to AI, build it from a Plexii table (Data), or{' '}
        <button type="button" className="underline" onClick={onMermaid}>
          paste Mermaid
        </button>
        .
      </p>
    </Modal>
  )
}

export function FindPanel({ cmd, onClose }: { cmd: Commands; onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [rep, setRep] = useState('')
  const [cs, setCs] = useState(false)
  const [i, setI] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const results = useMemo(() => cmd.find(q, { caseSensitive: cs }), [cmd, q, cs])
  const go = (idx: number): void => {
    if (!results.length) return
    const n = ((idx % results.length) + results.length) % results.length
    setI(n)
    const r = results[n]!
    if (r.kind === 'node') cmd.focusNode(r.id)
    else cmd.select([], [r.id])
  }
  return (
    <div className="absolute top-2 right-2 z-30 fb-glass-panel rounded-[var(--radius-row)] p-2 w-[300px] space-y-1.5 shadow-lg" data-testid="diagram-find-panel">
      <div className="flex items-center gap-1">
        <input
            value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setI(0)
            setMsg(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') go(e.shiftKey ? i - 1 : i + (results.length && q ? 1 : 0))
            if (e.key === 'Escape') onClose()
          }}
          placeholder="Find text in shapes and lines"
          className="fb-field flex-1 h-7 px-2 text-[12px]"
          data-testid="diagram-find-input"
        />
        <span className="text-[10px] text-[var(--ink-50)] w-[44px] text-right tabular-nums" data-testid="diagram-find-count">
          {q ? `${results.length ? i + 1 : 0}/${results.length}` : ''}
        </span>
        <button type="button" onClick={() => go(i - 1)} className="icon-btn" title="Previous">
          <Icon name="keyboard_arrow_up" size={15} />
        </button>
        <button type="button" onClick={() => go(i + 1)} className="icon-btn" title="Next">
          <Icon name="keyboard_arrow_down" size={15} />
        </button>
        <button type="button" onClick={onClose} className="icon-btn" title="Close">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="flex items-center gap-1">
        <input value={rep} onChange={(e) => setRep(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Replace with" className="fb-field flex-1 h-7 px-2 text-[12px]" data-testid="diagram-replace-input" />
        <button
          type="button"
          disabled={!q}
          onClick={() => {
            const n = cmd.replaceAll(q, rep, { caseSensitive: cs })
            setMsg(`Replaced ${n} occurrence${n === 1 ? '' : 's'}.`)
          }}
          className="h-7 px-2 rounded bg-[var(--surface-sunken)] text-[11px] disabled:opacity-40"
          data-testid="diagram-replace-all"
        >
          Replace all
        </button>
      </div>
      <label className="flex items-center gap-1 text-[11px] text-[var(--ink-60)]">
        <input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} className="accent-[#2563eb]" /> Match case
      </label>
      {msg && <div className="text-[11px] text-[var(--ink-60)]">{msg}</div>}
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Select / pan / text tool', 'V · H · T'],
  ['Pan the canvas', 'Space-drag · middle-drag · scroll'],
  ['Zoom', '⌘ + scroll · ⌘+ · ⌘− · ⌘0'],
  ['Fit page / zoom to selection', '⇧1 · ⇧2'],
  ['Edit text', 'Enter · double-click'],
  ['New line in a label', '⇧Enter'],
  ['Undo / redo', '⌘Z · ⇧⌘Z'],
  ['Cut / copy / paste / duplicate', '⌘X · ⌘C · ⌘V · ⌘D'],
  ['Select all / deselect', '⌘A · Esc'],
  ['Delete', 'Delete · Backspace'],
  ['Nudge', 'Arrows (⇧ = 10px)'],
  ['Group / ungroup', '⌘G · ⇧⌘G'],
  ['Lock / unlock', '⇧⌘L'],
  ['Bring forward / to front', '⌘] · ⇧⌘]'],
  ['Send backward / to back', '⌘[ · ⇧⌘['],
  ['Bold / italic / underline', '⌘B · ⌘I · ⌘U'],
  ['Copy / paste style', '⌥⌘C · ⌥⌘V'],
  ['Find and replace', '⌘F'],
  ['Multi-select', '⇧-click · drag a box'],
  ['Rotate in 15° steps', 'Drag the knob with ⇧'],
  ['Add a connected shape', 'Click a blue arrow around a selected shape'],
  ['Create and connect', 'Drag a line from a dot onto empty canvas']
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" icon="keyboard" onClose={onClose} width={480} testid="diagram-shortcuts">
      <table className="w-full text-[12px]">
        <tbody>
          {SHORTCUTS.map(([a, b]) => (
            <tr key={a} className="border-b border-[var(--edge-soft)] last:border-0">
              <td className="py-1.5 pr-3 text-[var(--ink-70)]">{a}</td>
              <td className="py-1.5 text-right font-mono text-[11px] text-[var(--ink-90)]">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-[var(--ink-40)]">On Windows and Linux, use Ctrl in place of ⌘ and Alt in place of ⌥.</p>
    </Modal>
  )
}

// ── data sources ────────────────────────────────────────────────────────────

export type DataTab = 'tables' | 'widgets' | 'apps' | 'tools'

// initialTab: which source the dialog opens on (Insert › "Work widget from a
// desk…" opens straight on Work widgets).
export function DataDialog({ cmd, onClose, initialTab = 'tables' }: { cmd: Commands; onClose: () => void; initialTab?: DataTab }): JSX.Element {
  const [tab, setTab] = useState<DataTab>(initialTab)
  const [widgetPicker, setWidgetPicker] = useState(false)
  return (
    <Modal title="Data sources" icon="database" onClose={onClose} width={560} testid="diagram-data-dialog">
      <div className="flex gap-1 border-b border-[var(--edge-soft)]">
        {(
          [
            ['tables', 'Tables', 'table'],
            ['widgets', 'Work widgets', 'widgets'],
            ['apps', 'Apps', 'apps'],
            ['tools', 'Tools', 'construction']
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`diagram-data-tab-${id}`}
            className={`inline-flex items-center gap-1 px-3 h-8 text-[12px] ${tab === id ? 'border-b-2 border-[#2563eb] font-semibold text-[var(--ink-90)]' : 'text-[var(--ink-60)]'}`}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'tables' && <TablesTab cmd={cmd} onDone={onClose} />}
      {tab === 'widgets' && (
        <div className="space-y-2 text-[12px]">
          <p className="text-[11px] text-[var(--ink-60)]">Embed a live work widget from any desk. The shape shows the work widget’s current content and updates as it changes.</p>
          <button type="button" className="btn-primary text-[12px] px-3 py-1.5 inline-flex items-center gap-1" onClick={() => setWidgetPicker(true)} data-testid="diagram-data-widget">
            <Icon name="widgets" size={14} /> Choose a work widget…
          </button>
        </div>
      )}
      {tab === 'apps' && <AppsTab cmd={cmd} onDone={onClose} />}
      {tab === 'tools' && <ToolsTab cmd={cmd} onDone={onClose} />}
      {widgetPicker && (
        <WidgetPickerDialog
          onPick={(id) => {
            setWidgetPicker(false)
            cmd.addWidget(id)
            onClose()
          }}
          onClose={() => setWidgetPicker(false)}
        />
      )}
    </Modal>
  )
}

function TablesTab({ cmd, onDone }: { cmd: Commands; onDone: () => void }): JSX.Element {
  const [list, setList] = useState<FbTable[] | null>(null)
  const [tableId, setTableId] = useState('')
  const [kind, setKind] = useState<GenerateKind>('cards')
  const [labelCol, setLabelCol] = useState('')
  const [linkCol, setLinkCol] = useState('')
  const [colorCol, setColorCol] = useState('')
  const [fields, setFields] = useState<string[]>([])
  const [mode, setMode] = useState<'add' | 'replace'>('add')
  const [busy, setBusy] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const tables = useTablesStore((s) => s.tables)
  const table = tableId ? tables[tableId] : undefined

  useEffect(() => {
    let alive = true
    window.api.tables
      .list()
      .then((l) => alive && setList(l))
      .catch((e) => alive && (setList([]), setError(`Could not load tables: ${(e as Error).message}`)))
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!tableId) return
    void useTablesStore.getState().ensureTableLoaded(tableId)
  }, [tableId])
  useEffect(() => {
    if (table) {
      setLabelCol(primaryColumn(table)?.id ?? '')
      setLinkCol('')
      setColorCol('')
      setFields([])
    }
  }, [table])

  const run = async (): Promise<void> => {
    if (!table) return
    setBusy(true)
    setError(null)
    try {
      const rows = await useTablesStore.getState().ensureRowsLoaded(table.id)
      const w = cmd.generateFromTable(table, rows, { kind, labelColumnId: labelCol || undefined, linkColumnId: linkCol || undefined, colorColumnId: colorCol || undefined, fieldColumnIds: fields }, mode)
      setWarnings(w)
      if (!w.length) onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const linkLabel = kind === 'orgchart' ? 'Reports to (manager)' : kind === 'flow' ? 'Next step(s)' : kind === 'mindmap' ? 'Group by' : ''
  const cols = table?.schema.columns ?? []
  return (
    <div className="space-y-2 text-[12px]">
      <p className="text-[11px] text-[var(--ink-60)]">Each row becomes a shape that stays linked to the table: edit the table and the diagram updates. Shapes can also be linked one by one in the inspector’s Data tab.</p>
      <div className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1.5 items-center">
        <span className="text-[11px] text-[var(--ink-60)]">Table</span>
        <select value={tableId} onChange={(e) => setTableId(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-7 px-1 text-[12px]" data-testid="diagram-gen-table">
          <option value="">{list === null ? 'Loading…' : list.length ? 'Choose a table…' : 'No Plexii tables yet'}</option>
          {(list ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || 'Untitled table'}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-[var(--ink-60)]">Diagram</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as GenerateKind)} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-7 px-1 text-[12px]" data-testid="diagram-gen-kind">
          <option value="cards">Cards (one per row)</option>
          <option value="orgchart">Org chart</option>
          <option value="flow">Flow / process</option>
          <option value="mindmap">Mind map</option>
        </select>
        {table && (
          <>
            <span className="text-[11px] text-[var(--ink-60)]">Label</span>
            <select value={labelCol} onChange={(e) => setLabelCol(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-7 px-1 text-[12px]">
              {cols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {linkLabel && (
              <>
                <span className="text-[11px] text-[var(--ink-60)]">{linkLabel}</span>
                <select value={linkCol} onChange={(e) => setLinkCol(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-7 px-1 text-[12px]" data-testid="diagram-gen-link">
                  <option value="">{kind === 'flow' ? 'Table order' : 'None'}</option>
                  {cols.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="text-[11px] text-[var(--ink-60)]">Colour by</span>
            <select value={colorCol} onChange={(e) => setColorCol(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="fb-field h-7 px-1 text-[12px]">
              <option value="">None</option>
              {cols
                .filter((c) => c.type === 'single-select' || c.type === 'multi-select')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
            <span className="text-[11px] text-[var(--ink-60)] self-start pt-1">Extra fields</span>
            <div className="flex flex-wrap gap-1">
              {cols
                .filter((c) => c.id !== labelCol)
                .map((c) => {
                  const on = fields.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setFields(on ? fields.filter((f) => f !== c.id) : [...fields, c.id])}
                      className={`text-[10px] px-1.5 py-0.5 rounded-full border ${on ? 'border-[#2563eb] text-[#1d4ed8] bg-[#2563eb]/10' : 'border-[var(--edge-firm)] text-[var(--ink-60)]'}`}
                    >
                      {c.label}
                    </button>
                  )
                })}
            </div>
          </>
        )}
      </div>
      <ModeToggle mode={mode} setMode={setMode} />
      {error && <div className="text-[11px] text-red-600">{error}</div>}
      {warnings.length > 0 && (
        <div className="text-[11px] text-amber-700">
          Built, with notes:
          <ul className="list-disc pl-4 max-h-24 overflow-auto">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="text-[12px] px-3 py-1.5 text-[var(--ink-50)]">
          Close
        </button>
        <button type="button" disabled={!table || busy} onClick={() => void run()} className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50" data-testid="diagram-gen-run">
          {busy ? 'Building…' : 'Build diagram'}
        </button>
      </div>
    </div>
  )
}

function AppsTab({ cmd, onDone }: { cmd: Commands; onDone: () => void }): JSX.Element {
  const apps = useMemo(
    () =>
      (Object.entries(SEGMENT_APPS) as unknown as [string, readonly { key: string; label: string; icon: string; hub?: boolean }[]][]).flatMap(([seg, list]) =>
        list.map((a) => ({ id: `${seg}:${a.key}`, label: a.label, icon: a.icon.startsWith('plexii:') ? 'apps' : a.icon, seg }))
      ),
    []
  )
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const insert = (): void => {
    const chosen = apps.filter((a) => picked.has(a.id))
    const nodes: MapNode[] = chosen.map((a, i) => ({
      id: ops.uid('n'),
      x: (i % 4) * 180,
      y: Math.floor(i / 4) * 100,
      label: a.label,
      shape: 'app-tile',
      color: '#7c3aed',
      icon: a.icon,
      binding: { source: { kind: 'app', appId: a.id } }
    }))
    cmd.addNodes(nodes)
    onDone()
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--ink-60)]">Add Plexii apps to the diagram, for example to map how your team’s work flows between them. Each tile stays linked to its app.</p>
      <div className="grid grid-cols-3 gap-1 max-h-[300px] overflow-auto">
        {apps.map((a) => (
          <label key={a.id} className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-[11px] cursor-pointer ${picked.has(a.id) ? 'border-[#2563eb] bg-[#2563eb]/5' : 'border-[var(--edge-soft)]'}`}>
            <input
              type="checkbox"
              checked={picked.has(a.id)}
              onChange={() => {
                const n = new Set(picked)
                if (n.has(a.id)) n.delete(a.id)
                else n.add(a.id)
                setPicked(n)
              }}
              className="accent-[#2563eb]"
            />
            {(() => {
              const ent = segmentAppEntity(a.seg, a.id.slice(a.seg.length + 1))
              return ent ? (
                <PlexiiIcon kind={ent.kind} id={ent.id} size={17} fallback={a.icon} className="shrink-0" />
              ) : (
                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                  {a.icon}
                </span>
              )
            })()}
            <span className="truncate">{a.label}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" disabled={!picked.size} onClick={insert} className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50" data-testid="diagram-data-apps-insert">
          Add {picked.size || ''} app{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}

function ToolsTab({ cmd, onDone }: { cmd: Commands; onDone: () => void }): JSX.Element {
  const tools = useMemo(() => WIDGET_CATALOG.filter((w) => w.category === 'Tools'), [])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const insert = (): void => {
    const chosen = tools.filter((t) => picked.has(t.kind))
    cmd.addNodes(
      chosen.map((t, i) => ({
        id: ops.uid('n'),
        x: (i % 4) * 180,
        y: Math.floor(i / 4) * 100,
        label: t.label,
        shape: 'tool-tile',
        color: '#0891b2',
        icon: t.icon.startsWith('plexii:') ? 'construction' : t.icon,
        binding: { source: { kind: 'tool', toolId: t.kind } }
      }))
    )
    onDone()
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--ink-60)]">Add Plexii tools as shapes, to plan which tools a workflow uses. To show a live tool’s content, embed it from the Work widgets tab instead.</p>
      <div className="grid grid-cols-3 gap-1 max-h-[300px] overflow-auto">
        {tools.map((t) => (
          <label key={t.kind} className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-[11px] cursor-pointer ${picked.has(t.kind) ? 'border-[#2563eb] bg-[#2563eb]/5' : 'border-[var(--edge-soft)]'}`}>
            <input
              type="checkbox"
              checked={picked.has(t.kind)}
              onChange={() => {
                const n = new Set(picked)
                if (n.has(t.kind)) n.delete(t.kind)
                else n.add(t.kind)
                setPicked(n)
              }}
              className="accent-[#2563eb]"
            />
            <PlexiiIcon kind="widget" id={t.kind} size={17} fallback={t.icon} className="shrink-0" />
            <span className="truncate">{t.label}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" disabled={!picked.size} onClick={insert} className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50" data-testid="diagram-data-tools-insert">
          Add {picked.size || ''} tool{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}
