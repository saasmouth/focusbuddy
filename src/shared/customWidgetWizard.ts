// Getting from "I want a tool that…" to a widget that is actually what you meant.
//
// The blank box is the problem this solves. A custom widget is generated in one
// shot from a sentence, and a sentence leaves out exactly the things that decide
// whether the result is right: whether it remembers what you type, what it
// should work out for you, how it should read at a glance, how much room it has.
// Those omissions do not surface as questions — they surface as a widget that
// looks plausible and is not what you wanted, and then you are refining blind.
//
// So the wizard asks for them. Five questions, every one answerable by clicking,
// every one also answerable in your own words, and the answers are KEPT: editing
// the widget later reopens what you chose rather than asking you to describe the
// whole thing again from memory.
//
// Pure: no network, no model, no stores. composeSpec is deterministic, which is
// what makes "the same answers give the same brief" testable.

export interface WizardOption {
  id: string
  label: string
  hint?: string
}

export interface WizardQuestion {
  id: string
  prompt: string
  /** One line under the prompt saying why it decides something. */
  why?: string
  options: WizardOption[]
  multi: boolean
  otherPlaceholder: string
}

export const WIDGET_WIZARD_QUESTIONS: readonly WizardQuestion[] = [
  {
    id: 'kind',
    prompt: 'What kind of tool is it?',
    why: 'This decides the shape of the whole thing.',
    multi: false,
    otherPlaceholder: 'Describe the kind of tool…',
    options: [
      { id: 'tracker', label: 'A tracker', hint: 'Things with a status or a progress bar' },
      { id: 'calculator', label: 'A calculator', hint: 'Numbers in, an answer out' },
      { id: 'checklist', label: 'A checklist', hint: 'Things to tick off' },
      { id: 'log', label: 'A log', hint: 'Entries added over time' },
      { id: 'reference', label: 'A reference', hint: 'Something to look up, not fill in' },
      { id: 'timer', label: 'A timer or counter' }
    ]
  },
  {
    id: 'holds',
    prompt: 'What does it keep for you?',
    why: 'What the widget stores, as opposed to what it works out.',
    multi: true,
    otherPlaceholder: 'Something else it holds…',
    options: [
      { id: 'items', label: 'A list of items' },
      { id: 'numbers', label: 'Numbers I type in' },
      { id: 'dates', label: 'Dates' },
      { id: 'notes', label: 'Notes or text' },
      { id: 'nothing', label: 'Nothing', hint: 'It works from what I give it each time' }
    ]
  },
  {
    id: 'does',
    prompt: 'What should it work out for you?',
    why: 'The part you would otherwise do in your head.',
    multi: true,
    otherPlaceholder: 'Something else it should work out…',
    options: [
      { id: 'total', label: 'A total or a calculation' },
      { id: 'progress', label: 'Progress towards a target' },
      { id: 'due', label: 'What is due or overdue' },
      { id: 'sort', label: 'Sort or filter what I put in' },
      { id: 'chart', label: 'A simple chart' },
      { id: 'nothing', label: 'Nothing', hint: 'Just show it back to me clearly' }
    ]
  },
  {
    id: 'reads',
    prompt: 'Should it read something else on this desk?',
    why: 'It sees only what you point it at — a wire on the canvas, or an @ mention.',
    multi: true,
    otherPlaceholder: 'Something else it should read…',
    options: [
      { id: 'table', label: 'A table', hint: 'It gets the real rows and columns' },
      { id: 'notes', label: 'Notes or documents' },
      { id: 'mention', label: 'Something elsewhere', hint: '@ mention it below — any desk, doc or file' },
      { id: 'none', label: 'No', hint: 'It works from what I type into it' }
    ]
  },
  {
    id: 'acts',
    prompt: 'Should it be able to change things?',
    why: 'It can only change what is wired into it, and asks first until you say otherwise.',
    multi: true,
    otherPlaceholder: 'Something else it should be able to do…',
    options: [
      { id: 'none', label: 'No — just show me', hint: 'The safe default' },
      { id: 'rows', label: 'Add rows to the table it reads' },
      { id: 'cells', label: 'Update cells in that table' },
      { id: 'brain', label: 'Save notes to PlexiBrain' },
      { id: 'links', label: 'Open a link' }
    ]
  },
  {
    id: 'look',
    prompt: 'How should it read at a glance?',
    why: 'A desk widget is small — this decides what gets the space.',
    multi: false,
    otherPlaceholder: 'Describe how it should look…',
    options: [
      { id: 'list', label: 'A compact list' },
      { id: 'number', label: 'One big number' },
      { id: 'table', label: 'A small table' },
      { id: 'cards', label: 'Cards' },
      { id: 'chart', label: 'A chart' },
      { id: 'form', label: 'A form to fill in' }
    ]
  },
  {
    id: 'memory',
    prompt: 'Should it remember what you put in?',
    why: 'The single most common reason a generated widget disappoints.',
    multi: false,
    otherPlaceholder: 'Something more specific about what it keeps…',
    options: [
      { id: 'remember', label: 'Yes — keep it between sessions' },
      { id: 'fresh', label: 'No — start fresh each time' }
    ]
  }
]

