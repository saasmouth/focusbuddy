import { useEffect, useMemo, useState } from 'react'
import { confirmDialog, promptText } from '../../plexi/PromptDialog'
import { createPortal } from 'react-dom'
import type {
  ActionButton,
  ButtonStyle,
  DeckConfig,
  DeckPage,
  FolderButton,
  StreamDeckAction
} from '@shared/streamdeck'
import {
  BUTTON_PALETTE,
  STREAMDECK_SLOTS,
  makeButtonId,
  makePageId
} from '@shared/streamdeck'
import type { ChatMessage } from '@shared/types'
import { checkActionConflicts } from '@shared/macroConflicts'
import Icon from '../../Icon'

// AI macro tools for the SpeedDeck widget.
//
// Two surfaces share one dialog:
//
//   1. ASK — natural-language macro generator. The user types what they
//      want and the AI returns 1-3 alternative implementations — each
//      can be a SINGLE button (action runs immediately) or a FOLDER
//      (opens to a page of sub-buttons). For ambiguous requests like
//      "media controls", the AI returns BOTH options so the user can
//      pick whether they want a single play/pause button or a folder
//      with play, pause, next, previous, volume.
//
//   2. SUGGEST — pattern analysis over the local activity log. Same
//      proposal shape; the AI groups related workflows into folders
//      when they share a theme (e.g. "Dev tools folder with VSCode,
//      Terminal, Chrome devtools").

interface Props {
  open: boolean
  onClose: () => void
  deck: DeckConfig
  currentPageId: string
  onSaveButton: (slot: number, button: ActionButton | FolderButton) => void
  // Folder application needs to materialise the child page too. The
  // widget owns the deck config so it does the pages: { ... } merge.
  onSaveFolderWithChildren: (
    slot: number,
    folder: FolderButton,
    children: Array<{ position: number; button: ActionButton }>
  ) => void
}

type Mode = 'ask' | 'suggest'

interface AIChildButton {
  label: string
  icon: string
  color: string
  action: StreamDeckAction
}

// Unified proposal — either a single button or a folder containing
// up to 30 child buttons. The AI now picks one or the other (or both
// as alternatives) depending on what fits the request.
interface AIProposal {
  kind: 'button' | 'folder'
  label: string
  icon: string
  color: string
  // Why this proposal fits (high-level).
  reason: string
  // Step-by-step plain-English description of what happens when the
  // user presses this button (or opens this folder). Shown in the
  // expandable explanation panel.
  howItWorks: string
  // Present when kind === 'button'.
  action?: StreamDeckAction
  // Present when kind === 'folder'. The order matches the order they'll
  // be placed in the folder's page (row-major from slot 0).
  children?: AIChildButton[]
}

const SHARED_SCHEMA = `Each proposal is JSON with this shape:

{
  "kind": "button" | "folder",
  "label": "short label, max 20 chars",
  "icon": "material symbol name (e.g. 'content_copy', 'folder', 'music_note', 'terminal')",
  "color": "hex from palette: #8b5cf6 #6366f1 #3b82f6 #06b6d4 #10b981 #84cc16 #f59e0b #ef4444 #ec4899 #a855f7 #94a3b8 #1f2937",
  "reason": "1 sentence — what this does and why it fits the user's intent",
  "howItWorks": "1-3 sentences — step-by-step what happens when the user presses this, in plain English",
  "action": <StreamDeckAction>,        // ONLY when kind = "button"
  "children": [<child button>, ...]    // ONLY when kind = "folder" (1-30 entries)
}

A child button is the same shape minus kind/reason/howItWorks/children:

{ "label": "...", "icon": "...", "color": "...", "action": <StreamDeckAction> }

StreamDeckAction is ONE of:

{ "type": "open-app", "target": "app name or .app path" }
{ "type": "open-url", "url": "https://..." }
{ "type": "key-combo", "key": "single char or special key", "modifiers": ["cmd","shift","option","control","fn"] }
{ "type": "type-text", "text": "..." }
{ "type": "media-key", "key": "play-pause"|"next"|"previous"|"volume-up"|"volume-down"|"mute" }
{ "type": "set-volume", "level": 0-100 }
{ "type": "delay", "ms": milliseconds }
{ "type": "multi-step", "steps": [<single-step actions>] }

Special keys for key-combo: enter, tab, space, escape, delete, arrow-left, arrow-right, arrow-up, arrow-down, f1..f12.`

