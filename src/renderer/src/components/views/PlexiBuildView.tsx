import { useEffect, useState } from 'react'
import Icon from '../Icon'
import { PLEXI_CARD } from '../plexi'
import ModuleDashboard from '../ModuleDashboard'
import { useQuickCreate } from '../../stores/quickCreate'
import { useLandOnContent } from '../../hooks/useLandOnContent'
import { bucketByWeek, periodDelta, countByKey } from '../../lib/dashboardMetrics'
import { useAppsStore } from '../../stores/apps'
import { openHttpUrl } from '../../lib/openUrl'
import { isHttpUrl } from '@shared/safeUrl'
import {
  type PlexiApp,
  type AppComponent,
  type AppComponentType,
  type AppFieldType,
  APP_COMPONENT_META,
  APP_FIELD_META,
  newComponent
} from '@shared/apps'

// PlexiBuild Phase 1: a no-code screen builder. Compose an app from typed
// components in Build mode, run it in Preview. Persists per app. Later phases add
// multi-screen navigation, table data binding, logic and a free-canvas layout.

const PALETTE: AppComponentType[] = ['heading', 'text', 'field', 'button', 'divider']
const FIELD_TYPES: AppFieldType[] = ['text', 'number', 'select', 'checkbox', 'date']

export default function PlexiBuildView(): JSX.Element {
  const apps = useAppsStore((s) => s.apps)
  const loaded = useAppsStore((s) => s.loaded)
  const load = useAppsStore((s) => s.load)
  const createApp = useAppsStore((s) => s.create)
  const updateApp = useAppsStore((s) => s.update)
  const removeApp = useAppsStore((s) => s.remove)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const selected = apps.find((a) => a.id === selectedId) ?? null
  const { showOverview } = useLandOnContent(loaded, apps, selectedId, setSelectedId)
  const now = Date.now()

  async function addApp(): Promise<void> {
    const created = await createApp({ name: 'New app', components: [] })
    if (created) setSelectedId(created.id)
  }

  // Global quick-create (Cmd+K "New app").
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'build' && useQuickCreate.getState().consume('build')) void addApp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPending])

  return (
    <div className="h-full w-full flex bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexibuild-view">
      {/* App list */}
      <div className="w-[280px] shrink-0 border-r border-[var(--edge-soft)] flex flex-col">
        <div className="px-4 py-3.5 border-b border-[var(--edge-soft)]">
          <div className="flex items-center gap-2">
            <Icon name="construction" size={18} className="text-emerald-500" filled />
            <h1 className="text-[15px] font-bold tracking-tight text-[var(--ink-100)]">PlexiBuild</h1>
          </div>
          <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)]">Build internal tools without code.</p>
        </div>
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void addApp()}
              data-testid="build-new-app"
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-[rgb(var(--accent))] text-white text-[12px] font-medium hover:bg-[rgb(var(--accent-hover))]"
            >
              <Icon name="add" size={15} /> New app
            </button>
            {apps.length > 0 && (
              <button
                onClick={showOverview}
                data-testid="build-overview"
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
          ) : apps.length === 0 ? (
            <div className="px-3 py-10 text-center" data-testid="apps-empty">
              <Icon name="apps" size={26} className="text-[var(--ink-30)]" />
            </div>
          ) : (
            apps.map((a) => (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                data-testid={`build-app-${a.id}`}
                className={`w-full text-left rounded-lg px-3 py-2 mb-1 flex items-center gap-2.5 transition-colors ${
                  a.id === selectedId ? 'bg-[rgb(var(--accent)/0.10)] border border-[rgb(var(--accent)/0.30)]' : 'hover:bg-[var(--surface-sunken)] border border-transparent'
                }`}
              >
                <Icon name={a.icon} size={16} className="text-[var(--ink-70)] shrink-0" />
                <span className="text-[13px] font-medium text-[var(--ink-100)] truncate">{a.name}</span>
                <span className="ml-auto text-[10px] text-[var(--ink-70)] fb-tabular">{a.components.length}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Builder */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <AppBuilder
            key={selected.id}
            app={selected}
            onChange={(patch) => void updateApp(selected.id, patch)}
            onDelete={() => {
              void removeApp(selected.id)
              setSelectedId(null)
            }}
          />
        ) : (
          <ModuleDashboard
            moduleKey="build"
            title="Build"
            subtitle="Compose an internal tool from typed components, then run it, no code"
            icon="construction"
            accentClass="text-emerald-500"
            stats={[
              {
                icon: 'apps',
                label: 'Apps',
                value: apps.length,
                tone: 'emerald',
                delta: periodDelta(apps.map((a) => a.createdAt), 7 * 86400000, now),
                sparkline: bucketByWeek(apps.map((a) => a.createdAt), 8, now)
              },
              { icon: 'widgets', label: 'Components', value: apps.reduce((n, a) => n + a.components.length, 0), tone: 'accent' },
              {
                icon: 'view_module',
                label: 'Avg per app',
                value: apps.length ? Math.round(apps.reduce((n, a) => n + a.components.length, 0) / apps.length) : 0,
                tone: 'sky'
              }
            ]}
            timeline={{
              title: 'Apps created',
              points: bucketByWeek(apps.map((a) => a.createdAt), 8, now),
              bucketLabel: 'last 8 weeks',
              unit: 'apps',
              tone: 'emerald',
              emptyHint: 'Build your first app to see it appear here.'
            }}
            breakdown={{
              title: 'Components by type',
              icon: 'category',
              items: countByKey(apps.flatMap((a) => a.components), (c) => c.type).map((b) => ({
                label: b.label.charAt(0).toUpperCase() + b.label.slice(1),
                value: b.value,
                tone: 'emerald' as const
              })),
              emptyHint: 'No components yet.'
            }}
            recentItems={{
              label: 'Your apps',
              items: apps.slice(0, 6).map((a) => ({
                id: a.id,
                title: a.name,
                subtitle: `${a.components.length} component(s)`,
                meta: `Updated ${new Date(a.updatedAt).toLocaleDateString()}`,
                onOpen: () => setSelectedId(a.id)
              })),
              onCreate: () => void addApp(),
              createLabel: 'New app',
              emptyHint: 'No apps yet. Create one, drop in components, then hit Preview to run it.'
            }}
          />
        )}
      </div>
    </div>
  )
}

