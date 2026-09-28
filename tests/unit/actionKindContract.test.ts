import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ACTION_KINDS_CATALOG, parseChatJson } from '../../src/main/ai/anthropic'

// An action kind has to be agreed in three places or it silently does nothing:
//
//   1. the ActionProposal union in src/shared/types.ts   — what a proposal IS
//   2. ACTION_KINDS_CATALOG in src/main/ai/anthropic.ts  — what the model is TOLD it may emit
//   3. the switch in parseChatJson                        — what a reply can be READ as
//
// Miss (3) and the failure is invisible in the worst way. The model is told the
// kind exists, so it emits it; the parser has no case, so the action is counted
// as `dropped` and thrown away; the reply text has already promised the work.
// The user reads "I've opened that for you" and no card ever appears to accept.
//
// That is not hypothetical. Every one of these shipped in exactly that state,
// each with a working applier in the renderer waiting for input that could not
// reach it: create-document, drill-in-widget, focus-widget, navigate-to (all
// four advertised to the model), plus add-subtask, arrange-widgets,
// create-section and toggle-todo-item (built and reachable from nowhere).
//
// ACTION_KINDS_CATALOG already carries a comment promising it is "shared
// verbatim by the chat prompt and the agent-loop prompt so a newly-added
// ActionProposal kind can never be documented to one brain and not the other".
// It guarded prompt-against-prompt and nothing guarded prompt-against-parser,
// which is the gap that actually bit. This test is that guard.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