const ASK_SYSTEM_PROMPT = `You are SpeedDeck — a macro-pad button generator. The user gives a natural-language description; you generate 1-3 button/folder proposals as a JSON array.

ABSOLUTE RULES — NO EXCEPTIONS:
1. NEVER ask clarifying questions. EVER. The user wants buttons, not a conversation.
2. NEVER write prose, markdown, code fences, apologies, or explanations OUTSIDE the JSON.
3. If the request is vague, make a reasonable interpretation AND return alternatives so the user can pick. Do not stall.
4. Your response MUST be a JSON array starting with [ — nothing else.

If the request is ambiguous, ALWAYS return 2-3 alternatives covering the most likely interpretations. Examples:

USER: "media controls"
RETURN: a 3-element array:
  1. A SINGLE play/pause button (kind:"button", action:{type:"media-key",key:"play-pause"})
  2. A SMALL FOLDER "Media" with play/pause + next + previous (3 children)
  3. A FULL FOLDER "Media" with play/pause + next + previous + volume-up + volume-down + mute (6 children)

USER: "open spotify"
RETURN: a 1-element array with a single button: action {type:"open-app", target:"Spotify"}

USER: "screenshot"
RETURN: a 2-element array:
  1. Single button: {type:"key-combo", key:"4", modifiers:["cmd","shift"]} (region capture)
  2. Single button: {type:"key-combo", key:"3", modifiers:["cmd","shift"]} (full screen capture)

USER: "copy and paste"
RETURN: a 2-element array:
  1. Two separate buttons folder: "Clipboard" folder with Copy + Paste children
  2. Single multi-step button that copies AND pastes with a delay

USER: "dev tools" / "developer tools" / "tools for coding"
RETURN: a 1-element array with a FOLDER "Dev tools" containing buttons for: VSCode, Terminal, Chrome devtools (key-combo cmd+option+i), GitHub Desktop, postman, etc.

USER: "make me productive" (super vague)
RETURN: a 3-element array with three different folder interpretations: "Focus tools" / "Communication" / "Quick switch" — each a folder of ~4 buttons.

GUIDELINES:
- For "copy and paste in one step" use multi-step with key-combo C and key-combo V separated by a 50ms delay.
- For "screenshot" use key-combo cmd+shift+4 unless full-screen is specified.
- Pick icons that match: content_copy (copy), content_paste (paste), screenshot_monitor (screenshot), folder (folder), music_note (audio), terminal, code, language (web), mail, settings, etc.
- Color thoughtfully: green (#10b981) for go/start, red (#ef4444) for stop/danger, blue (#3b82f6) for navigation, violet (#8b5cf6) for general, amber (#f59e0b) for warnings.
- Folder labels are categories ("Media", "Dev tools", "Communication") not actions.
- howItWorks must explain step-by-step in plain English: "Pressing this sends ⌘⇧4 to the previous app, which opens macOS's region screenshot tool. Drag to select an area; the PNG saves to your desktop."

${SHARED_SCHEMA}`

const SUGGEST_SYSTEM_PROMPT = `You are SpeedDeck's pattern analyst. The user shares a JSON activity log (recent app switches + SpeedDeck button presses). You analyse it and return 3-5 macro proposals as a JSON array.

ABSOLUTE RULES:
1. NEVER ask clarifying questions.
2. NEVER write prose outside the JSON array.
3. Your response MUST start with [ and end with ].

WHEN TO PROPOSE A FOLDER vs A BUTTON:
- FOLDER when the user switches between 3+ related apps repeatedly (e.g. Slack ↔ Linear ↔ Notion → "Work tools" folder).
- BUTTON when one specific action would shortcut a single repetitive step (e.g. user opens Spotify 12 times → single "Open Spotify" button).
- The "reason" field MUST cite the specific pattern WITH NUMBERS (e.g. "You switched from Slack to Chrome 14 times in the last hour").
- The "howItWorks" field explains what the button does step-by-step.

Be conservative — only propose macros for patterns with >3 occurrences. Skip rare patterns.

${SHARED_SCHEMA}`

// ─── Parsing ───────────────────────────────────────────────────────────