export interface WidgetWizardAnswers {
  /** questionId → chosen option ids. */
  choices: Record<string, string[]>
  /** questionId → free text. */
  other: Record<string, string>
}

export const EMPTY_WIDGET_ANSWERS: WidgetWizardAnswers = { choices: {}, other: {} }

const picked = (a: WidgetWizardAnswers, q: string): string[] => a.choices[q] ?? []
const wrote = (a: WidgetWizardAnswers, q: string): string => (a.other[q] ?? '').trim()

const labelsFor = (a: WidgetWizardAnswers, qid: string): string[] => {
  const q = WIDGET_WIZARD_QUESTIONS.find((x) => x.id === qid)
  if (!q) return []
  return picked(a, qid)
    .map((id) => q.options.find((o) => o.id === id)?.label)
    .filter((l): l is string => !!l)
}

/** True once the person has said anything at all. */
export function answersSaySomething(a: WidgetWizardAnswers): boolean {
  return (
    Object.values(a.choices).some((v) => v.length > 0) ||
    Object.values(a.other).some((v) => v.trim().length > 0)
  )
}

/** A short human summary — what the widget is, in the person's own choices. */
export function describeAnswers(a: WidgetWizardAnswers): string {
  const parts: string[] = []
  for (const q of WIDGET_WIZARD_QUESTIONS) {
    const chosen = labelsFor(a, q.id)
    const free = wrote(a, q.id)
    const all = [...chosen, ...(free ? [`“${free}”`] : [])]
    if (all.length > 0) parts.push(all.join(', '))
  }
  return parts.join(' · ')
}

export interface ComposeContext {
  /** The space the widget will actually occupy on the desk. */
  width?: number
  height?: number
  /** Whether the widget is allowed to reach the network. */
  net?: boolean
}

/**
 * Turn the answers into the brief the generator is given.
 *
 * Written as instructions rather than as a description, because the generator
 * writes a document from this and a description leaves it guessing. The two
 * blocks at the end are the ones that stop a generated widget from being a
 * convincing lie: it must start EMPTY, and it must never invent sample rows to
 * look finished.
 */
