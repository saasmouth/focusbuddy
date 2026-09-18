// The browser-agent round envelope (A6/B2): pure parsing + sanitising for
// what the model returns each round, kept free of Electron/SDK deps so it
// unit-tests directly (the agentEnvelope.ts precedent). The sanitising
// discipline is R30's harvest from the retired voiceCommand engine: a kind
// WHITELIST, ids validated against the current snapshot (the model may only
// touch elements that exist), every param typed and capped, and anything
// unrecognised returning null rather than acting on a guess.
//
// The model returns ONE action per round (a page mutates under every act —
// batching would act on a stale world), or none when it is finished/stuck:
//   { "narration": "...", "status": "working|done|blocked|need_input",
//     "blocker": null | "...", "action": { "kind": ... } | null }

import type { AgentAction, CollectedItem } from './browserActions'
import { WAIT_CAP_MS } from './browserActions'
import { extractJson } from './chatJson'
import { coerceAgentStatus, normalizeBlocker } from './agentEnvelope'
import type { AgentStatus } from '@shared/types'
import { normalizeFindings, type BrowseFindings } from '@shared/browseFindings'

// Model rounds per run — the loop's own budget, tighter than the bridge's
// HARD_STEP_CEILING backstop (each round also spends observe steps).
export const MODEL_ROUND_BUDGET = 24

// Actions that CHANGE a site (vs navigate/read it). These are what the R26
// per-site consent gate covers: the first mutating action on an ungrated
// host pauses the run until the human answers.
export const MUTATING_KINDS: ReadonlySet<string> = new Set([
  'click',
  'type',
  'select',
  'press_key',
  'click_at',
  'type_text'
])

export interface BrowserEnvelope {
  narration: string
  status: AgentStatus
  blocker: string | null
  // Raw, unsanitised action object — sanitiseBrowserAction turns it into an
  // AgentAction or refuses it with null.
  action: Record<string, unknown> | null
  // What this round LEARNED, recorded as it is read rather than remembered.
  // The model is told the page it is looking at will be dropped from its
  // context next round, so anything it does not record here is lost — which
  // is exactly what used to happen to an entire run's research.
  findings: BrowseFindings
}

export function parseBrowserEnvelope(raw: string): BrowserEnvelope | null {
  const json = extractJson(raw)
  if (!json) return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const action =
    o.action && typeof o.action === 'object' ? (o.action as Record<string, unknown>) : null
  return {
    narration: typeof o.narration === 'string' ? o.narration.trim() : '',
    status: coerceAgentStatus(o.status),
    blocker: normalizeBlocker(o.blocker),
    action,
    findings: normalizeFindings(o.findings)
  }
}

// The R30-harvested sanitiser: whitelist + snapshot-membership + typed caps.
// `knownIndices` is the element set of the LAST snapshot shown to the model;
// an index outside it is a hallucinated target and refuses. The coordinate
// kinds are only lawful when the round ran in screenshot-fallback mode —
// a DOM round has indices, and coordinates would dodge their precision.
export function sanitiseBrowserAction(
  raw: Record<string, unknown> | null,
  opts: { knownIndices: ReadonlySet<number>; coordinateMode: boolean }
): AgentAction | null {
  if (!raw) return null
  const kind = typeof raw.kind === 'string' ? raw.kind : ''

  const idx = (): number | null => {
    const n = typeof raw.elementIndex === 'number' ? Math.trunc(raw.elementIndex) : NaN
    return Number.isFinite(n) && opts.knownIndices.has(n) ? n : null
  }
  const str = (key: string, cap: number): string | null => {
    const v = raw[key]
    return typeof v === 'string' && v.length > 0 ? v.slice(0, cap) : null
  }

  switch (kind) {
    case 'open_url': {
      const url = str('url', 2048)
      if (!url || /^\s*(javascript|data|file):/i.test(url)) return null
      return { kind: 'open_url', url }
    }
    case 'click': {
      const i = idx()
      return i == null ? null : { kind: 'click', elementIndex: i }
    }
    case 'type': {
      const i = idx()
      const text = str('text', 2000)
      if (i == null || text == null) return null
      return { kind: 'type', elementIndex: i, text, replace: raw.replace === true }
    }
    case 'select': {
      const i = idx()
      const value = str('value', 200)
      if (i == null || value == null) return null
      return { kind: 'select', elementIndex: i, value }
    }
    case 'collect': {
      // Read-only, so it is not a mutating kind and needs no site consent.
      const what = raw.what
      return what === 'links' || what === 'images' ? { kind: 'collect', what } : null
    }
    case 'scroll': {
      const dy = typeof raw.dy === 'number' && Number.isFinite(raw.dy) ? raw.dy : NaN
      return Number.isNaN(dy) ? null : { kind: 'scroll', dy }
    }
    case 'wait': {
      const ms = typeof raw.ms === 'number' && Number.isFinite(raw.ms) ? raw.ms : NaN
      if (Number.isNaN(ms)) return null
      return { kind: 'wait', ms: Math.max(0, Math.min(WAIT_CAP_MS, ms)) }
    }
    case 'press_key': {
      const key = raw.key
      return key === 'Enter' || key === 'Tab' || key === 'Escape' || key === 'Backspace'
        ? { kind: 'press_key', key }
        : null
    }
    case 'click_at': {
      if (!opts.coordinateMode) return null
      const x = typeof raw.x === 'number' ? raw.x : NaN
      const y = typeof raw.y === 'number' ? raw.y : NaN
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null
      return { kind: 'click_at', x, y }
    }
    case 'type_text': {
      if (!opts.coordinateMode) return null
      const text = str('text', 2000)
      return text == null ? null : { kind: 'type_text', text }
    }
    default:
      return null
  }
}