// Extract a JSON value (array or object) from the AI's raw response.
// The AI is supposed to return strict JSON, but real-world responses
// often have stray prose, markdown fences, or a single object instead
// of the requested array. This handles all of those cases.
function extractJson(raw: string): unknown {
  if (!raw) throw new Error('Empty response from model.')
  let s = raw.trim()
  // Strip markdown fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  // If the model added prose, scan for the first [ or { and the matching
  // last ] or } using a brace counter (depth-aware).
  const tryAt = (openIdx: number, open: string, close: string): unknown => {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i]
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') inString = !inString
      if (inString) continue
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          const slice = s.slice(openIdx, i + 1)
          return JSON.parse(slice)
        }
      }
    }
    throw new Error('Unbalanced JSON.')
  }
  const firstBracket = s.indexOf('[')
  const firstBrace = s.indexOf('{')
  if (firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)) {
    return tryAt(firstBracket, '[', ']')
  }
  if (firstBrace >= 0) {
    return tryAt(firstBrace, '{', '}')
  }
  // Last resort: plain parse (will throw with a useful message).
  return JSON.parse(s)
}

function sanitizeColor(c: string): string {
  if (typeof c !== 'string') return BUTTON_PALETTE[0]
  return (BUTTON_PALETTE as readonly string[]).includes(c) ? c : BUTTON_PALETTE[0]
}

function isValidAction(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false
  const x = a as { type?: string; steps?: unknown }
  if (typeof x.type !== 'string') return false
  // The AI must never mint a shell command: a prompt-injected source could
  // otherwise steer it to create a run-shell button. Shell actions are only
  // ever hand-authored by the user in the editor.
  if (x.type === 'run-shell') return false
  if (x.type === 'multi-step' && Array.isArray(x.steps)) {
    if (x.steps.some((s) => (s as { type?: string })?.type === 'run-shell')) return false
  }
  return true
}

function normalizeProposals(parsed: unknown): AIProposal[] {
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const out: AIProposal[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<AIProposal>
    const kind: 'button' | 'folder' = p.kind === 'folder' ? 'folder' : 'button'
    const label = String(p.label || '').slice(0, 20)
    const icon = typeof p.icon === 'string' && p.icon ? p.icon : kind === 'folder' ? 'folder' : 'auto_awesome'
    const color = sanitizeColor(p.color as string)
    const reason = String(p.reason || '')
    const howItWorks = String((p as { howItWorks?: string }).howItWorks || '')
    if (kind === 'button') {
      if (!isValidAction(p.action)) continue
      out.push({
        kind: 'button',
        label,
        icon,
        color,
        reason,
        howItWorks,
        action: p.action as StreamDeckAction
      })
    } else {
      if (!Array.isArray(p.children) || p.children.length === 0) continue
      const children: AIChildButton[] = []
      for (const c of p.children as unknown[]) {
        if (!c || typeof c !== 'object') continue
        const cc = c as Partial<AIChildButton>
        if (!isValidAction(cc.action)) continue
        children.push({
          label: String(cc.label || '').slice(0, 20),
          icon: typeof cc.icon === 'string' && cc.icon ? cc.icon : 'auto_awesome',
          color: sanitizeColor(cc.color as string),
          action: cc.action as StreamDeckAction
        })
      }
      if (children.length === 0) continue
      out.push({
        kind: 'folder',
        label,
        icon,
        color,
        reason,
        howItWorks,
        children: children.slice(0, STREAMDECK_SLOTS)
      })
    }
  }
  return out
}

function findEmptySlot(page: DeckPage): number | null {
  for (let i = 0; i < STREAMDECK_SLOTS; i++) {
    if (!page.buttons[i]) return i
  }
  return null
}

// ─── Component ────────────────────────────────────────────────────────