export function composeSpec(a: WidgetWizardAnswers, ctx: ComposeContext = {}): string {
  const lines: string[] = []

  const kind = labelsFor(a, 'kind')[0] ?? wrote(a, 'kind')
  if (kind) lines.push(`WHAT IT IS: ${kind.toLowerCase()}.`)

  const holds = [...labelsFor(a, 'holds'), wrote(a, 'holds')].filter(Boolean)
  if (holds.length > 0) {
    lines.push(
      picked(a, 'holds').includes('nothing') && holds.length === 1
        ? 'IT KEEPS: nothing — it works from what is given each time.'
        : `IT KEEPS: ${holds.join('; ').toLowerCase()}.`
    )
  }

  const does = [...labelsFor(a, 'does'), wrote(a, 'does')].filter(Boolean)
  if (does.length > 0) {
    lines.push(
      picked(a, 'does').includes('nothing') && does.length === 1
        ? 'IT WORKS OUT: nothing — it presents what is entered, clearly.'
        : `IT WORKS OUT: ${does.join('; ').toLowerCase()}.`
    )
  }

  const look = labelsFor(a, 'look')[0] ?? wrote(a, 'look')
  if (look) lines.push(`AT A GLANCE IT READS AS: ${look.toLowerCase()}.`)

  // Memory is stated even when not answered, because the generator has to choose
  // one and a silent choice is the thing that disappoints people.
  const remembers = picked(a, 'memory').includes('remember')
  const fresh = picked(a, 'memory').includes('fresh')
  if (remembers) {
    lines.push(
      'MEMORY: it MUST keep what the user enters between sessions, using plexi.setState() ' +
        'to save and plexi.getState() to restore on load.'
    )
  } else if (fresh) {
    lines.push('MEMORY: it starts fresh every time. Do not persist anything.')
  }
  const memoryNote = wrote(a, 'memory')
  if (memoryNote) lines.push(`ALSO ABOUT WHAT IT KEEPS: ${memoryNote}`)

  const kindNote = wrote(a, 'kind')
  if (kindNote && kindNote !== kind) lines.push(`IN THEIR WORDS: ${kindNote}`)

  // Reading and acting are stated as API instructions, because "it should read
  // the table" tells a generator nothing it can write code against.
  const reads = picked(a, 'reads')
  const readsSomething = reads.some((r) => r !== 'none') || wrote(a, 'reads') !== ''
  if (readsSomething) {
    const bits = [...labelsFor(a, 'reads').filter((l) => !/^No\b/.test(l)), wrote(a, 'reads')].filter(Boolean)
    lines.push(
      `IT READS: ${bits.join('; ').toLowerCase()}, through plexi.getInputs(). ` +
        'Render from those inputs, and subscribe with plexi.onInput(fn) so it updates ' +
        'when the source changes. A wired table arrives as {table:{columns,rows}} with ' +
        'cells keyed by COLUMN ID — compute over the rows, do not parse text. ' +
        'Inputs arrive from a wire the user drew OR from anything they @ mentioned in ' +
        'this description — both look the same and each carries via:"wire"|"mention". ' +
        'The list is EMPTY until they do one: say so in the empty state.'
    )
  } else if (reads.includes('none')) {
    lines.push('IT READS: nothing wired in — it works only from what the user enters.')
  }

  const acts = picked(a, 'acts').filter((x) => x !== 'none')
  const actNote = wrote(a, 'acts')
  if (acts.length > 0 || actNote) {
    const verbs: string[] = []
    if (acts.includes('rows')) verbs.push('{kind:"add-table-row", tableId, cells}')
    if (acts.includes('cells')) verbs.push('{kind:"set-cell", tableId, rowId, cells}')
    if (acts.includes('brain')) verbs.push('{kind:"create-knowledge-entry", title, body}')
    if (acts.includes('links')) verbs.push('{kind:"open-url", url}')
    lines.push(
      `IT ACTS: await plexi.act(...) with ${verbs.join(' or ') || 'the allowed actions'}. ` +
        'tableId and rowId MUST come from plexi.getInputs(). ALWAYS check the result and show ' +
        'the reason on failure — the user may not have granted write access, in which case ' +
        'each action is put to them for approval and can be declined.' +
        (actNote ? ` Also: ${actNote}` : '')
    )
  } else if (picked(a, 'acts').includes('none')) {
    lines.push('IT ACTS: not at all. Do not call plexi.act().')
  }

  if (ctx.width && ctx.height) {
    lines.push(
      `SPACE: it must be readable at ${Math.round(ctx.width)}×${Math.round(ctx.height)} pixels. ` +
        'Design for that, not for a full page. Scroll inside the widget rather than overflowing it.'
    )
  }
  lines.push(
    ctx.net
      ? 'NETWORK: allowed. Fail visibly and honestly when a request does not come back.'
      : 'NETWORK: NOT available. Do not use fetch, XHR, websockets or external assets.'
  )

  // The no-fakery clauses. A generated widget that ships with invented rows
  // looks finished and is lying about having data.
  lines.push(
    'START EMPTY: ship with NO sample rows, no placeholder numbers and no invented ' +
      'entries. Show an honest empty state that says what to add first.'
  )
  lines.push(
    'HONESTY: never display a total, a count or a chart derived from data that is not ' +
      'there. Zero and "nothing yet" are correct answers; a plausible-looking fake is not.'
  )

  return lines.join('\n')
}

/**
 * The brief for CHANGING an existing widget.
 *
 * Refining used to be a free-text prompt with no reference to what the widget
 * already is, so the model was asked to change something it could only infer
 * from its own code. Stating the before and the after makes the change a diff
 * rather than a re-guess.
 */
export function composeEditSpec(
  before: WidgetWizardAnswers,
  after: WidgetWizardAnswers,
  ctx: ComposeContext = {}
): string {
  const changes: string[] = []
  for (const q of WIDGET_WIZARD_QUESTIONS) {
    const b = [...labelsFor(before, q.id), wrote(before, q.id)].filter(Boolean).join(', ')
    const a = [...labelsFor(after, q.id), wrote(after, q.id)].filter(Boolean).join(', ')
    if (b !== a) {
      changes.push(`- ${q.prompt} was ${b || '(not said)'} → now ${a || '(not said)'}`)
    }
  }
  const head =
    changes.length > 0
      ? `CHANGE THE EXISTING WIDGET. What is different:\n${changes.join('\n')}\n\n` +
        'Keep everything else as it is, including anything the user has already entered.\n\n'
      : 'REBUILD THE EXISTING WIDGET to the brief below, keeping anything the user has already entered.\n\n'
  return head + composeSpec(after, ctx)
}
