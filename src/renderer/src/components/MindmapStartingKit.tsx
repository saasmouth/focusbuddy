import { useEffect, useState } from 'react'
import type { AiBuildSuggestion } from '@shared/types'
import Icon from './Icon'
import { STANDARD_APPS, type StandardApp } from '../lib/standardApps'
import PlexiiIcon from './PlexiiIcon'
import { CONNECTED_ICON_ASSETS } from '../lib/plexiiIconMap'

// Phase 2 — when a freshly-explored mind-map node opens its (empty) task canvas,
// auto-offer a "starting kit": AI-suggested widgets for the node's goal plus a
// row of relevant browser apps to open. Dismissible; one click to add the
// chosen pieces. Reuses the existing Build-with-AI backend + app catalog.

// A small, broadly-useful set of browser apps to surface as quick-adds. The AI
// can also return webview suggestions; these are the always-handy fallbacks.
const QUICK_APP_IDS = ['gmail', 'gcal', 'notion', 'slack', 'linear', 'chatgpt', 'claude', 'figma']

function quickApps(): StandardApp[] {
  const byId = new Map(STANDARD_APPS.map((a) => [a.id, a]))
  const picked = QUICK_APP_IDS.map((id) => byId.get(id)).filter((a): a is StandardApp => !!a)
  // Fall back to the first few catalog apps if the ids drift.
  return picked.length > 0 ? picked : STANDARD_APPS.slice(0, 8)
}

interface Props {
  taskId: string
  nodeLabel: string
  nodePath: string[]
  onAddWidgets: (suggestions: AiBuildSuggestion[]) => Promise<void>
  onAddBrowser: (app: StandardApp) => Promise<void>
  onDismiss: () => void
}