function AppBuilder({
  app,
  onChange,
  onDelete
}: {
  app: PlexiApp
  onChange: (patch: { name?: string; components?: AppComponent[] }) => void
  onDelete: () => void
}): JSX.Element {
  const [name, setName] = useState(app.name)
  const [preview, setPreview] = useState(false)
  const components = app.components

  function setComponents(next: AppComponent[]): void {
    onChange({ components: next })
  }
  function add(type: AppComponentType): void {
    setComponents([...components, newComponent(type)])
  }
  function patch(id: string, p: Partial<AppComponent>): void {
    setComponents(components.map((c) => (c.id === id ? { ...c, ...p } : c)))
  }
  function remove(id: string): void {
    setComponents(components.filter((c) => c.id !== id))
  }
  function move(id: string, dir: -1 | 1): void {
    const i = components.findIndex((c) => c.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= components.length) return
    const next = [...components]
    ;[next[i], next[j]] = [next[j], next[i]]
    setComponents(next)
  }

  return (
    <div className="h-full flex flex-col" data-testid="app-builder">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--edge-soft)]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== app.name && onChange({ name })}
          className="flex-1 bg-transparent text-[17px] font-bold text-[var(--ink-100)]"
          data-testid="app-name"
        />
        <div className="inline-flex rounded-md bg-[var(--surface-sunken)] overflow-hidden">
          <button
            onClick={() => setPreview(false)}
            className={`px-3 py-1.5 text-[12px] font-medium ${!preview ? 'bg-[rgb(var(--accent))] text-white' : 'text-[var(--ink-90)]'}`}
            data-testid="app-build-mode"
          >
            Build
          </button>
          <button
            onClick={() => setPreview(true)}
            className={`px-3 py-1.5 text-[12px] font-medium ${preview ? 'bg-[rgb(var(--accent))] text-white' : 'text-[var(--ink-90)]'}`}
            data-testid="app-preview-mode"
          >
            Preview
          </button>
        </div>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-[var(--ink-40)] hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
          title="Delete app" aria-label="Delete app"
          data-testid="app-delete"
        >
          <Icon name="delete" size={16} />
        </button>
      </div>

      {!preview && (
        <div className="px-5 py-2 border-b border-[var(--edge-soft)] flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-[var(--ink-70)] mr-1">Add</span>
          {PALETTE.map((t) => (
            <button
              key={t}
              onClick={() => add(t)}
              data-testid={`palette-${t}`}
              className="fb-btn-surface inline-flex items-center gap-1 px-2 py-1 text-[11.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
            >
              <Icon name={APP_COMPONENT_META[t].icon} size={13} /> {APP_COMPONENT_META[t].label}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-[640px] px-6 py-6">
          {components.length === 0 ? (
            <div className="py-16 text-center text-[var(--ink-70)]">
              <Icon name="dashboard_customize" size={28} />
              <p className="mt-2 text-[12.5px]">
                {preview ? 'This app has no components yet.' : 'Add components from the bar above to build your app.'}
              </p>
            </div>
          ) : preview ? (
            <div className="space-y-4" data-testid="app-preview">
              {components.map((c) => (
                <PreviewComponent key={c.id} c={c} />
              ))}
            </div>
          ) : (
            <div className="space-y-2.5">
              {components.map((c, i) => (
                <BuildComponent
                  key={c.id}
                  c={c}
                  first={i === 0}
                  last={i === components.length - 1}
                  onPatch={(p) => patch(c.id, p)}
                  onRemove={() => remove(c.id)}
                  onMove={(d) => move(c.id, d)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Build-mode component card (config editor) ────────────────────────────────

export function BuildComponent({
  c,
  first,
  last,
  onPatch,
  onRemove,
  onMove
}: {
  c: AppComponent
  first: boolean
  last: boolean
  onPatch: (p: Partial<AppComponent>) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}): JSX.Element {
  const inputCls =
    'w-full text-[12px] bg-[var(--surface-sunken)] rounded px-2 py-1 text-[var(--ink-100)] placeholder:text-[var(--ink-50)] focus:border-[rgb(var(--accent)/0.50)]'
  return (
    <div className={`${PLEXI_CARD} p-3`} data-testid={`build-component-${c.type}`}>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon name={APP_COMPONENT_META[c.type].icon} size={14} className="text-[rgb(var(--accent))]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-70)]">
          {APP_COMPONENT_META[c.type].label}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={() => onMove(-1)} disabled={first} className="p-1 text-[var(--ink-70)] hover:text-[var(--ink-100)] disabled:opacity-30" title="Move up" aria-label="Move up">
            <Icon name="arrow_upward" size={13} />
          </button>
          <button onClick={() => onMove(1)} disabled={last} className="p-1 text-[var(--ink-70)] hover:text-[var(--ink-100)] disabled:opacity-30" title="Move down" aria-label="Move down">
            <Icon name="arrow_downward" size={13} />
          </button>
          <button onClick={onRemove} className="p-1 text-[var(--ink-70)] hover:text-red-600" title="Remove" aria-label="Remove">
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>

      {c.type === 'heading' && (
        <input value={c.label ?? ''} onChange={(e) => onPatch({ label: e.target.value })} placeholder="Heading text" className={inputCls} />
      )}
      {c.type === 'text' && (
        <textarea value={c.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} placeholder="Paragraph text" rows={2} className={`${inputCls} resize-y`} />
      )}
      {c.type === 'button' && (
        <div className="space-y-1.5">
          <input value={c.label ?? ''} onChange={(e) => onPatch({ label: e.target.value })} placeholder="Button label" className={inputCls} />
          <div className="flex items-center gap-1.5">
            <select
              value={c.action?.kind ?? 'none'}
              onChange={(e) => onPatch({ action: { kind: e.target.value as 'none' | 'link', url: c.action?.url } })}
              className={inputCls}
            >
              <option value="none">No action (yet)</option>
              <option value="link">Open a link</option>
            </select>
            {c.action?.kind === 'link' && (
              <input value={c.action?.url ?? ''} onChange={(e) => onPatch({ action: { kind: 'link', url: e.target.value } })} placeholder="https://" className={inputCls} />
            )}
          </div>
          {c.action?.kind === 'link' && c.action.url && !isHttpUrl(c.action.url) && (
            // Said here, where it can be fixed, rather than discovered later as
            // a button that does nothing.
            <p className="text-[11.5px] text-amber-700 dark:text-amber-300" data-testid="plexibuild-link-refused">
              Only web addresses (http or https) can be opened from a button.
            </p>
          )}
        </div>
      )}
      {c.type === 'field' && (
        <div className="space-y-1.5">
          <input value={c.label ?? ''} onChange={(e) => onPatch({ label: e.target.value })} placeholder="Field label" className={inputCls} />
          <div className="flex items-center gap-1.5">
            <select value={c.fieldType ?? 'text'} onChange={(e) => onPatch({ fieldType: e.target.value as AppFieldType })} className={inputCls}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{APP_FIELD_META[t].label}</option>
              ))}
            </select>
            {c.fieldType === 'select' ? (
              <input
                value={(c.options ?? []).join(', ')}
                onChange={(e) => onPatch({ options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="Options, comma-separated"
                className={inputCls}
              />
            ) : (
              <input value={c.placeholder ?? ''} onChange={(e) => onPatch({ placeholder: e.target.value })} placeholder="Placeholder" className={inputCls} />
            )}
          </div>
        </div>
      )}
      {c.type === 'divider' && <div className="h-px bg-[var(--edge-soft)]" />}
    </div>
  )
}

// ── Preview-mode component (runnable) ────────────────────────────────────────

export function PreviewComponent({ c }: { c: AppComponent }): JSX.Element {
  const [val, setVal] = useState<string | boolean>(c.fieldType === 'checkbox' ? false : '')
  const inputCls =
    'fb-card w-full text-[13px] px-3 py-2 text-[var(--ink-100)] placeholder:text-[var(--ink-50)] focus:border-[rgb(var(--accent))]'

  switch (c.type) {
    case 'heading':
      return <h2 className="text-[19px] font-bold text-[var(--ink-100)]">{c.label || 'Heading'}</h2>
    case 'text':
      return <p className="text-[13.5px] leading-relaxed text-[var(--ink-90)] whitespace-pre-wrap">{c.text}</p>
    case 'divider':
      return <div className="h-px bg-[var(--edge-soft)]" />
    case 'button':
      return (
        <button
          onClick={() => {
            // http(s) only, in a new tab that cannot reach back into this one
            // (noopener) or learn its address (noreferrer). This view also runs
            // on the public share page, where the app -- and so this address --
            // belongs to whoever minted the link.
            if (c.action?.kind === 'link') openHttpUrl(c.action.url)
          }}
          title={c.action?.kind === 'link' && c.action.url && !isHttpUrl(c.action.url) ? 'This button links to an address that cannot be opened' : undefined}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-semibold hover:bg-[rgb(var(--accent-hover))]"
        >
          {c.label || 'Button'}
        </button>
      )
    case 'field':
      return (
        <label className="block">
          <span className="block text-[12.5px] font-medium text-[var(--ink-90)] mb-1">{c.label || 'Field'}</span>
          {c.fieldType === 'checkbox' ? (
            <input type="checkbox" checked={val === true} onChange={(e) => setVal(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
          ) : c.fieldType === 'select' ? (
            <select value={String(val)} onChange={(e) => setVal(e.target.value)} className={inputCls}>
              <option value="">Choose…</option>
              {(c.options ?? []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              type={c.fieldType === 'number' ? 'number' : c.fieldType === 'date' ? 'date' : 'text'}
              value={String(val)}
              onChange={(e) => setVal(e.target.value)}
              placeholder={c.placeholder}
              className={inputCls}
            />
          )}
        </label>
      )
    default:
      return <div />
  }
}
