// Setting a dashboard up by answering a few questions instead of arranging it.
//
// A dashboard nobody configured is a dashboard of defaults, and the reason
// people leave it that way is not indifference — it is that "which of these
// twenty widgets do you want" is a question you cannot answer before you have
// used the thing. So the wizard asks what somebody already knows about
// themselves — what their work is, what goes wrong, how they like to start —
// and derives the widgets from that.
//
// Every question can be answered by clicking, and every question also takes
// free text, because a fixed list of roles is a fixed list of people and the
// person whose job is not on it is exactly the one whose dashboard is wrong
// today.
//
// This module is pure and deterministic: no JSX, no stores, no network. The
// plan it produces is complete on its own, so the wizard finishes with no API
// key and no model call. AI only ever REORDERS and re-sizes what this chose
// (see refineWithPlan), and anything it names that is not a real, placeable
// widget on this surface is dropped. A wizard that cannot finish offline would
// be a worse default than the defaults it replaces.

import {
  HOME_WIDGET_DEFS,
  widgetDef,
  type DashboardSurface,
  type HomeWidgetDef,
  type HomeWidgetId,
  type WidgetSize
} from './homeWidgetDefs'
import { clampSize, type SizedInstance } from './homeGridLayout'

export interface WizardOption {
  id: string
  label: string
  /** Said under the label when the choice is not self-evident. */
  hint?: string
}

export interface WizardQuestion {
  id: string
  prompt: string
  /** One line under the prompt saying why it is worth answering. */
  why?: string
  options: WizardOption[]
  multi: boolean
  /** Free text is always allowed; this is its placeholder. */
  otherPlaceholder: string
}

export const WIZARD_QUESTIONS: readonly WizardQuestion[] = [
  {
    id: 'role',
    prompt: 'What does your work mostly look like?',
    why: 'This decides what earns the top of the page.',
    multi: true,
    otherPlaceholder: 'Describe your work in your own words…',
    options: [
      { id: 'delivery', label: 'Running projects', hint: 'Deadlines, dependencies, who owes what' },
      { id: 'client', label: 'Client-facing', hint: 'Calls, follow-ups, proposals' },
      { id: 'making', label: 'Making things', hint: 'Writing, designing, building' },
      { id: 'research', label: 'Research and analysis', hint: 'Reading, comparing, note-taking' },
      { id: 'ops', label: 'Keeping things running', hint: 'Requests, routine work, a queue' },
      { id: 'leading', label: 'Leading a team', hint: "Other people's work, not only your own" }
    ]
  },
  {
    id: 'pressure',
    prompt: 'What goes wrong on a bad week?',
    why: 'Your dashboard should show the thing that bites you first.',
    multi: true,
    otherPlaceholder: 'Something else that goes wrong…',
    options: [
      { id: 'dropped', label: 'Things slip through', hint: 'Forgotten, not refused' },
      { id: 'scattered', label: 'Too many places to look', hint: 'Mail, docs, chat, desks' },
      { id: 'interrupted', label: 'Never a clear run at anything' },
      { id: 'unclear', label: 'Hard to see where things stand' },
      { id: 'behind', label: 'Deadlines arrive faster than expected' }
    ]
  },
  {
    id: 'rhythm',
    prompt: 'How do you like to start the day?',
    why: 'Whether the first thing you see is a story, a list, or a timer.',
    multi: false,
    otherPlaceholder: 'Tell me how you actually start…',
    options: [
      { id: 'brief', label: 'A summary of what today holds' },
      { id: 'list', label: 'A list I can work down' },
      { id: 'focus', label: 'Straight into one thing' },
      { id: 'numbers', label: 'The numbers first' }
    ]
  },
  {
    id: 'watch',
    prompt: 'What do you want to keep half an eye on?',
    why: 'These become the small tiles down the side, not the headline.',
    multi: true,
    otherPlaceholder: 'Anything else worth watching…',
    options: [
      { id: 'tasks', label: 'What needs me' },
      { id: 'people', label: 'People and conversations' },
      { id: 'progress', label: 'Open, due and overdue counts' },
      { id: 'activity', label: 'What changed recently' },
      { id: 'health', label: 'What has gone quiet' },
      { id: 'docs', label: 'Documents I was just in' }
    ]
  },
  {
    id: 'shortcuts',
    prompt: 'Anything you want one tap away?',
    why: 'Small square buttons, not tiles — they cost almost no room.',
    multi: true,
    otherPlaceholder: 'Something else you reach for constantly…',
    options: [
      { id: 'newdesk', label: 'Start a new desk' },
      { id: 'meet', label: 'Start a meeting' },
      { id: 'record', label: 'Record and transcribe' },
      { id: 'apps', label: 'My connected apps' },
      { id: 'none', label: 'Keep it clean', hint: 'No shortcut buttons' }
    ]
  }
]

