import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import { parseAttentionCommand } from '../../lib/attentionCommand'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useChatStore, NEW_CHAT_KEY } from '../../stores/chat'
import { composerOmniIntents, matchTargets, type OmniTarget } from '../../lib/omniIntent'
import { useWidgetStore } from '../../stores/widgets'
import type { SearchHit } from '@shared/types'
import { performOmniIntent, loadOmniMode, saveOmniMode, type OmniMode } from '../../lib/omniPerform'
import EnginePickerChip from '../browser/EnginePickerChip'

// The top-of-Home input is the front door to everything (A2, AI-01 + Caleb's
// seamless ruling, 2026-08-23): mode pills under the bar make intent a tap,
// not a guess. Ask Plexii seeds a fresh conversation on the hub; Search types
// straight into your engine and opens results in the in-app browser. Both
// semantics: tapping a pill acts on what's typed AND locks the mode (sticky
// across sessions) until switched. In Ask mode the smart layer still honours
// the instant rule — a bare URL opens in Plexii and "take me to X" navigates
// or searches — so nothing deterministic ever waits on the model. The R6
// placement review asked the bar to advertise all three doors and teach ⌘K;
// both live here now.

const EXAMPLES = ['Plan a wedding', 'Launch a product', 'Track job applications', 'Run a book club']
const MODE_KEY = 'fb.omni.mode.home'

// "@" on the bar is DIRECT navigation (AI-36, the remote control): mention a
// desk, room, widget, document, file or knowledge entry and land on it. The
// picker rides the global search backend (search:query — the same hits and
// routing PlexiSearch uses), with desks/rooms/pages answering instantly from
// the node store while the deeper search returns.
interface PickItem {
  key: string
  type: SearchHit['type'] | 'page'
  id: string
  title: string
  hint: string
  icon: string
  taskId?: string | null
}

const PICK_ICONS: Record<string, string> = {
  task: 'desk',
  folder: 'folder',
  widget: 'widgets',
  'table-row': 'table_chart',
  document: 'description',
  file: 'draft',
  knowledge: 'neurology',
  page: 'arrow_forward'
}
const PICK_HINTS: Record<string, string> = {
  task: 'Desk',
  folder: 'Room',
  widget: 'Work widget',
  'table-row': 'Table',
  document: 'Document',
  file: 'File',
  knowledge: 'PlexiBrain',
  page: 'Page'
}
const PICKABLE = new Set(['task', 'folder', 'widget', 'table-row', 'document', 'file', 'knowledge'])

// The active "@" query: the tail after the last standalone @, or null.
function mentionQuery(text: string): string | null {
  const i = text.lastIndexOf('@')
  if (i === -1) return null
  if (i > 0 && !/\s/.test(text[i - 1])) return null
  return text.slice(i + 1)
}