// The round contract the model works under. Mirrors R29 in words — but the
// words are explanation, not enforcement: the bridge refuses banned acts in
// code whatever the model says.
export function buildBrowserAgentSystemPrompt(): string {
  return [
    'You are Plexii driving the in-app browser for the user, one step at a time.',
    'Each round you receive the task, what happened so far, and an OBSERVATION of the current page: its URL, readable text, and a numbered list of interactive elements (or a screenshot when the page cannot be read structurally).',
    '',
    'Reply with ONLY a JSON object, no prose around it:',
    '{"narration": "one short sentence saying what you are doing and why",',
    ' "status": "working" | "done" | "blocked" | "need_input",',
    ' "blocker": null or the reason you cannot proceed,',
    ' "action": one action object or null,',
    ' "findings": what THIS page told you (see below) or null}',
    '',
    'RECORDING WHAT YOU FIND — this matters as much as the browsing:',
    'You will NOT see this page again. Each round you are shown the current page',
    'and a RECORDED SO FAR list; earlier pages are dropped from your context. So',
    'anything you do not write into "findings" the moment you read it is lost,',
    'and you will waste rounds re-visiting pages to re-read it.',
    '',
    '"findings" is:',
    '  {"fields": ["name","specialty","rating","website"],',
    '   "records": [{"name":"...","specialty":"...","rating":"4.9","website":"https://..."}],',
    '   "answer": "prose answer, for a task that asks a question rather than for a list"}',
    'Use the same field names every round so the records line up. Record a partial',
    'record as soon as you have it and add the missing fields when a later page',
    'supplies them — records merge on their first field. Use "answer" for',
    'question-shaped tasks, "records" for list-shaped ones, both when the task',
    'wants a list plus a verdict. Send null when a page taught you nothing.',
    '',
    'Record only what the page actually says. Never fill a field with a guess, a',
    'placeholder or a remembered value — leave it out and it stays absent. An',
    'absent field is honest; an invented rating or URL is not.',
    '',
    'You are done when RECORDED SO FAR answers the task — not when you have',
    'visited a certain number of pages. Check it each round: if it is already',
    'complete, set status "done" immediately rather than browsing on.',
    '',
    'Actions (exactly one per round; status "working" requires one):',
    '  {"kind":"open_url","url":"https://..."} — navigate',
    '  {"kind":"click","elementIndex":N} — click element N from the observation',
    '  {"kind":"type","elementIndex":N,"text":"...","replace":true|false}',
    '  {"kind":"select","elementIndex":N,"value":"..."}',
    '  {"kind":"scroll","dy":pixels} — positive scrolls down. The page-text excerpt follows your scroll position: on a long page, scroll to read further before concluding you have seen everything.',
    '  {"kind":"collect","what":"links"|"images"} — harvest every link or image on the page as a list of URLs. Use this when the task is to GATHER things rather than read prose: the element list only shows what you can act on, and images never appear in it at all. What comes back is a list, not a page — record what matters into findings, because the list is gone next round like everything else.',
    '  {"kind":"wait","ms":500} — let a page settle',
    '  {"kind":"press_key","key":"Enter"|"Tab"|"Escape"|"Backspace"}',
    'In screenshot mode only: {"kind":"click_at","x":N,"y":N} and {"kind":"type_text","text":"..."}.',
    '',
    'Hard rules, enforced by the runtime whatever you reply:',
    '- Never enter passwords or card details, and never submit login or payment forms. If the task needs a sign-in or a purchase, set status "need_input" and say so — the human does that part.',
    '- Never upload or download files. Never attempt a CAPTCHA.',
    '- When the task is complete, set status "done", and make sure "findings" holds the full result — the narration is a one-line status, NOT the deliverable. What you put in findings is what the user actually receives.',
    '- If an action is refused, do not retry it; re-plan or report "blocked" with the reason.',
    '- You have a limited step budget; be direct. Never invent element indices — only use numbers from the current observation.'
  ].join('\n')
}

// A harvest, rendered for the model. This is the ONLY round the list exists in
// — like every other observation it is dropped afterwards — so the line says
// so plainly, or a run collects fifty links and records none of them.
export function collectResultLine(
  what: 'links' | 'images',
  result: { collected?: CollectedItem[]; collectedTotal?: number }
): string {
  const items = result.collected ?? []
  const total = result.collectedTotal ?? items.length
  if (items.length === 0) return `collect ${what} found none on this page.`
  const more = total > items.length ? ` of ${total} on the page (the rest were not listed)` : ''
  const lines = items.map((it) => {
    const size = it.w && it.h ? ` ${it.w}x${it.h}` : ''
    const label = it.text ? ` ${JSON.stringify(it.text)}` : ''
    return `  - ${it.url}${label}${size}`
  })
  return [
    `collect ${what} returned ${items.length}${more}:`,
    ...lines,
    `This list is NOT repeated next round. Put every one you need into findings now.`
  ].join('\n')
}