export interface WizardAnswers {
  /** questionId → chosen option ids. */
  choices: Record<string, string[]>
  /** questionId → free text, when they wrote instead of (or as well as) clicking. */
  other: Record<string, string>
}

export const EMPTY_ANSWERS: WizardAnswers = { choices: {}, other: {} }

/**
 * The widgets the wizard may place on a surface.
 *
 * Derived from the live registry rather than listed here, so the wizard can
 * never propose something that does not exist, is retired, or is not offered on
 * this dashboard. Widgets with a `config` picker (a pinned desk, a room portal,
 * one specific document) are excluded: the wizard does not know WHICH desk, and
 * placing an unconfigured one would put a broken tile on a brand-new dashboard.
 */
export function placeableFor(surface: DashboardSurface): HomeWidgetDef[] {
  return HOME_WIDGET_DEFS.filter(
    (d) => !d.retired && !d.config && (!d.surfaces || d.surfaces.includes(surface))
  )
}

export interface PlannedWidget {
  widget: HomeWidgetId
  size: WidgetSize
  /** One sentence, in their own terms, for why this is here. */
  reason: string
}

export interface DashboardPlan {
  surface: DashboardSurface
  widgets: PlannedWidget[]
}

const has = (a: WizardAnswers, q: string, id: string): boolean =>
  (a.choices[q] ?? []).includes(id)

const mentions = (text: string, ...words: string[]): boolean => words.some((w) => text.includes(w))

// A dashboard stops being readable at a glance somewhere around here: more than
// three big tiles and nothing is the headline, more than five small ones and the
// rail becomes a list you scroll instead of a row you scan.
const MAX_MAIN = 3
const MAX_RAIL = 5

/**
 * Turn answers into a plan.
 *
 * Scores rather than branches: two answers that both point at Attention should
 * make it MORE certain, not fight over one slot. The top-scoring main-column
 * widget becomes the headline and gets the largest size it supports.
 */