export default function StartOrAskPlexi(): JSX.Element {
  const [goal, setGoal] = useState('')
  const [mode, setModeState] = useState<OmniMode>(() => loadOmniMode(MODE_KEY))
  const sending = useChatStore((s) => s.sending)
  const nodes = useNodeStore((s) => s.nodes)

  const targets = useMemo<OmniTarget[]>(
    () => [
      { kind: 'page', id: 'tasks', title: 'Tasks' },
      { kind: 'page', id: 'calendar', title: 'Calendar' },
      { kind: 'page', id: 'files', title: 'Files' },
      { kind: 'page', id: 'vault', title: 'Vault' },
      ...nodes
        .filter((n) => n.kind === 'task')
        .map((n) => ({ kind: 'desk' as const, id: n.id, title: n.title || 'Untitled desk' }))
    ],
    [nodes]
  )

  function ask(prompt: string): void {
    const chat = useChatStore.getState()
    if (chat.sending) return
    // Fresh conversation, stamped as started from the workspace (the same
    // framing the hub itself uses), message sent on the way in. Fire-and-
    // forget: the stream renders in the hub the user is about to be on.
    chat.newConversation()
    chat.setPendingContext({ kind: 'workspace', label: 'your workspace', title: '', icon: 'auto_awesome' })
    void chat.send(null, prompt, NEW_CHAT_KEY)
    // Being on the hub means being on no desk — clear the active task so a
    // lingering desk can never claim this conversation's applies.
    useNodeStore.getState().setActive(null)
    useViewStore.getState().goPlexii()
  }

  function searchWeb(query: string): void {
    performOmniIntent({ kind: 'search', label: 'Search the web', url: query })
  }

  function start(): void {
    const prompt = goal.trim()
    if (!prompt) return
    if (mode === 'search') {
      searchWeb(prompt)
      setGoal('')
      return
    }
    // Ask mode still honours the instant rule for unambiguous input: a URL
    // or a navigation phrase acts now; everything else asks Plexii.
    const lead = composerOmniIntents(prompt, targets, { chatFirst: true })[0]
    if (lead && lead.kind !== 'ask') {
      performOmniIntent(lead)
      setGoal('')
      return
    }
    ask(prompt)
    setGoal('')
  }

  // Both semantics: a pill tap acts on the current text AND locks the mode.
  function pickMode(next: OmniMode): void {
    setModeState(next)
    saveOmniMode(MODE_KEY, next)
    const prompt = goal.trim()
    if (!prompt || sending) return
    if (next === 'search') searchWeb(prompt)
    else ask(prompt)
    setGoal('')
  }

  const searching = mode === 'search'

  // ── The "@" navigation picker ─────────────────────────────────────────────
  const pillowRef = useRef<HTMLDivElement | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [apiHits, setApiHits] = useState<SearchHit[]>([])
  const [highlight, setHighlight] = useState(0)
  const atQuery = mentionQuery(goal)
  const pickerOpen = atQuery !== null && dismissedFor !== goal

  // DEC-028: the armed @attention pill — same grammar as ⌘K and the chat.
  // Tab (or picking the Attention row) arms it; the bar's text then IS the
  // capture, Enter routes it to the confirm card, Backspace-on-empty disarms.
  const [attnArmed, setAttnArmed] = useState(false)
  const [workItemsOn, setWorkItemsOn] = useState(false)
  useEffect(() => {
    const probe = (): void => {
      window.api.workItems
        .enabled()
        .then(setWorkItemsOn)
        .catch(() => {})
    }
    probe()
    window.addEventListener('fb:workitems-toggled', probe)
    return () => window.removeEventListener('fb:workitems-toggled', probe)
  }, [])
  function armAttention(): void {
    const i = goal.lastIndexOf('@')
    setGoal(i >= 0 ? goal.slice(0, i).trimEnd() : goal)
    setAttnArmed(true)
    setHighlight(0)
  }

  // Instant candidates from the stores; the search backend joins in ≥2 chars.
  const localItems = useMemo<PickItem[]>(() => {
    if (atQuery === null) return []
    // DEC-028: Attention rides on top whenever the @-query prefixes it — the
    // Slack-style "type @a, Tab, done" path. Selection ARMS (see goItem).
    const attnRow: PickItem[] =
      workItemsOn && (!atQuery.trim() || 'attention'.startsWith(atQuery.trim().toLowerCase()))
        ? [
            {
              key: 'capture:attention',
              type: 'page',
              id: 'attention-capture',
              title: 'attention',
              hint: 'Capture — Tab to arm',
              icon: 'notifications'
            }
          ]
        : []
    const pool: PickItem[] = [
      ...nodes
        .filter((n) => n.kind === 'task' || n.kind === 'folder')
        .map((n) => ({
          key: `${n.kind === 'task' ? 'task' : 'folder'}:${n.id}`,
          type: (n.kind === 'task' ? 'task' : 'folder') as PickItem['type'],
          id: n.id,
          title: n.title || 'Untitled',
          hint: n.kind === 'task' ? 'Desk' : 'Room',
          icon: PICK_ICONS[n.kind === 'task' ? 'task' : 'folder']
        })),
      ...(['Tasks', 'Calendar', 'Files', 'Vault'] as const).map((t) => ({
        key: `page:${t.toLowerCase()}`,
        type: 'page' as const,
        id: t.toLowerCase(),
        title: t,
        hint: 'Page',
        icon: PICK_ICONS.page
      }))
    ]
    const q = atQuery.trim()
    if (!q) return [...attnRow, ...pool.slice(0, 8 - attnRow.length)]
    // Rank with the same token-coverage matcher the take-me-to route uses.
    const byId = new Map(pool.map((x) => [x.key, x]))
    const ranked = matchTargets(
      q,
      pool.map((x) => ({ kind: 'page' as const, id: x.key, title: x.title })),
      8
    )
    return [...attnRow, ...ranked.map((r) => byId.get(r.id)).filter((x): x is PickItem => !!x)]
  }, [atQuery, nodes, workItemsOn])

  useEffect(() => {
    const q = atQuery?.trim() ?? ''
    if (!pickerOpen || q.length < 2) {
      setApiHits([])
      return
    }
    let live = true
    const t = setTimeout(() => {
      void window.api.search
        .query(q)
        .then((hits) => {
          if (live) setApiHits(hits.filter((h) => PICKABLE.has(h.type)).slice(0, 10))
        })
        .catch(() => {})
    }, 140)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [atQuery, pickerOpen])

  const pickItems = useMemo<PickItem[]>(() => {
    const seen = new Set<string>()
    const out: PickItem[] = []
    for (const x of localItems) {
      if (!seen.has(x.key)) {
        seen.add(x.key)
        out.push(x)
      }
    }
    for (const h of apiHits) {
      const key = `${h.type}:${h.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        key,
        type: h.type,
        id: h.id,
        title: h.title || 'Untitled',
        hint: PICK_HINTS[h.type] ?? h.type,
        icon: PICK_ICONS[h.type] ?? 'search',
        taskId: h.taskId
      })
    }
    return out.slice(0, 8)
  }, [localItems, apiHits])

  useEffect(() => setHighlight(0), [atQuery])

  // Same landings PlexiSearch gives these hit types; widgets arrive selected.
  function goItem(it: PickItem): void {
    // DEC-028: the Attention row never navigates — it arms the pill.
    if (it.key === 'capture:attention') {
      armAttention()
      return
    }
    const view = useViewStore.getState()
    if (it.type === 'page') {
      if (it.id === 'tasks') view.goAllTasks()
      else if (it.id === 'calendar') view.goCalendar()
      else if (it.id === 'files') view.goFiles()
      else if (it.id === 'vault') view.goVault()
    } else if (it.type === 'task') {
      useNodeStore.getState().setActive(it.id)
      view.goTask(it.id)
    } else if (it.type === 'folder') {
      view.goProject(it.id)
    } else if (it.type === 'widget' || it.type === 'table-row') {
      if (it.taskId) {
        useNodeStore.getState().setActive(it.taskId)
        view.goTask(it.taskId)
        if (it.type === 'widget') useWidgetStore.getState().setSelection([it.id])
      }
    } else if (it.type === 'document') {
      view.goDocument(it.id)
    } else if (it.type === 'file') {
      view.goFiles()
    } else if (it.type === 'knowledge') {
      view.goKnowledge(it.id)
    }
    setGoal('')
    setApiHits([])
  }

  const pillowRect = pillowRef.current?.getBoundingClientRect()

  return (
    <div className="mb-6" data-testid="start-or-ask">
      {/* Glass chrome: the hero input floats above the desk-paper like a
          control, not a content card — the one Liquid Glass surface on Home. */}
      <div className="fb-glass-pillow rounded-[16px] p-3" ref={pillowRef}>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent shrink-0">
            <Icon name={searching ? 'travel_explore' : 'auto_awesome'} size={17} />
          </span>
          {attnArmed && (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-accent bg-accent/10 border border-accent/20 rounded-md px-1.5 py-0.5"
              title="Armed — Enter files what you type to Attention. Backspace on empty removes it."
            >
              <Icon name="notifications" size={11} />
              @attention
            </span>
          )}
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (pickerOpen && pickItems.length > 0) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlight((h) => {
                    const n = pickItems.length
                    return (h + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
                  })
                  return
                }
                // DEC-028: Tab arms @attention when its row is highlighted or
                // the @-query is a prefix of it — same grammar as ⌘K.
                if (e.key === 'Tab' && !e.shiftKey) {
                  const hl = pickItems[Math.min(highlight, pickItems.length - 1)]
                  const q = (atQuery ?? '').trim().toLowerCase()
                  if (hl?.key === 'capture:attention' || (workItemsOn && q && 'attention'.startsWith(q))) {
                    e.preventDefault()
                    armAttention()
                    return
                  }
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  goItem(pickItems[Math.min(highlight, pickItems.length - 1)])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDismissedFor(goal)
                  return
                }
              }
              if (attnArmed) {
                if (e.key === 'Backspace' && goal === '') {
                  setAttnArmed(false)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setAttnArmed(false)
                  return
                }
                if (e.key === 'Enter') {
                  // Armed Enter files: the confirm card takes it from here.
                  e.preventDefault()
                  const captureText = goal.trim()
                  window.dispatchEvent(
                    new CustomEvent('fb:command-new-work-item', {
                      detail: captureText ? { captureText } : undefined
                    })
                  )
                  setGoal('')
                  setAttnArmed(false)
                  return
                }
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                // DEC-031: an @attention token anywhere in the line is a
                // deterministic capture — it must never fall through to the
                // ask/search path (which is what silently swallowed it).
                const attn = workItemsOn ? parseAttentionCommand(goal) : null
                if (attn && attn.mode !== 'none') {
                  window.dispatchEvent(
                    new CustomEvent('fb:command-new-work-item', {
                      detail: attn.captureText ? { captureText: attn.captureText } : undefined
                    })
                  )
                  setGoal('')
                  setAttnArmed(false)
                  return
                }
                start()
              }
            }}
            disabled={sending}
            data-testid="start-or-ask-input"
            placeholder={
              attnArmed
                ? 'What needs attention? Enter files it…'
                : searching
                  ? 'Search the web — results open right here in Plexii'
                  : 'Ask Plexii, search the web, or open anything — @ jumps to a desk, room or work widget'
            }
            // No focus box (Caleb's ruling): the global :focus-visible outline
            // draws a hard accent rectangle around text inputs; this bar's
            // glass pillow IS the affordance, same precedent as the composer.
            className="flex-1 min-w-0 bg-transparent text-[14px] text-[var(--ink-100)] placeholder:text-[var(--ink-40)] disabled:opacity-60 focus:outline-none"
          />
          {/* The power path, taught where the suite home teaches it (R6 note). */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('fb:open-command-palette'))}
            title="Open the command palette"
            data-testid="start-or-ask-cmdk"
            className="shrink-0 hidden sm:inline-flex items-center px-2 py-0.5 rounded-md bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-50)] fb-tabular hover:text-[var(--ink-80)] transition-colors"
          >
            ⌘K
          </button>
          <button
            onClick={start}
            disabled={!goal.trim() || sending}
            data-testid="start-or-ask-go"
            className="shrink-0 h-8 px-3.5 rounded-lg bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            <Icon name="arrow_forward" size={14} />
            {searching ? 'Search' : 'Ask'}
          </button>
        </div>
        <div className="mt-2 pl-[42px] flex flex-wrap items-center gap-1.5">
          {/* The mode pills (Caleb's ruling): intent is a tap, not a guess. */}
          <div
            data-testid="start-or-ask-modes"
            className="inline-flex items-center gap-0.5 rounded-full bg-[var(--surface-sunken)] p-0.5 mr-1"
          >
            {(
              [
                { id: 'ask' as const, label: 'Ask Plexii', icon: 'forum' },
                { id: 'search' as const, label: 'Search', icon: 'travel_explore' }
              ] satisfies { id: OmniMode; label: string; icon: string }[]
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pickMode(m.id)}
                data-testid={`start-or-ask-mode-${m.id}`}
                aria-pressed={mode === m.id}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                  mode === m.id
                    ? 'bg-[var(--surface-raised)] text-[rgb(var(--accent))]'
                    : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
                }`}
              >
                <Icon name={m.icon} size={11} className="shrink-0" />
                {m.label}
              </button>
            ))}
          </div>
          {/* In Search mode the pinned engine is right here — the same
              preference the browser toolbar pins (AI-02, one store). */}
          {searching && <EnginePickerChip />}
          {!searching &&
            EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setGoal(ex)}
                disabled={sending}
                className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--surface-sunken)] text-[var(--ink-60)] hover:bg-[var(--surface-raised)] disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
        </div>
      </div>
      {pickerOpen && pickItems.length > 0 && pillowRect &&
        createPortal(
          <div
            data-testid="start-or-ask-mentions"
            className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in fixed z-[240] p-1"
            style={{
              top: pillowRect.bottom + 6,
              left: pillowRect.left + 42,
              width: Math.min(420, pillowRect.width - 42)
            }}
          >
            {pickItems.map((it, i) => (
              <button
                key={it.key}
                type="button"
                data-testid="start-or-ask-mention-row"
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  // mousedown, not click: the input keeps focus and no blur
                  // races the navigation.
                  e.preventDefault()
                  goItem(it)
                }}
                className={`w-full flex items-center gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 text-left transition-colors ${
                  i === highlight ? 'bg-[var(--surface-sunken)]' : ''
                }`}
              >
                <Icon name={it.icon} size={13} className="shrink-0 text-[var(--ink-60)]" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--ink-90)]">
                  {it.title}
                </span>
                <span className="shrink-0 fb-t-caption text-[var(--ink-40)]">{it.hint}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
