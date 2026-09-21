// The agentic-browsing loop (A6/B2, R26/R27/R28). One runtime, Plexii's:
import { overlayNotice } from './browserOverlays'
import { detectStall, roundSignature, stallNotice, stallSummary, steerNotice } from './browserProgress'
// this driver runs in main, owns the round budget and the consent gate, and
// narrates everything it does as events the chat surface renders (B3). The
// model plans; the bridge acts; R29 lives in the bridge — a banned action
// refuses in code no matter what the model asked for.
//
// The R27 hybrid decision happens per ROUND, not per run: every round tries
// the DOM snapshot first, and only when the page yields no structural
// elements does the round fall back to a screenshot and the coordinate
// vocabulary. One sanitiser and one kill switch cover both.

import { BrowserWindow } from 'electron'
import {
  createAgentRun,
  stopAgentRun,
  endAgentRun,
  performAgentAction,
  type ActionResult,
  drainSteers,
  type AgentAction,
  type PageElement
} from './browserActions'
import {
  MODEL_ROUND_BUDGET,
  MUTATING_KINDS,
  sanitiseBrowserAction,
  type BrowserEnvelope,
  collectResultLine
} from './browserAgentEnvelope'
import { enforceAgentStatus } from './agentEnvelope'
import { runBrowserAgentStep, type BrowserStepContent } from './anthropic'
import { consentGate, grantConsent } from '../browserConsent'
import { resolveModel } from './modelRouting'
import { estimateCostMicros } from './aiCost'
import {
  emptyFindings,
  findingsDigest,
  hasFindings,
  mergeFindings,
  type BrowseFindings
} from '@shared/browseFindings'

export interface BrowserRunCost {
  inputTokens: number
  outputTokens: number
  costMicros: number
}

export type BrowserAgentEvent =
  | { kind: 'started'; runId: string; task: string }
  | { kind: 'round'; runId: string; round: number; mode: 'dom' | 'screenshot'; url: string }
  // rememberable: false for a page with no web address — there is no key to
  // store a standing grant under, so the prompt must not offer one.
  | { kind: 'consent_required'; runId: string; host: string; rememberable: boolean }
  | {
      kind: 'acted'
      runId: string
      round: number
      narration: string
      action: AgentAction
      ok: boolean
      refused?: string
      detail?: string
      url: string
      // Running totals so the visible run's cost ticker stays live (B4's
      // surface reads the same numbers).
      cost: BrowserRunCost
      // What the agent could see when it chose this action (AI-43): the
      // page-text window of this round, for the step drill-in.
      readWindow?: { start: number; end: number; total: number }
    }
  | { kind: 'needs_human'; runId: string; reason: string }
  // The user said something mid-run and it has been handed to the model. Shown
  // in the dock so a steer that lands between rounds is visibly received rather
  // than seeming to vanish.
  | { kind: 'steered'; runId: string; round: number; text: string }
  | {
      kind: 'finished'
      runId: string
      outcome: 'done' | 'blocked' | 'need_input' | 'stopped' | 'budget' | 'denied' | 'failed'
      summary: string
      rounds: number
      cost: BrowserRunCost
      // What the run actually learned. Carried on EVERY outcome, not just
      // 'done': a run stopped by the user or cut off by the round budget has
      // usually found most of what was asked for, and throwing that away was
      // the reason a 22-round research run could end with nothing to show.
      findings: BrowseFindings
    }

interface LiveRun {
  runId: string
  consentWaiter: ((granted: boolean) => void) | null
  // Whether the pending consent answer should be recorded as a standing
  // grant; set before the waiter resolves so the loop reads it truthfully.
  remember: boolean
}

const liveRuns = new Map<string, LiveRun>()

function broadcast(ev: BrowserAgentEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('browserAgent:event', ev)
  }
}