export default function MindmapStartingKit({
  taskId,
  nodeLabel,
  nodePath,
  onAddWidgets,
  onAddBrowser,
  onDismiss
}: Props): JSX.Element {
  const [stage, setStage] = useState<'loading' | 'ready' | 'error'>('loading')
  const [intent, setIntent] = useState('')
  const [suggestions, setSuggestions] = useState<AiBuildSuggestion[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const context = nodePath.length > 0 ? ` (within: ${nodePath.join(' › ')})` : ''
      const prompt = `I'm starting work on a focused task: "${nodeLabel}"${context}. Suggest the most useful work widgets and browser tabs to get this specific task done — keep it tight and practical.`
      try {
        const res = await window.api.setup.buildFromPrompt({ prompt, taskId })
        if (cancelled) return
        if (res.ok && res.suggestions && res.suggestions.length > 0) {
          setIntent(res.intent ?? '')
          setSuggestions(res.suggestions)
          setSelected(new Set(res.suggestions.map((s) => s.id)))
          setStage('ready')
        } else {
          setStage('error')
        }
      } catch {
        if (!cancelled) setStage('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, nodeLabel, nodePath])

  const toggle = (id: string): void =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const toggleApp = (id: string): void =>
    setSelectedApps((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  async function add(): Promise<void> {
    setAdding(true)
    try {
      const picked = suggestions.filter((s) => selected.has(s.id))
      if (picked.length > 0) await onAddWidgets(picked)
      const apps = quickApps().filter((a) => selectedApps.has(a.id))
      for (const a of apps) await onAddBrowser(a)
    } finally {
      onDismiss()
    }
  }

  const apps = quickApps()
  const anySelected = selected.size > 0 || selectedApps.size > 0

  return (
    <div
      className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in absolute top-3 left-1/2 -translate-x-1/2 z-[180] w-[min(620px,92vw)]"
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="mindmap-starting-kit"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--edge-soft)]">
        <Icon name="auto_awesome" size={15} className="text-accent" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-[var(--ink-100)] truncate">
            Starting kit for “{nodeLabel}”
          </div>
          {intent && (
            <div className="text-[10px] text-[var(--ink-50)] truncate">{intent}</div>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
          aria-label="Dismiss starting kit"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* Describe-it entry: the most direct way to set up a desk is to tell the
          assistant what you want and let it build the whole thing (table, agent,
          wiring) as cards you confirm. This makes that capability discoverable
          right where a new desk starts. */}
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('fb:open-assistant'))}
        data-testid="starting-kit-describe"
        className="w-full text-left px-4 py-2.5 border-b border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)] transition-colors group"
      >
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" size={14} className="text-[rgb(var(--accent))]" />
          <span className="text-[12px] font-medium text-[var(--ink-90)]">
            Or just tell the assistant what you want to set up
          </span>
          <Icon
            name="arrow_forward"
            size={13}
            className="ml-auto text-[var(--ink-40)] group-hover:text-[rgb(var(--accent))] transition-colors"
          />
        </div>
        <div className="text-[10.5px] text-[var(--ink-50)] mt-0.5 pl-6">
          e.g. "track my sales leads and research them" — it builds the table, an agent, and the wiring for you to confirm.
        </div>
      </button>

      <div className="p-3 max-h-[52vh] overflow-y-auto">
        {stage === 'loading' && (
          <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-[var(--ink-50)]">
            <Icon name="progress_activity" size={16} className="animate-spin" />
            Thinking up the right work widgets &amp; tabs…
          </div>
        )}
        {stage === 'error' && (
          <div className="py-5 text-center text-[12px] text-[var(--ink-50)]">
            Couldn’t generate suggestions right now. You can still add a browser below, or use the
            + Add menu.
          </div>
        )}
        {stage === 'ready' && (
          <>
            <div className="text-[10px] uppercase tracking-wide text-[var(--ink-50)] font-semibold mb-1.5">
              Suggested work widgets
            </div>
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {suggestions.map((s) => {
                const on = selected.has(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() => toggle(s.id)}
                    className={`flex items-start gap-2 text-left px-2.5 py-2 rounded-lg border transition-colors ${
                      on
                        ? 'border-accent bg-accent/5'
                        : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)]'
                    }`}
                    data-testid={`kit-widget-${s.kind}`}
                  >
                    <Icon
                      name={on ? 'check_circle' : 'radio_button_unchecked'}
                      size={14}
                      className={on ? 'text-accent mt-0.5' : 'text-[var(--ink-40)] mt-0.5'}
                    />
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-[var(--ink-100)] truncate">
                        {s.title || s.kind}
                      </div>
                      <div className="text-[10px] text-[var(--ink-50)] leading-tight line-clamp-2">
                        {s.reason || s.kind}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div className="text-[10px] uppercase tracking-wide text-[var(--ink-50)] font-semibold mb-1.5">
          Open a browser
        </div>
        <div className="flex flex-wrap gap-1.5">
          {apps.map((a) => {
            const on = selectedApps.has(a.id)
            return (
              <button
                key={a.id}
                onClick={() => toggleApp(a.id)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                  on
                    ? 'border-accent bg-accent/5 text-[var(--ink-100)]'
                    : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:border-[var(--edge-firm)]'
                }`}
                data-testid={`kit-app-${a.id}`}
                title={a.url}
              >
                {CONNECTED_ICON_ASSETS[a.id] ? (
                  <PlexiiIcon kind="connected" id={a.id} size={14} fallback={a.icon} />
                ) : (
                  <Icon name={a.icon} size={12} style={{ color: a.color }} />
                )}
                {a.title}
                {on && <Icon name="check" size={11} className="text-accent" />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[var(--edge-soft)]">
        <button
          onClick={onDismiss}
          className="text-[11px] px-2 py-1 rounded text-[var(--ink-50)] hover:text-[var(--ink-90)]"
        >
          Not now
        </button>
        <button
          onClick={() => void add()}
          disabled={!anySelected || adding}
          className="text-[12px] px-3 py-1.5 rounded-md bg-[rgb(var(--accent))] text-white font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          data-testid="kit-add"
        >
          <Icon name={adding ? 'progress_activity' : 'add'} size={13} className={adding ? 'animate-spin' : ''} />
          Add {selected.size + selectedApps.size > 0 ? `${selected.size + selectedApps.size} ` : ''}to canvas
        </button>
      </div>
    </div>
  )
}