export default function StreamDeckAI({
  open,
  onClose,
  deck,
  currentPageId,
  onSaveButton,
  onSaveFolderWithChildren
}: Props): JSX.Element | null {
  const [mode, setMode] = useState<Mode>('ask')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposals, setProposals] = useState<AIProposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // When parsing fails we keep the raw response so the user can see what
  // the AI actually said and (optionally) refine the prompt.
  const [rawFallback, setRawFallback] = useState<string | null>(null)
  const [trackingState, setTrackingState] = useState<{
    enabled: boolean
    switchCount: number
    pressCount: number
  } | null>(null)

  useEffect(() => {
    if (!open) return
    void (async () => {
      const s = await window.api.activity.getState()
      setTrackingState(s)
    })()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const currentPage = deck.pages[currentPageId]
  const emptySlot = useMemo(
    () => (currentPage ? findEmptySlot(currentPage) : null),
    [currentPage]
  )

  async function callModel(
    systemPrompt: string,
    userContent: string
  ): Promise<{ proposals: AIProposal[]; raw: string } | { error: string; raw?: string }> {
    // CRITICAL: the chat IPC strips role:'system' messages and applies
    // PlexiDesk's generic chat system prompt instead — which makes the
    // model respond conversationally ("I can help you with..."). We
    // work around this by embedding our system prompt as a normal USER
    // message labelled as instructions. The chat-level system prompt
    // still fires but our instruction message dominates because it's
    // the explicit, most-recent context.
    //
    // NOTE: we previously prefilled the assistant turn with "[" to
    // force JSON-array output. Claude Opus 4.6+ / Sonnet 4.6+ reject
    // requests with trailing assistant messages (400 error), so the
    // prefill is gone. Instead we lean on:
    //   1. Strict "OUTPUT FORMAT" instructions appended to the composed
    //      user message (below) — restating the JSON-only contract.
    //   2. The depth-aware extractJson() parser, which already strips
    //      stray prose / markdown fences if the model adds any.
    const composed = `${systemPrompt}\n\n---\n\nUSER REQUEST:\n${userContent}\n\n---\n\nOUTPUT FORMAT — STRICT:\nReturn ONLY a single valid JSON array. The first character of your response MUST be "[" and the last character MUST be "]". No prose. No markdown fences (no \`\`\`). No commentary before or after. No preamble like "Here is" or "Sure". Just the JSON array.`
    const messages: ChatMessage[] = [
      { role: 'user', content: composed, ts: Date.now() }
    ]
    const res = await window.api.chat.send({ taskId: null, messages })
    if (!res.ok || !res.message) {
      return {
        error: res.needsApiKey
          ? 'Add your Anthropic API key in Settings to use the AI macro tools.'
          : res.error || 'Could not reach the model.'
      }
    }
    // Hand the raw response to the depth-aware extractor. (Previously we
    // prefilled the assistant turn with "[" and prepended it back here,
    // but assistant prefill was removed when migrating to Opus 4.6+ /
    // Sonnet 4.6+ — see ai-proposal-owner. The strict OUTPUT FORMAT
    // clause + extractJson tolerate any residual prose / fences.)
    const raw = res.message.content
    try {
      const parsed = extractJson(raw)
      const ps = normalizeProposals(parsed)
      if (ps.length === 0) {
        return {
          error: 'The model returned no valid proposals. See raw response below — you can refine the prompt and try again.',
          raw
        }
      }
      return { proposals: ps, raw }
    } catch (err) {
      return {
        error: `Couldn't parse the model's response (${(err as Error).message}). Raw response shown below.`,
        raw
      }
    }
  }

  async function runAsk(): Promise<void> {
    if (busy || !prompt.trim()) return
    setBusy(true)
    setError(null)
    setProposals(null)
    setRawFallback(null)
    try {
      const result = await callModel(ASK_SYSTEM_PROMPT, prompt.trim())
      if ('error' in result) {
        setError(result.error)
        setRawFallback(result.raw ?? null)
      } else {
        setProposals(result.proposals)
      }
    } catch (err) {
      setError(`Something went wrong: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function runSuggest(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    setProposals(null)
    setRawFallback(null)
    try {
      const log = await window.api.activity.read()
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000
      const recentSwitches = log.switches.filter((s) => s.ts >= since)
      const appCounts = new Map<string, number>()
      for (const s of recentSwitches) {
        appCounts.set(s.app, (appCounts.get(s.app) ?? 0) + 1)
      }
      const sequence = recentSwitches
        .slice(-80)
        .map((s) => s.app)
        .join(' → ')
      const apps = Array.from(appCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([app, n]) => `${app}: ${n}x`)
        .join(', ')
      const presses = log.presses
        .slice(-30)
        .map((p) => `${p.label} (${p.kind})`)
        .join(', ')
      const summary = `Top apps (last 7 days): ${apps}\nSwitch sequence (most recent ~80): ${sequence}\nRecent SpeedDeck button presses: ${presses || '(none)'}`

      if (recentSwitches.length < 8 && log.presses.length < 5) {
        setError(
          'Not enough activity to analyse yet. Use PlexiiDesk + apps for a bit with tracking enabled, then come back.'
        )
        return
      }

      const result = await callModel(SUGGEST_SYSTEM_PROMPT, summary)
      if ('error' in result) {
        setError(result.error)
        setRawFallback(result.raw ?? null)
      } else {
        setProposals(result.proposals)
      }
    } catch (err) {
      setError(`Something went wrong: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function toggleTracking(enabled: boolean): Promise<void> {
    await window.api.activity.setEnabled(enabled)
    const s = await window.api.activity.getState()
    setTrackingState(s)
  }

  async function wipeTracking(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Wipe all logged activity?',
      body: 'This cannot be undone. Your tracking on/off setting stays the same.',
      confirmLabel: 'Wipe activity',
      danger: true
    })
    if (!confirmed) return
    await window.api.activity.wipe()
    const s = await window.api.activity.getState()
    setTrackingState(s)
  }

  async function applyProposal(p: AIProposal): Promise<void> {
    if (!currentPage) return
    let slot = emptySlot
    if (slot === null) {
      const raw = await promptText({
        title: 'This page is full',
        label: `Pick a slot number (1-${STREAMDECK_SLOTS}) to replace, or cancel.`,
        initial: '1',
        confirmLabel: 'Replace slot'
      })
      if (!raw) return
      const parsed = parseInt(raw, 10)
      if (!parsed || parsed < 1 || parsed > STREAMDECK_SLOTS) return
      slot = parsed - 1
    }
    const style: ButtonStyle = { icon: p.icon, color: p.color }
    if (p.kind === 'button' && p.action) {
      const button: ActionButton = {
        id: makeButtonId(),
        kind: 'action',
        label: p.label,
        style,
        action: p.action
      }
      onSaveButton(slot, button)
    } else if (p.kind === 'folder' && p.children) {
      const pageId = makePageId()
      const folder: FolderButton = {
        id: makeButtonId(),
        kind: 'folder',
        label: p.label || 'Folder',
        style,
        pageId
      }
      const children = p.children.slice(0, STREAMDECK_SLOTS).map((c, idx) => ({
        position: idx,
        button: {
          id: makeButtonId(),
          kind: 'action' as const,
          label: c.label,
          style: { icon: c.icon, color: c.color },
          action: c.action
        } satisfies ActionButton
      }))
      onSaveFolderWithChildren(slot, folder, children)
    }
  }

  if (!open) return null

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[260] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-white/[0.08] shadow-2xl flex flex-col"
        style={{
          background: 'rgba(16, 24, 39, 0.96)',
          boxShadow:
            'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(139, 92, 246, 0.12), 0 24px 64px -12px rgba(139, 92, 246, 0.28)',
          maxHeight: '90vh'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-white/[0.05]">
          <div
            className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0"
            style={{
              background:
                'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(99,102,241,0.18))'
            }}
          >
            <Icon name="auto_awesome" size={14} className="text-white" />
          </div>
          <h3 className="text-[13px] font-semibold text-stone-100 flex-1">
            SpeedDeck AI
          </h3>
          <button
            onClick={onClose}
            className="text-[11px] px-2 py-1 rounded text-stone-400 hover:text-stone-100 hover:bg-white/[0.06]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="flex items-center gap-0.5 px-3 py-2 border-b border-white/[0.05]">
          <button
            onClick={() => {
              setMode('ask')
              setProposals(null)
              setError(null)
              setRawFallback(null)
            }}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors inline-flex items-center gap-1 ${
              mode === 'ask'
                ? 'bg-accent/15 text-accent'
                : 'text-stone-400 hover:text-stone-100 hover:bg-white/[0.04]'
            }`}
          >
            <Icon name="chat_bubble" size={11} />
            <span>Build a macro</span>
          </button>
          <button
            onClick={() => {
              setMode('suggest')
              setProposals(null)
              setError(null)
              setRawFallback(null)
            }}
            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors inline-flex items-center gap-1 ${
              mode === 'suggest'
                ? 'bg-accent/15 text-accent'
                : 'text-stone-400 hover:text-stone-100 hover:bg-white/[0.04]'
            }`}
          >
            <Icon name="insights" size={11} />
            <span>Suggest from my activity</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {mode === 'ask' && (
            <>
              <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
                Describe what you want
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder='e.g. "media controls" — AI will suggest a single play/pause button OR a folder of play, pause, next, previous, volume — you pick.'
                className="w-full px-3 py-2 rounded-md text-[12px] text-stone-100 placeholder:text-stone-500"
                style={{
                  background: 'rgba(0,0,0,0.32)',
                  border: '1px solid rgba(255,255,255,0.08)'
                }}
              />
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-stone-500 italic">
                  AI returns 1–3 alternatives (button or folder) — pick whichever fits.
                </p>
                <button
                  onClick={() => void runAsk()}
                  disabled={busy || !prompt.trim()}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium disabled:opacity-50"
                  style={{
                    background:
                      'linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95))',
                    color: 'white',
                    boxShadow:
                      'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 8px 24px -8px rgba(139, 92, 246, 0.4)'
                  }}
                >
                  {busy ? 'Thinking…' : 'Generate'}
                </button>
              </div>
            </>
          )}

          {mode === 'suggest' && (
            <>
              <div
                className="rounded-md p-3 space-y-2"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.06)'
                }}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="text-[12px] text-stone-100 font-medium mb-0.5">
                      Watch my workflow to suggest macros
                    </div>
                    <p className="text-[10px] text-stone-400 leading-snug">
                      PlexiiDesk notes the names of apps you switch between
                      (every 10 seconds) and your SpeedDeck presses — locally,
                      never uploaded. Nothing else is recorded — no keystrokes,
                      no URLs, no window titles.
                    </p>
                  </div>
                  <button
                    onClick={() => void toggleTracking(!trackingState?.enabled)}
                    className={`h-5 w-9 rounded-full transition-colors flex items-center px-0.5 shrink-0 ${
                      trackingState?.enabled ? 'bg-accent' : 'bg-white/[0.1]'
                    }`}
                    title={trackingState?.enabled ? 'Pause tracking' : 'Enable tracking'}
                  >
                    <span
                      className={`h-4 w-4 rounded-full bg-white transition-transform ${
                        trackingState?.enabled ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                {trackingState && (
                  <div className="flex items-center gap-3 text-[10px] text-stone-400">
                    <span>
                      Logged: {trackingState.switchCount} switches,{' '}
                      {trackingState.pressCount} presses
                    </span>
                    <button
                      onClick={() => void wipeTracking()}
                      className="text-rose-300 hover:underline"
                    >
                      Wipe all activity
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => void runSuggest()}
                disabled={busy || !trackingState?.enabled}
                className="w-full px-3 py-2 rounded-md text-[12px] font-medium disabled:opacity-50"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95))',
                  color: 'white',
                  boxShadow:
                    'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 8px 24px -8px rgba(139, 92, 246, 0.4)'
                }}
                title={
                  trackingState?.enabled
                    ? 'Send the activity log to Claude for pattern analysis'
                    : 'Turn on tracking first, then come back'
                }
              >
                {busy ? 'Analysing…' : 'Analyse my activity'}
              </button>
            </>
          )}

          {error && (
            <div
              className="text-[11px] px-3 py-2 rounded-md"
              style={{
                background: 'rgba(244,114,182,0.10)',
                border: '1px solid rgba(244,114,182,0.25)',
                color: 'rgb(251, 207, 232)'
              }}
            >
              {error}
            </div>
          )}

          {rawFallback && (
            <div
              className="rounded-md"
              style={{
                background: 'rgba(0,0,0,0.32)',
                border: '1px solid rgba(255,255,255,0.06)'
              }}
            >
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-stone-400 font-semibold border-b border-white/[0.04]">
                Raw model response
              </div>
              <pre className="px-3 py-2 text-[11px] text-stone-300 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                {rawFallback}
              </pre>
            </div>
          )}

          {proposals && proposals.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
                {proposals.length === 1 ? 'Proposal' : `${proposals.length} alternatives — pick one`}
              </div>
              {proposals.map((p, i) => (
                <ProposalRow
                  key={i}
                  proposal={p}
                  deck={deck}
                  onApply={() => applyProposal(p)}
                />
              ))}
              {emptySlot === null && (
                <p className="text-[10px] text-amber-300/80">
                  This page is full — applying will prompt you for a slot to
                  replace.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Proposal row ──────────────────────────────────────────────────────

function ProposalRow({
  proposal,
  deck,
  onApply
}: {
  proposal: AIProposal
  deck: DeckConfig
  onApply: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isFolder = proposal.kind === 'folder'
  // Conflict check across proposed action(s). For folder proposals we
  // check every child's action; for button proposals we check the
  // single action. Surfaced as small chips next to the proposal so the
  // user sees WHY before adding.
  const conflicts = useMemo<{
    reserved: number
    standard: number
    duplicate: number
  }>(() => {
    const actions: StreamDeckAction[] = []
    if (proposal.kind === 'button' && proposal.action) actions.push(proposal.action)
    if (proposal.kind === 'folder' && proposal.children) {
      for (const c of proposal.children) actions.push(c.action)
    }
    let reserved = 0
    let standard = 0
    let duplicate = 0
    for (const a of actions) {
      const r = checkActionConflicts(a, deck)
      if (r.reserved?.tier === 'reserved') reserved++
      if (r.reserved?.tier === 'standard') standard++
      if (r.duplicate?.tier === 'duplicate') duplicate++
    }
    return { reserved, standard, duplicate }
  }, [proposal, deck])
  return (
    <div
      className="rounded-md p-2.5"
      style={{
        background: 'rgba(0,0,0,0.28)',
        border: `1px solid ${isFolder ? 'rgba(139,92,246,0.25)' : 'rgba(255,255,255,0.06)'}`
      }}
    >
      <div className="flex items-start gap-3">
        <PreviewTile
          icon={proposal.icon}
          color={proposal.color}
          label={proposal.label}
          isFolder={isFolder}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-medium"
              style={{
                background: isFolder
                  ? 'rgba(139,92,246,0.20)'
                  : 'rgba(148,163,184,0.12)',
                color: isFolder ? '#c4b5fd' : '#cbd5e1'
              }}
            >
              {isFolder ? `Folder · ${proposal.children?.length ?? 0} buttons` : 'Single button'}
            </span>
            <span className="text-[12px] font-medium text-stone-100">
              {proposal.label}
            </span>
            {conflicts.reserved > 0 && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{
                  background: 'rgba(244, 114, 182, 0.15)',
                  border: '1px solid rgba(244, 114, 182, 0.35)',
                  color: 'rgb(251, 207, 232)'
                }}
                title="At least one keystroke in this proposal overlaps a reserved macOS shortcut"
              >
                ⚠ {conflicts.reserved} reserved
              </span>
            )}
            {conflicts.duplicate > 0 && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{
                  background: 'rgba(251, 191, 36, 0.15)',
                  border: '1px solid rgba(251, 191, 36, 0.35)',
                  color: 'rgb(253, 230, 138)'
                }}
                title="Already used by another button on this deck"
              >
                · {conflicts.duplicate} dupe
              </span>
            )}
            {conflicts.standard > 0 && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{
                  background: 'rgba(52, 211, 153, 0.12)',
                  border: '1px solid rgba(52, 211, 153, 0.28)',
                  color: 'rgb(167, 243, 208)'
                }}
                title="Recognised standard shortcut — common, OK to put on the deck"
              >
                ✓ {conflicts.standard} std
              </span>
            )}
          </div>
          <div className="text-[10px] text-stone-400 leading-snug mt-1">
            {proposal.reason}
          </div>
          {proposal.kind === 'button' && proposal.action && (
            <ActionSummary action={proposal.action} />
          )}
          {proposal.kind === 'folder' && proposal.children && (
            <FolderContentSummary children={proposal.children} />
          )}
          {proposal.howItWorks && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-accent hover:text-accent/80 mt-1.5 inline-flex items-center gap-0.5"
            >
              <Icon name={expanded ? 'expand_less' : 'expand_more'} size={11} />
              {expanded ? 'Hide details' : 'How it works'}
            </button>
          )}
          {expanded && proposal.howItWorks && (
            <div
              className="mt-1.5 p-2 rounded text-[11px] text-stone-300 leading-relaxed"
              style={{
                background: 'rgba(0,0,0,0.32)',
                border: '1px solid rgba(255,255,255,0.05)'
              }}
            >
              {proposal.howItWorks}
              {proposal.kind === 'folder' && proposal.children && proposal.children.length > 0 && (
                <div className="mt-2 pt-2 border-t border-white/[0.05]">
                  <div className="text-[9px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
                    All {proposal.children.length} buttons in this folder
                  </div>
                  <ul className="space-y-0.5">
                    {proposal.children.map((c, i) => (
                      <li key={i} className="flex items-center gap-1.5 text-[10px] text-stone-400">
                        <Icon name={c.icon} size={10} className="opacity-60 shrink-0" />
                        <span className="text-stone-200 font-medium min-w-[80px] truncate">{c.label}</span>
                        <span className="font-mono text-stone-500 truncate">{summariseActionForRow(c.action)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onApply}
          className="text-[11px] px-2.5 py-1 rounded-md font-medium shrink-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95))',
            color: 'white',
            boxShadow:
              'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 6px 18px -6px rgba(139, 92, 246, 0.4)'
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

function summariseActionForRow(a: StreamDeckAction): string {
  switch (a.type) {
    case 'open-app':
      return `open ${a.target || '?'}`
    case 'open-url':
      return a.url
    case 'key-combo':
      return `${(a.modifiers || []).join('+')}${a.modifiers?.length ? '+' : ''}${a.key}`
    case 'type-text':
      return `type "${a.text.slice(0, 20)}…"`
    case 'media-key':
      return a.key
    case 'set-volume':
      return `vol ${a.level}%`
    case 'multi-step':
      return `${a.steps.length}-step`
    case 'delay':
      return `wait ${a.ms}ms`
    case 'run-shell':
      return `shell`
    default:
      return ''
  }
}

function PreviewTile({
  icon,
  color,
  label,
  isFolder
}: {
  icon: string
  color: string
  label: string
  isFolder: boolean
}): JSX.Element {
  return (
    <div
      className="h-14 w-14 inline-flex items-center justify-center relative overflow-hidden shrink-0"
      style={{
        borderRadius: 8,
        background: `linear-gradient(155deg, ${color}50, ${color}20), #0d1226`,
        border: `1px solid ${color}80`,
        boxShadow: [
          'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
          `inset 0 -8px 16px ${color}40`,
          `0 0 14px -2px ${color}60`
        ].join(', ')
      }}
    >
      {isFolder && (
        <span
          className="absolute top-1 right-1 text-white/60"
          title="Folder"
        >
          <Icon name="folder" size={8} />
        </span>
      )}
      <div className="flex flex-col items-center gap-0.5">
        <Icon name={icon} size={16} className="text-white" filled />
        {label && (
          <span
            className="text-[7px] uppercase tracking-wider font-semibold text-white truncate max-w-[50px]"
            style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  )
}

function FolderContentSummary({
  children
}: {
  children: AIChildButton[]
}): JSX.Element {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {children.slice(0, 8).map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]"
          style={{
            background: `${c.color}15`,
            border: `1px solid ${c.color}40`,
            color: '#e2e8f0'
          }}
          title={c.label}
        >
          <Icon name={c.icon} size={9} className="opacity-80" />
          <span>{c.label}</span>
        </span>
      ))}
      {children.length > 8 && (
        <span className="text-[10px] text-stone-500">+ {children.length - 8} more</span>
      )}
    </div>
  )
}

function ActionSummary({ action }: { action: StreamDeckAction }): JSX.Element {
  function summariseSingle(a: StreamDeckAction): string {
    switch (a.type) {
      case 'open-app':
        return `open ${a.target || '(app)'}`
      case 'open-url':
        return `open ${a.url}`
      case 'key-combo': {
        const m = (a.modifiers || []).join('+')
        return `${m ? m + '+' : ''}${a.key}`
      }
      case 'type-text':
        return `type "${a.text.slice(0, 30)}${a.text.length > 30 ? '…' : ''}"`
      case 'media-key':
        return `media: ${a.key}`
      case 'set-volume':
        return `volume → ${a.level}%`
      case 'run-shell':
        return `shell: ${a.command.slice(0, 30)}…`
      case 'delay':
        return `wait ${a.ms}ms`
      default:
        return '(action)'
    }
  }
  function summarise(a: StreamDeckAction): string {
    if (a.type === 'multi-step') {
      return `${a.steps.length}-step: ` + a.steps.map(summariseSingle).join(' → ')
    }
    return summariseSingle(a)
  }
  return (
    <div className="text-[10px] font-mono text-stone-500 mt-1 truncate">
      {summarise(action)}
    </div>
  )
}