/** Text between a starting line and the next top-level declaration after it. */
function sliceFrom(src: string, startRe: RegExp, endRe: RegExp): string {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => startRe.test(l))
  if (start < 0) throw new Error(`contract test could not locate ${String(startRe)}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const TYPES = read('src/shared/types.ts')
const ANTHROPIC = read('src/main/ai/anthropic.ts')

/** Every `kind:` literal in the ActionProposal union. */
const unionKinds = (): Set<string> => {
  const body = sliceFrom(TYPES, /^export type ActionProposal/, /^export (type|interface|const) /)
  return new Set([...body.matchAll(/kind: '([a-z0-9-]+)'/g)].map((m) => m[1]))
}

/** Every `case '...'` the chat parser can actually read. */
const parserKinds = (): Set<string> => {
  const body = sliceFrom(ANTHROPIC, /^export function parseChatJson/, /^export (function|const) /)
  return new Set([...body.matchAll(/case '([a-z0-9-]+)'/g)].map((m) => m[1]))
}

/** Every kind the model is told it may emit. */
const catalogKinds = (): Set<string> =>
  new Set([...ACTION_KINDS_CATALOG.matchAll(/"kind": *"([a-z0-9-]+)"/g)].map((m) => m[1]))

// Kinds deliberately NOT readable from a chat reply. Each needs a reason, because
// the default has to be that a kind the union defines is a kind chat can offer —
// otherwise this list becomes the place broken wiring hides.
//
// create-work-item is the Attention layer's reserved verb: it is parsed on every
// path and executes nowhere until the work-items capability ships, and it is
// injected into prompts conditionally by vocabulary.ts rather than living in the
// shared catalogue. It is therefore parseable but intentionally absent from
// ACTION_KINDS_CATALOG.
const NOT_IN_CATALOG = new Set(['create-work-item'])

// Nothing belongs here today. Kept so that a future genuinely-internal kind has
// somewhere honest to go, with its reason written down, instead of being dropped
// on the floor like the eight above were.
const NOT_READABLE_FROM_CHAT = new Set<string>([])

describe('action kinds agree across type, prompt and parser', () => {
  it('every kind the model is told to emit can be parsed', () => {
    const parser = parserKinds()
    const unreadable = [...catalogKinds()].filter((k) => !parser.has(k)).sort()
    // A kind in this list is advertised to the model and thrown away when it
    // arrives — the reply promises the action and no card is ever offered.
    expect(unreadable).toEqual([])
  })

  it('every kind the model is told to emit is a real proposal shape', () => {
    const union = unionKinds()
    const unknown = [...catalogKinds()].filter((k) => !union.has(k)).sort()
    expect(unknown).toEqual([])
  })

  it('every proposal kind is readable from a chat reply', () => {
    const parser = parserKinds()
    const orphaned = [...unionKinds()]
      .filter((k) => !parser.has(k) && !NOT_READABLE_FROM_CHAT.has(k))
      .sort()
    // A kind here is defined, usually has a working applier, and cannot be
    // reached by asking Plexii for it.
    expect(orphaned).toEqual([])
  })

  it('every parseable kind is advertised, so it is not dead weight', () => {
    const catalog = catalogKinds()
    const unadvertised = [...parserKinds()]
      .filter((k) => !catalog.has(k) && !NOT_IN_CATALOG.has(k))
      .sort()
    // A kind here can be parsed but the model is never told it exists, so it
    // will never be emitted — the capability is built and unreachable.
    expect(unadvertised).toEqual([])
  })

  it('the three sets are non-trivial, so a broken slice cannot pass vacuously', () => {
    // Every assertion above is "nothing is missing", which an empty set would
    // satisfy. If a refactor moves the union or renames parseChatJson, the
    // regexes would quietly match nothing and this file would go green while
    // testing air.
    expect(unionKinds().size).toBeGreaterThan(25)
    expect(parserKinds().size).toBeGreaterThan(25)
    expect(catalogKinds().size).toBeGreaterThan(20)
  })
})

// The static checks above prove a case EXISTS. These prove it reads the fields
// the catalogue promises, which is the part a `case` label cannot tell you.
describe('the newly reachable kinds parse into usable proposals', () => {
  const parse = (action: Record<string, unknown>): Record<string, unknown> | undefined => {
    const out = parseChatJson(JSON.stringify({ reply: 'ok', actions: [action] }))
    expect(out).not.toBeNull()
    expect(out?.dropped).toBe(0)
    return out?.proposals[0] as unknown as Record<string, unknown> | undefined
  }

  it('navigate-to keeps its target and id', () => {
    const p = parse({
      kind: 'navigate-to',
      target: 'documents',
      targetId: 'doc-7',
      label: 'Documents',
      reason: 'you asked to go there'
    })
    expect(p).toMatchObject({ kind: 'navigate-to', target: 'documents', targetId: 'doc-7', label: 'Documents' })
  })

  it('navigate-to is refused when the target is not a real place', () => {
    const out = parseChatJson(
      JSON.stringify({ reply: 'ok', actions: [{ kind: 'navigate-to', target: 'nowhere', label: 'X' }] })
    )
    // Better to drop it and say so than to offer a card that goes nowhere.
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('drill-in-widget and focus-widget keep the widget they name', () => {
    expect(parse({ kind: 'drill-in-widget', widgetId: 'w1', label: 'Email sequences' })).toMatchObject({
      kind: 'drill-in-widget',
      widgetId: 'w1',
      label: 'Email sequences'
    })
    expect(parse({ kind: 'focus-widget', widgetId: 'w2', label: 'Budget' })).toMatchObject({
      kind: 'focus-widget',
      widgetId: 'w2',
      label: 'Budget'
    })
  })

  it('a widget action with no widgetId is dropped rather than offered', () => {
    const out = parseChatJson(
      JSON.stringify({ reply: 'ok', actions: [{ kind: 'focus-widget', label: 'nothing in particular' }] })
    )
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('create-document keeps its docType', () => {
    expect(parse({ kind: 'create-document', docType: 'sheet', title: 'Q3 budget' })).toMatchObject({
      kind: 'create-document',
      docType: 'sheet',
      title: 'Q3 budget'
    })
  })

  it('create-document rejects a docType that is not an office surface', () => {
    const out = parseChatJson(
      JSON.stringify({ reply: 'ok', actions: [{ kind: 'create-document', docType: 'podcast', title: 'X' }] })
    )
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('toggle-todo-item carries the line to flip and the state to flip it to', () => {
    expect(
      parse({
        kind: 'toggle-todo-item',
        widgetId: 'w3',
        widgetLabel: 'Launch checklist',
        itemMatch: 'Record pilot',
        checked: true
      })
    ).toMatchObject({
      kind: 'toggle-todo-item',
      widgetId: 'w3',
      widgetLabel: 'Launch checklist',
      itemMatch: 'Record pilot',
      checked: true
    })
  })

  it('toggle-todo-item needs something to match, or it would flip an arbitrary line', () => {
    const out = parseChatJson(
      JSON.stringify({
        reply: 'ok',
        actions: [{ kind: 'toggle-todo-item', widgetId: 'w3', widgetLabel: 'L', itemMatch: '', checked: true }]
      })
    )
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })

  it('add-subtask keeps its optional parent and due date', () => {
    expect(
      parse({ kind: 'add-subtask', title: 'Call the vendor', parentId: 'task-2', dueDate: 1790000000000 })
    ).toMatchObject({ kind: 'add-subtask', title: 'Call the vendor', parentId: 'task-2', dueDate: 1790000000000 })
  })

  it('arrange-widgets works with or without an explicit set', () => {
    expect(parse({ kind: 'arrange-widgets', label: 'Tidy up' })).toMatchObject({
      kind: 'arrange-widgets',
      label: 'Tidy up'
    })
    expect(parse({ kind: 'arrange-widgets', widgetIds: ['a', 'b'], label: 'Tidy these' })).toMatchObject({
      kind: 'arrange-widgets',
      widgetIds: ['a', 'b']
    })
  })

  it('create-section needs the widgets it is grouping', () => {
    expect(parse({ kind: 'create-section', name: 'Research', widgetIds: ['a', 'b'] })).toMatchObject({
      kind: 'create-section',
      name: 'Research',
      widgetIds: ['a', 'b']
    })
    const out = parseChatJson(
      JSON.stringify({ reply: 'ok', actions: [{ kind: 'create-section', name: 'Empty', widgetIds: [] }] })
    )
    expect(out?.proposals).toHaveLength(0)
    expect(out?.dropped).toBe(1)
  })
})