// Answer a pending consent prompt. remember=true records the standing grant
// (R26's reviewable list); a one-time yes lets only THIS run proceed.
export function resolveBrowserConsent(runId: string, granted: boolean, remember: boolean): boolean {
  const live = liveRuns.get(runId)
  if (!live?.consentWaiter) return false
  live.remember = remember
  const w = live.consentWaiter
  live.consentWaiter = null
  w(granted)
  return true
}

export function stopBrowserAgent(runId: string): boolean {
  const stopped = stopAgentRun(runId)
  const live = liveRuns.get(runId)
  if (live?.consentWaiter) {
    const w = live.consentWaiter
    live.consentWaiter = null
    w(false)
  }
  return stopped
}

// A repeated action named plainly enough that the model cannot wave it away.
// "Try something different" is advice; "you clicked element 14 twice and
// nothing changed" is an observation it has to act on.
export function describeActionBriefly(a: AgentAction): string {
  switch (a.kind) {
    case 'click':
      return `click on element ${a.elementIndex}`
    case 'type':
      return `type into element ${a.elementIndex}`
    case 'select':
      return `select in element ${a.elementIndex}`
    case 'open_url':
      return `open ${a.url}`
    case 'scroll':
      return `scroll by ${a.dy}`
    case 'press_key':
      return `press ${a.key}`
    case 'click_at':
      return `click at ${a.x},${a.y}`
    case 'collect':
      return `collect ${a.what}`
    default:
      return a.kind
  }
}


// The honest coverage line (AI-42): the excerpt names WHICH slice of the
// page it is, and says so when there is more below — the model's cue that
// scrolling advances the window.
function pageTextLine(read: ActionResult): string {
  const text = (read.text ?? '').slice(0, 2500)
  if (!text) return 'PAGE TEXT: (no readable text)'
  const start = read.textStart ?? 0
  const total = read.textTotal ?? text.length
  const end = start + text.length
  const more = end < total ? ` — the page continues (${total} chars in all); scroll down to read further` : ''
  return `PAGE TEXT (chars ${start}–${end} of ${total}${more}):\n${text}`
}

function elementLine(el: PageElement): string {
  const tag = el.type && el.type !== el.tag ? `${el.tag}(${el.type})` : el.tag
  const flags = [
    el.isPassword ? 'password — off-limits' : '',
    el.isPayment ? 'payment — off-limits' : '',
    el.isFileInput ? 'file — off-limits' : '',
    el.disabled ? 'disabled' : ''
  ]
    .filter(Boolean)
    .join(', ')
  const value = el.value ? ` value=${JSON.stringify(el.value.slice(0, 40))}` : ''
  const opts = el.options?.length ? ` options=[${el.options.slice(0, 10).join(', ')}]` : ''
  return `[${el.idx}] ${tag} ${JSON.stringify(el.label)}${value}${opts}${flags ? ` (${flags})` : ''}`
}

// How many interactive elements one observation may list. Unbounded, this was
// the single largest line item in a run's bill: a search-results or directory
// page yields many hundreds of elements, every one of them re-sent on every
// subsequent round. 60 comfortably covers the links and controls a page's
// primary content exposes; the tail is nav chrome, footers and cookie banners.
export const ELEMENT_BUDGET = 60

// How many PAST rounds keep their full observation in the transcript.
//
// Zero, deliberately. The model needs the page it is looking at now, what its
// last action did (lastResultLine) and what it has recorded (the findings
// replay) — it does not need the raw text of a page it already mined. Keeping
// even one costs a full observation every round for context the findings
// already hold.
//
// Zero also has a property no other value has: with every past round frozen to
// a digest the moment it ends, the transcript becomes strictly append-only, so
// the whole history is a stable prefix a cache breakpoint can cover.
//
// Be precise about which of those two things saves the money, because they are
// easy to conflate. The COMPACTION is what turns a long run from dollars into
// cents: it stops each round re-sending every earlier page. The caching is a
// bonus on top, and on the default browse model it currently contributes
// nothing at all — Claude Haiku 4.5 will not cache a prefix under 4096 tokens
// and this loop's prefix (a ~960-token system prompt plus ~115 tokens per
// frozen round) does not reach that inside the round budget. It caches
// silently, with no error and no saving. The breakpoint still earns its place:
// it costs nothing when it misses and starts paying the moment a run is routed
// to a model with a lower minimum (Sonnet 5 at 1024, Opus 5 at 512), which is
// what the model-mode override does.
export const VERBATIM_ROUNDS = 0