export function planDashboard(
  answers: WizardAnswers,
  surface: DashboardSurface = 'home'
): DashboardPlan {
  const allowed = new Map(placeableFor(surface).map((d) => [d.id, d]))
  const score = new Map<HomeWidgetId, number>()
  const why = new Map<HomeWidgetId, string>()

  const add = (id: HomeWidgetId, n: number, reason: string): void => {
    // Silently ignoring a widget that is not offered here is the point: the
    // mappings below are written once and read on four different dashboards.
    if (!allowed.has(id)) return
    score.set(id, (score.get(id) ?? 0) + n)
    // The first reason to fire is the strongest one, so it is the one kept.
    if (!why.has(id)) why.set(id, reason)
  }

  // ── How they start ────────────────────────────────────────────────────────
  if (has(answers, 'rhythm', 'brief')) add('standup', 12, 'You start with the story of the day')
  if (has(answers, 'rhythm', 'list')) add('attention', 12, 'You start from a list you can work down')
  if (has(answers, 'rhythm', 'focus')) {
    add('one-thing', 12, 'You start on one thing, so here is the one thing')
    add('focus-timer', 6, 'And a timer to protect it')
  }
  if (has(answers, 'rhythm', 'numbers')) add('pulse', 12, 'You start with the numbers')

  // ── What their work is ────────────────────────────────────────────────────
  if (has(answers, 'role', 'delivery')) {
    add('attention', 6, 'Running projects means working from what needs you')
    add('overdue', 5, 'And catching anything already past its date')
    add('pulse', 3, 'Open, due and overdue at a glance')
  }
  if (has(answers, 'role', 'client')) {
    add('agenda', 6, 'Client work turns on what today already holds')
    add('activity', 4, 'So a reply or a change does not go unnoticed')
    add('new-meeting', 3, 'A meeting is always one tap away')
  }
  if (has(answers, 'role', 'making')) {
    add('focus-timer', 6, 'Making things needs uninterrupted runs')
    add('continue', 5, 'And the document you were last inside')
    add('one-thing', 4, 'One thing at a time, not a list')
  }
  if (has(answers, 'role', 'research')) {
    add('continue', 6, 'Research lives in what you were last reading')
    add('discover', 4, 'Start from an idea and let Plexii shape it')
    add('navigator', 3, 'Everything you have gathered, browsable')
  }
  if (has(answers, 'role', 'ops')) {
    add('attention', 6, 'Routine work is a queue')
    add('overdue', 4, 'A queue is judged by what has aged')
    add('activity', 3, 'And by what just changed')
  }
  if (has(answers, 'role', 'leading')) {
    add('people-home', 7, 'Leading means seeing who is around')
    add('stalled', 5, 'And catching the desk that has gone quiet')
    add('standup', 4, 'A look back and a look forward, daily')
    add('activity', 3, "The team's trail from the last week")
  }

  // ── What goes wrong ───────────────────────────────────────────────────────
  if (has(answers, 'pressure', 'dropped')) {
    add('attention', 8, 'Things slipping is the problem you named')
    add('overdue', 6, 'Overdue radar — empty is the goal')
  }
  if (has(answers, 'pressure', 'scattered')) {
    add('standup', 6, 'One place to look, because you said there are too many')
    add('navigator', 5, 'Rooms and desks, without hunting')
    add('shortcuts', 3, 'Your own tiles to whatever you keep losing')
  }
  if (has(answers, 'pressure', 'interrupted')) {
    add('focus-timer', 8, 'You said you never get a clear run')
    add('where-was-i', 6, 'And one button back to where you were')
  }
  if (has(answers, 'pressure', 'unclear')) {
    add('pulse', 7, 'You said it is hard to see where things stand')
    add('stalled', 5, 'Starting with what has stopped moving')
    add('navigator', 3, 'And the whole shape of the workspace')
  }
  if (has(answers, 'pressure', 'behind')) {
    add('overdue', 7, 'Deadlines arriving early is a due-date problem')
    add('agenda', 5, "So today's blocks stay in sight")
  }

  // ── What they want in the corner of their eye ─────────────────────────────
  if (has(answers, 'watch', 'tasks')) add('attention', 5, 'You asked to keep an eye on what needs you')
  if (has(answers, 'watch', 'people')) {
    add('people-home', 5, 'You asked to keep an eye on people')
    add('activity', 3, 'People show up as activity')
  }
  if (has(answers, 'watch', 'progress')) add('pulse', 5, 'You asked for the counts')
  if (has(answers, 'watch', 'activity')) add('activity', 5, 'You asked to see what changed')
  if (has(answers, 'watch', 'health')) add('stalled', 5, 'You asked to see what has gone quiet')
  if (has(answers, 'watch', 'docs')) add('continue', 5, 'You asked to keep documents in reach')

  // ── One tap away ──────────────────────────────────────────────────────────
  // "Keep it clean" is an answer, not an absence of one: it suppresses the
  // buttons even when something else would have argued for them.
  const cleanRail = has(answers, 'shortcuts', 'none')
  if (has(answers, 'shortcuts', 'newdesk')) add('new-desk', 6, 'A fresh desk, one tap')
  if (has(answers, 'shortcuts', 'meet')) add('new-meeting', 6, 'Start or schedule a meeting')
  if (has(answers, 'shortcuts', 'record')) add('transcribe', 6, 'Record and transcribe on the spot')
  if (has(answers, 'shortcuts', 'apps')) add('app-launcher', 6, 'Your connected apps, with their real logos')

  // ── Free text ─────────────────────────────────────────────────────────────
  // Read for the same signals the options carry. Deliberately crude: it nudges,
  // it never outweighs a click, and a sentence it does not recognise changes
  // nothing rather than guessing.
  const wrote = Object.values(answers.other).join(' ').toLowerCase()
  if (mentions(wrote, 'deadline', 'due', 'overdue', 'chase', 'late')) add('overdue', 4, 'From what you wrote about deadlines')
  if (mentions(wrote, 'focus', 'concentrat', 'deep work', 'distract', 'interrupt')) add('focus-timer', 4, 'From what you wrote about focus')
  if (mentions(wrote, 'write', 'writing', 'draft', 'document', 'doc ')) add('continue', 4, 'From what you wrote about documents')
  if (mentions(wrote, 'report', 'metric', 'number', 'kpi', 'revenue', 'target')) add('pulse', 4, 'From what you wrote about numbers')
  if (mentions(wrote, 'team', 'staff', 'colleague', 'report to me', 'manage')) add('people-home', 4, 'From what you wrote about your team')
  if (mentions(wrote, 'client', 'customer', 'stakeholder', 'meeting', 'call')) add('agenda', 3, 'From what you wrote about meetings')
  if (mentions(wrote, 'idea', 'explore', 'research', 'learn')) add('discover', 3, 'From what you wrote about exploring')
  if (mentions(wrote, 'record', 'transcri', 'voice', 'audio')) add('transcribe', 3, 'From what you wrote about recording')

  // Someone who clicked almost nothing still gets a real dashboard rather than
  // an empty one. This is judged here, BEFORE the surface nudges below, because
  // those always score something — leaving it until after would make this
  // unreachable and quietly hand an untouched wizard a dashboard of whatever
  // the surface happened to like.
  if (score.size === 0) {
    add('standup', 3, 'A sensible start until you tell me more')
    add('attention', 2, 'A sensible start until you tell me more')
    add('agenda', 1, 'A sensible start until you tell me more')
  }

  // ── Surface ───────────────────────────────────────────────────────────────
  // The four dashboards are about different things, so each gets a nudge rather
  // than its own question set: the person answered about themselves, not about
  // which tab they happened to be on.
  if (surface === 'home') {
    add('navigator', 3, 'Your rooms and desks, where your work lives')
    add('new-desk', 1, 'A fresh desk, one tap')
  }
  if (surface === 'office') {
    add('continue', 5, 'Office is where your documents live')
    add('create', 3, 'Start a doc, sheet or deck in one tap')
  }
  if (surface === 'people') {
    add('people-home', 6, 'People opens on who is around')
    add('activity', 3, 'And what the team has been doing')
  }
  if (surface === 'brain') {
    add('discover', 5, 'Brain is where an idea becomes work')
    add('navigator', 4, 'And where you browse what the workspace knows')
    add('continue', 3, 'With what you were last reading')
  }

  // Widgets that only launch something. "Keep it clean" removes these, and
  // nothing else: the focus timer counts down, Attention lists real work, and
  // muting those because somebody declined shortcut buttons would be answering
  // a question they were not asked.
  const LAUNCHERS = new Set<HomeWidgetId>([
    'new-desk',
    'new-meeting',
    'transcribe',
    'app-launcher',
    'discover',
    'create',
    'quick',
    'shortcuts'
  ])
  if (cleanRail) for (const id of LAUNCHERS) score.delete(id)

  // Rank, then fill the two columns separately so a strong rail answer can never
  // starve the headline (or the reverse).
  const ranked = [...score.entries()].sort(
    (a, b) => b[1] - a[1] || HOME_WIDGET_DEFS.findIndex((d) => d.id === a[0]) - HOME_WIDGET_DEFS.findIndex((d) => d.id === b[0])
  )

  const main: HomeWidgetId[] = []
  const rail: HomeWidgetId[] = []
  for (const [id] of ranked) {
    const def = allowed.get(id)
    if (!def) continue
    if (def.defaultCol === 'main') {
      if (main.length < MAX_MAIN) main.push(id)
    } else if (rail.length < MAX_RAIL) rail.push(id)
  }

  const widgets: PlannedWidget[] = [
    // The headline takes the largest size it supports; the rest of the main
    // column sits one step down so the page has an obvious place to start.
    ...main.map((id, i) => ({
      widget: id,
      size: clampSize(widgetDef(id), i === 0 ? 'lg' : 'md'),
      reason: why.get(id) ?? ''
    })),
    ...rail.map((id) => ({
      widget: id,
      size: clampSize(widgetDef(id), 'sm'),
      reason: why.get(id) ?? ''
    }))
  ]

  return { surface, widgets }
}