// Prefer the elements a task can actually act on. Labelled controls beat
// unlabelled ones (an unlabelled div tells the model nothing it can use), and
// form controls beat links, because a stuck run is usually stuck on an input.
function rankElement(el: PageElement): number {
  let score = 0
  if (el.label && el.label.trim()) score += 4
  if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') score += 3
  else if (el.tag === 'button') score += 2
  else if (el.tag === 'a') score += 1
  if (el.disabled) score -= 3
  return score
}

// Cap the element list, keeping the highest-ranked and restoring DOM order so
// indices still read top-to-bottom down the page.
export function capElements(elements: PageElement[]): { kept: PageElement[]; dropped: number } {
  if (elements.length <= ELEMENT_BUDGET) return { kept: elements, dropped: 0 }
  const kept = elements
    .map((el, i) => ({ el, i, score: rankElement(el) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, ELEMENT_BUDGET)
    .sort((a, b) => a.i - b.i)
    .map((e) => e.el)
  return { kept, dropped: elements.length - kept.length }
}

// One completed round: what the model saw, the one-line record that replaces
// it once it ages out, and what the model replied.
export interface Turn {
  observation: BrowserStepContent
  digest: string
  reply: string
}

// Build the message list for a round.
//
// The transcript used to be append-only and verbatim: round 22 re-sent all 21
// earlier observations in full, so a run's cost grew with the SQUARE of its
// length. Here every round older than VERBATIM_ROUNDS collapses to its digest,
// which makes per-round input roughly constant. What those pages actually said
// is not lost — it was recorded into findings at the time, and the findings
// list is replayed in every observation.
//
// The digest of a stale round never changes once written, so everything before
// the verbatim window is an append-only prefix — which is what makes it
// cacheable. `cacheAt` is the index of the last message in that stable prefix;
// the caller marks it so the API can serve the whole prefix from cache at ~10%
// of the input price instead of re-charging it every round.
export function transcript(
  turns: Turn[],
  current: BrowserStepContent
): { messages: Array<{ role: 'user' | 'assistant'; content: BrowserStepContent }>; cacheAt: number } {
  const out: Array<{ role: 'user' | 'assistant'; content: BrowserStepContent }> = []
  const staleCount = Math.max(0, turns.length - VERBATIM_ROUNDS)
  turns.forEach((t, i) => {
    out.push({ role: 'user', content: i < staleCount ? t.digest : t.observation })
    out.push({ role: 'assistant', content: t.reply })
  })
  out.push({ role: 'user', content: current })
  // The boundary round flips verbatim → digest as the window slides, so the
  // prefix is only guaranteed stable up to the round BEFORE it.
  const stableTurns = Math.max(0, staleCount - 1)
  return { messages: withoutStaleImages(out), cacheAt: stableTurns * 2 - 1 }
}

// Keep only the newest screenshot in the transcript — images are the bulk
// of a round's tokens and only the current one is actionable.
function withoutStaleImages(
  messages: Array<{ role: 'user' | 'assistant'; content: BrowserStepContent }>
): Array<{ role: 'user' | 'assistant'; content: BrowserStepContent }> {
  return messages.map((m, i) => {
    if (i === messages.length - 1 || typeof m.content === 'string') return m
    const text = m.content
      .map((b) => (b.type === 'text' ? b.text : '(screenshot from an earlier round omitted)'))
      .join('\n')
    return { role: m.role, content: text }
  })
}

export interface BrowserAgentStartResult {
  runId: string
}

// Start a run and return immediately; the loop reports through events and
// settles the returned promise chain internally. `onEvent` (tests, B3
// in-process listeners) is called for every event in addition to the
// renderer broadcast.
export function runBrowserAgent(input: {
  wcId: number
  task: string
  startUrl?: string
  onEvent?: (ev: BrowserAgentEvent) => void
}): BrowserAgentStartResult {
  const run = createAgentRun(input.wcId)
  const live: LiveRun = { runId: run.id, consentWaiter: null, remember: false }
  liveRuns.set(run.id, live)
  const emit = (ev: BrowserAgentEvent): void => {
    broadcast(ev)
    input.onEvent?.(ev)
  }
  void drive(run.id, input, live, emit).finally(() => {
    endAgentRun(run.id)
    liveRuns.delete(run.id)
  })
  return { runId: run.id }
}

async function drive(
  runId: string,
  input: { wcId: number; task: string; startUrl?: string },
  live: LiveRun,
  emit: (ev: BrowserAgentEvent) => void
): Promise<void> {
  const cost: BrowserRunCost = { inputTokens: 0, outputTokens: 0, costMicros: 0 }
  // Everything the run has learned, carried forward across rounds. This is the
  // memory that lets old observations be dropped, and it is also the run's
  // actual deliverable — what used to be discarded at the end. Declared before
  // finish(), which closes over it and can fire on the very first navigation.
  let findings: BrowseFindings = emptyFindings()
  const model = resolveModel('browser_agent')
  let rounds = 0
  const finish = (outcome: Extract<BrowserAgentEvent, { kind: 'finished' }>['outcome'], summary: string): void =>
    emit({ kind: 'finished', runId, outcome, summary, rounds, cost, findings })

  emit({ kind: 'started', runId, task: input.task })
  const perform = (a: AgentAction): Promise<ActionResult> => performAgentAction(runId, a)

  if (input.startUrl) {
    const nav = await perform({ kind: 'open_url', url: input.startUrl })
    if (nav.refused === 'run_stopped') return finish('stopped', 'Stopped before it began.')
  }

  const turns: Turn[] = []
  let systemPrompt: string | undefined
  let lastResultLine = '(no action yet)'
  let priorFailed = 0
  // What the page looked like, and what was done to it, each round. A run that
  // repeats itself into an unchanging page is stuck however well each
  // individual action reports going.
  const signatures: string[] = []
  const actionKeys: string[] = []
  let stallWarning = ''

  while (rounds < MODEL_ROUND_BUDGET) {
    rounds++

    // ── Observe (R27: DOM first, screenshot only when the DOM yields nothing)
    // Consent walls first: they cover the content, they freeze scrolling, and
    // the element ranker pushes their controls down the list, so a run that
    // meets one reads nothing and clicks at it until the budget is gone.
    const overlays = await perform({ kind: 'dismiss_overlays' })
    if (overlays.refused === 'run_stopped') return finish('stopped', 'Stopped by the user.')
    const overlayLine = overlayNotice(overlays.overlays ?? null)
    const snap = await perform({ kind: 'snapshot' })
    if (snap.refused === 'run_stopped') return finish('stopped', 'Stopped by the user.')
    const read = await perform({ kind: 'read_page' })
    if (read.refused === 'run_stopped') return finish('stopped', 'Stopped by the user.')
    if (snap.refused === 'browser_gone' || read.refused === 'browser_gone') {
      return finish('failed', 'The browser surface went away mid-run.')
    }
    const allElements = snap.elements ?? []
    const { kept: elements, dropped: droppedElements } = capElements(allElements)
    const coordinateMode = !snap.ok || elements.length === 0
    const url = snap.pageUrl ?? read.pageUrl ?? ''
    emit({ kind: 'round', runId, round: rounds, mode: coordinateMode ? 'screenshot' : 'dom', url })

    // Anything the user typed while this was running. Drained here so it lands
    // at the top of the very next round rather than after the current plan.
    const steers = drainSteers(runId)
    const steerLine = steerNotice(steers, input.task)
    if (steers.length) emit({ kind: 'steered', runId, round: rounds, text: steers.join(' · ') })

    const obsLines = [
      // The user's own words go FIRST. Buried under a page of observation they
      // read as one more detail; they are the most important thing in the turn.
      steerLine,
      steerLine ? '' : '',
      `TASK: ${input.task}`,
      `ROUND ${rounds} of ${MODEL_ROUND_BUDGET}.`,
      `RESULT OF YOUR LAST ACTION: ${lastResultLine}`,
      stallWarning,
      overlayLine ?? '',
      '',
      // The run's memory. Earlier pages are gone from the transcript, so this
      // is the only record of them — and the yardstick for being finished.
      'RECORDED SO FAR (this is what the user receives — earlier pages are no',
      'longer in your context, so anything missing here is lost):',
      findingsDigest(findings),
      '',
      'OBSERVATION',
      `URL: ${url || '(no page loaded)'}`,
      snap.captchaPresent
        ? 'A CAPTCHA is present on this page — you cannot solve it; if it blocks the task, report need_input.'
        : '',
      pageTextLine(read)
    ].filter(Boolean)

    let content: BrowserStepContent
    if (coordinateMode) {
      const shot = await perform({ kind: 'screenshot' })
      if (shot.refused === 'run_stopped') return finish('stopped', 'Stopped by the user.')
      if (shot.ok && shot.image) {
        obsLines.push(
          `SCREENSHOT MODE: the page has no structural elements to list. Act with click_at/type_text using coordinates in the ${shot.image.width}x${shot.image.height} screenshot below.`
        )
        content = [
          { type: 'text', text: obsLines.join('\n') },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: shot.image.base64Png }
          }
        ]
      } else {
        obsLines.push('The page could not be observed at all this round; wait or navigate.')
        content = obsLines.join('\n')
      }
    } else {
      obsLines.push('ELEMENTS:', ...elements.map(elementLine))
      if (droppedElements > 0) {
        obsLines.push(
          `(${droppedElements} lower-priority elements omitted — mostly nav, footer and boilerplate. Scroll or open a more specific page if what you need is not listed.)`
        )
      }
      content = obsLines.join('\n')
    }
    // ── Plan (one model round) ────────────────────────────────────────────
    const built = transcript(turns, content)
    const step = await runBrowserAgentStep({
      systemPrompt,
      messages: built.messages,
      cacheAt: built.cacheAt
    })
    cost.inputTokens += step.usage.inputTokens
    cost.outputTokens += step.usage.outputTokens
    cost.costMicros += estimateCostMicros(model, step.usage.inputTokens, step.usage.outputTokens)
    systemPrompt = step.systemPrompt
    if (!step.ok || !step.envelope) {
      turns.push({
        observation: content,
        digest: `ROUND ${rounds} at ${url || '(no page)'} — the reply could not be used.`,
        reply: step.rawAssistant || '(unusable reply)'
      })
      lastResultLine = `Your reply could not be used: ${step.error ?? 'no envelope'}. Reply with ONLY the JSON object.`
      priorFailed++
      if (step.needsApiKey) return finish('failed', step.error ?? 'No API key.')
      if (priorFailed >= 3) return finish('failed', 'The model returned unusable output three times.')
      continue
    }
    const env: BrowserEnvelope = step.envelope
    // Fold this round's reading into the run's memory BEFORE anything can
    // return — a run that ends on this round (done, blocked, budget) must
    // still hand back everything it learned along the way.
    if (hasFindings(env.findings)) findings = mergeFindings(findings, env.findings)
    turns.push({
      observation: content,
      digest: `ROUND ${rounds} at ${url || '(no page)'} — ${env.narration || 'acted'}`,
      reply: step.rawAssistant
    })

    const action = sanitiseBrowserAction(env.action, {
      knownIndices: new Set(elements.map((e) => e.idx)),
      coordinateMode
    })
    const honest = enforceAgentStatus({
      status: env.status,
      blocker: env.blocker,
      actionCount: action ? 1 : 0,
      narration: env.narration,
      priorFailedCount: priorFailed
    })

    if (honest.status === 'done') return finish('done', env.narration || 'Done.')
    if (honest.status === 'blocked' || honest.status === 'need_input') {
      emit({ kind: 'needs_human', runId, reason: honest.blocker ?? 'The agent needs your input.' })
      return finish(honest.status, honest.blocker ?? env.narration ?? 'The run needs your input.')
    }
    if (!action) {
      lastResultLine =
        'Your action was invalid (unknown kind, an element index not in the observation, or a coordinate action outside screenshot mode). Choose again.'
      priorFailed++
      if (priorFailed >= 4) return finish('failed', 'The model kept proposing invalid actions.')
      continue
    }

    // ── Is this going anywhere? ──────────────────────────────────────────
    // Watch the PAGE, not the return value: the actions that trap a run all
    // report success, which is exactly why priorFailed never caught this.
    signatures.push(
      roundSignature({
        url,
        textStart: read.textStart ?? 0,
        textSample: read.text ?? '',
        elementCount: elements.length
      })
    )
    actionKeys.push(JSON.stringify(action))
    const stall = detectStall(signatures, actionKeys)
    const actionLabel = describeActionBriefly(action)
    if (stall === 'stop') {
      return finish('failed', stallSummary(actionLabel, rounds))
    }
    stallWarning = stall === 'warn' ? stallNotice(actionLabel) : ''

    // ── Consent (R26: first mutating action on an ungranted site pauses) ──
    if (MUTATING_KINDS.has(action.kind)) {
      // Fails closed: a page whose site cannot be determined asks every time
      // rather than slipping through — see consentGate.
      const gate = consentGate(url)
      if (gate.ask) {
        emit({ kind: 'consent_required', runId, host: gate.label, rememberable: gate.rememberable })
        const granted = await new Promise<boolean>((resolve) => {
          live.consentWaiter = resolve
        })
        if (!granted) return finish('denied', `You declined to let Plexii act on ${gate.label}.`)
        if (live.remember && gate.rememberable) grantConsent(gate.host)
      }
    }

    // ── Act (the bridge enforces R29 whatever was asked) ──────────────────
    const result = await perform(action)
    emit({
      kind: 'acted',
      runId,
      round: rounds,
      narration: env.narration,
      action,
      ok: result.ok,
      refused: result.refused,
      detail: result.detail,
      url: result.pageUrl ?? url,
      cost: { ...cost },
      readWindow: {
        start: read.textStart ?? 0,
        end: (read.textStart ?? 0) + Math.min(2500, (read.text ?? '').length),
        total: read.textTotal ?? (read.text ?? '').length
      }
    })
    if (result.refused === 'run_stopped') return finish('stopped', 'Stopped by the user.')
    if (result.refused === 'step_ceiling') return finish('budget', 'The bridge step ceiling was reached.')
    if (result.refused === 'credential_field' || result.refused === 'credential_submit') {
      emit({ kind: 'needs_human', runId, reason: 'This needs a sign-in — that part is yours.' })
    }
    if (result.ok) {
      priorFailed = 0
      lastResultLine =
        action.kind === 'collect'
          ? collectResultLine(action.what, result)
          : `${action.kind} succeeded${result.detail ? ` on ${JSON.stringify(result.detail)}` : ''}.`
      // Let navigations and re-renders settle before the next observation.
      await perform({ kind: 'wait', ms: 400 })
    } else {
      priorFailed++
      lastResultLine = `${action.kind} was REFUSED: ${result.refused}${result.detail ? ` (${result.detail})` : ''}. Do not retry it; re-plan or report blocked/need_input.`
    }
  }
  finish('budget', 'The round budget ran out before the task finished.')
}