/** True once there is enough said to build something honest from. */
export function hasEnoughToRecommend(answers: WizardAnswers): boolean {
  return (
    Object.values(answers.choices).some((v) => v.length > 0) ||
    Object.values(answers.other).some((v) => v.trim().length > 0)
  )
}

/** The plan, as the layout rows HomeDashboard actually stores. */
export function planToInstances(plan: DashboardPlan): SizedInstance[] {
  // One instance per widget, so the widget id is a stable, collision-free key —
  // the same convention the stock layouts use.
  return plan.widgets.map((w) => ({ key: w.widget, widget: w.widget, size: w.size }))
}

export interface AiPlanItem {
  widget: string
  size?: string
  reason?: string
}

/**
 * Fold a model's suggestion into a plan that already works.
 *
 * The model is allowed to reorder, resize, and drop — never to invent. Anything
 * it names that is not placeable on this surface is discarded, any size the
 * widget does not support is clamped to one it does, and a response that
 * survives none of that leaves the deterministic plan untouched. So the worst a
 * bad model call can do is nothing.
 */
export function refineWithPlan(
  plan: DashboardPlan,
  items: readonly AiPlanItem[] | null | undefined
): DashboardPlan {
  if (!Array.isArray(items) || items.length === 0) return plan

  const allowed = new Map(placeableFor(plan.surface).map((d) => [d.id, d]))
  const priorReason = new Map(plan.widgets.map((w) => [w.widget, w.reason]))
  const seen = new Set<string>()
  const widgets: PlannedWidget[] = []

  for (const item of items) {
    const def = allowed.get(item.widget as HomeWidgetId)
    if (!def || seen.has(def.id)) continue
    seen.add(def.id)
    const desired = (item.size ?? def.defaultSize) as WidgetSize
    widgets.push({
      widget: def.id,
      // clampSize is what makes an invented size harmless rather than a tile
      // that renders at a geometry its content cannot fill.
      size: clampSize(def, def.sizes.includes(desired) ? desired : def.defaultSize),
      reason: (item.reason ?? '').trim() || priorReason.get(def.id) || ''
    })
  }

  if (widgets.length === 0) return plan

  // Respect the same limits as the deterministic planner: a model asked for a
  // beautiful dashboard will happily return fourteen widgets.
  const main = widgets.filter((w) => widgetDef(w.widget).defaultCol === 'main').slice(0, MAX_MAIN)
  const rail = widgets.filter((w) => widgetDef(w.widget).defaultCol === 'rail').slice(0, MAX_RAIL)
  return { surface: plan.surface, widgets: [...main, ...rail] }
}

export const SURFACE_LABEL: Record<DashboardSurface, string> = {
  home: 'Desks',
  office: 'Office',
  people: 'People',
  brain: 'Brain'
}

/**
 * The answers as prose, for the model and for the "here is what I heard" line.
 *
 * Free text is quoted rather than paraphrased: if someone took the trouble to
 * write a sentence, that sentence is the most specific thing we know about them
 * and summarising it away is how a wizard ends up generic.
 */
export function describeAnswers(answers: WizardAnswers): string {
  const lines: string[] = []
  for (const q of WIZARD_QUESTIONS) {
    const picked = (answers.choices[q.id] ?? [])
      .map((id) => q.options.find((o) => o.id === id)?.label)
      .filter((l): l is string => !!l)
    const free = (answers.other[q.id] ?? '').trim()
    if (picked.length === 0 && free === '') continue
    const said = [...picked, ...(free ? [`in their words: "${free}"`] : [])].join('; ')
    lines.push(`${q.prompt} → ${said}`)
  }
  return lines.join('\n') || '(they skipped every question)'
}

/** The catalogue in the shape the AI pass is handed. */
export function catalogueFor(
  surface: DashboardSurface
): Array<{ id: string; name: string; blurb: string; sizes: string[]; column: 'main' | 'rail' }> {
  return placeableFor(surface).map((d) => ({
    id: d.id,
    name: d.name,
    blurb: d.blurb,
    sizes: [...d.sizes],
    column: d.defaultCol
  }))
}
