// Structured output from the on-device model, made reliable in layers.
//
// The app's JSON-returning calls each have their OWN contract, and several
// share a routing purpose: 'setup' covers Build with AI ({suggestions}), the
// in-table AI ({columnsToAdd, rows}), agent profiles ({name, blurb,
// systemPrompt}) and work-widget setup ({summary, refId} / {items}); 'chat'
// covers the PlexiiAssist envelope ({reply, actions}), PlexiiBrain answers
// ({answer, sources}) and workspace actions ({actions}). Validating by
// purpose rejected correct replies — 4.3.39-local.3's "the object must have a
// "suggestions" array" on a table's rows, then "AI returned no rows" once the
// retry had pushed the model toward the wrong contract.
//
// So each contract is recognised from the call's own instructions (the shape
// the call site's prompt tells the model to return), never from the purpose
// alone, and:
//   1. tolerant parsing: fences and prose stripped, the first BALANCED JSON
//      value taken, trailing commas repaired;
//   2. normalisation to the contract's top level where the intent is
//      unambiguous (a bare array of cards → {suggestions}, of rows → {rows};
//      obvious alternative keys); nothing is ever invented or filled in;
//   3. strict validation against the contract (a table reply with no rows
//      when rows were asked for is a failure, not an empty success);
//   4. a permissive JSON schema per contract (structure only — required keys
//      and types, no length caps) for constrained decoding when it is on.
// The caller (localClient.runLocal) retries once with the contract's own
// error, then the router makes the honest cloud offer, and if that is
// declined the request fails plainly — never "ok" with nothing in it.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export interface Contract {
  id: string
  /** What the person was promised, for an honest failure message. */
  describe: string
  /** Does this call's prompt ask for this contract? */
  match: (purpose: string, system: string) => boolean
  /** Bring an unambiguous near-miss to the contract's top level. Never invents content. */
  normalize?: (v: unknown) => unknown
  /** Strictly validate; an error phrased for the model's retry, or null. */
  validate: (v: unknown) => string | null
  /** Structure-only JSON schema for constrained decoding. */
  schema?: Obj
}

const ANY_OBJECT = { type: 'object', additionalProperties: true }
const arrayOf = (items: unknown, minItems = 0): Obj => ({ type: 'array', items, ...(minItems ? { minItems } : {}) })

/** Move the first present alternative key to `to` (an array value only). */
function renameArrayKey(v: Obj, to: string, alternatives: string[]): Obj {
  if (Array.isArray(v[to])) return v
  for (const k of alternatives) if (Array.isArray(v[k])) {
    const { [k]: arr, ...rest } = v
    return { ...rest, [to]: arr }
  }
  return v
}

const looksLikeCard = (x: unknown): boolean => isObj(x) && typeof x.kind === 'string'

export const CONTRACTS: Contract[] = [
  {
    id: 'table-rows',
    describe: 'rows (and any new columns) for this table',
    match: (_p, s) => /"columnsToAdd"/.test(s) && /"rows"/.test(s),
    normalize: (v) => {
      if (Array.isArray(v) && v.every(isObj)) return { rows: v }
      if (!isObj(v)) return v
      let o = renameArrayKey(v, 'rows', ['data', 'items', 'records', 'entries'])
      // "columns" holding column definitions is columnsToAdd under another name.
      if (!Array.isArray(o.columnsToAdd) && Array.isArray(o.columns) && o.columns.every((c) => isObj(c) && typeof c.label === 'string')) {
        const { columns, ...rest } = o
        o = { ...rest, columnsToAdd: columns }
      }
      return o
    },
    validate: (v) => {
      if (!isObj(v)) return 'reply with a JSON object { "columnsToAdd": [...], "rows": [...] }'
      if (!Array.isArray(v.rows)) return 'the object must have a "rows" array (one object per row, keyed by column label)'
      if (v.rows.length === 0) return '"rows" is empty: generate the rows the prompt asks for'
      if (!v.rows.every(isObj)) return 'every entry in "rows" must be an object keyed by column label'
      if (v.rows.every((r) => Object.keys(r as Obj).length === 0)) return 'the rows have no cells: fill in each row'
      if (v.columnsToAdd !== undefined) {
        if (!Array.isArray(v.columnsToAdd)) return '"columnsToAdd" must be an array'
        for (const c of v.columnsToAdd) {
          if (!isObj(c) || typeof c.label !== 'string' || typeof c.type !== 'string') return 'every "columnsToAdd" entry needs a string "label" and "type"'
        }
      }
      return null
    },
    schema: {
      type: 'object',
      properties: {
        columnsToAdd: arrayOf({ type: 'object', properties: { label: { type: 'string' }, type: { type: 'string' } }, additionalProperties: true }),
        rows: arrayOf(ANY_OBJECT, 1)
      }
    }
  },
  {
    id: 'build-suggestions',
    describe: 'suggestion cards for Build with AI',
    match: (p, s) => p === 'setup' && /"suggestions"/.test(s),
    normalize: (v) => {
      if (Array.isArray(v) && v.length > 0 && v.every(looksLikeCard)) return { suggestions: v }
      if (looksLikeCard(v) && !Array.isArray((v as Obj).suggestions)) return { suggestions: [v] }
      if (isObj(v)) return renameArrayKey(v, 'suggestions', ['items', 'cards', 'widgets'])
      return v
    },
    validate: (v) => {
      if (!isObj(v) || !Array.isArray(v.suggestions)) return 'the object must have a "suggestions" array'
      if (v.suggestions.length === 0) return '"suggestions" must not be empty'
      for (const s of v.suggestions) {
        if (!isObj(s) || typeof s.kind !== 'string') return 'every suggestion needs a "kind"'
        if (s.kind === 'table') {
          const cols = isObj(s.tableSchema) ? s.tableSchema.columns : undefined
          if (!Array.isArray(cols) || cols.length === 0) return `table "${String(s.title ?? '')}" has no tableSchema.columns`
        }
        if (s.kind === 'page' && !(isObj(s.pageContent) && Array.isArray(s.pageContent.content))) {
          return `page "${String(s.title ?? '')}" has no pageContent document`
        }
      }
      return null
    },
    schema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        suggestions: arrayOf({ type: 'object', properties: { kind: { type: 'string' } }, additionalProperties: true }, 1)
      },
      additionalProperties: true
    }
  },
  {
    id: 'agent-profile',
    describe: 'an agent profile',
    match: (_p, s) => /"systemPrompt"/.test(s) && /"blurb"/.test(s),
    validate: (v) =>
      isObj(v) && typeof v.name === 'string' && typeof v.blurb === 'string' && typeof v.systemPrompt === 'string' && v.name.trim() && v.systemPrompt.trim()
        ? null
        : 'reply with a JSON object with non-empty string "name", "blurb" and "systemPrompt"',
    schema: { type: 'object', properties: { name: { type: 'string' }, blurb: { type: 'string' }, systemPrompt: { type: 'string' } } }
  },
  {
    id: 'widget-ref',
    describe: 'what this work widget should show',
    match: (_p, s) => /"refId"/.test(s) && /"summary"/.test(s),
    validate: (v) =>
      isObj(v) && typeof v.summary === 'string' && (typeof v.refId === 'string' || v.refId === null)
        ? null
        : 'reply with a JSON object { "summary": "...", "refId": "<one of the listed ids>" }',
    schema: { type: 'object', properties: { summary: { type: 'string' }, refId: { type: ['string', 'null'] } } }
  },
  {
    id: 'widget-items',
    describe: 'items for this work widget',
    match: (_p, s) => /\{\s*"items"\s*:\s*\[/.test(s) && !/"suggestions"/.test(s),
    normalize: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? { items: v } : v),
    validate: (v) => {
      if (!isObj(v) || !Array.isArray(v.items)) return 'reply with a JSON object { "items": ["...", "..."] }'
      if (v.items.length === 0) return '"items" is empty: propose the items'
      return null
    },
    schema: { type: 'object', properties: { items: arrayOf({ type: 'string' }, 1) } }
  },
  {
    id: 'brain-answer',
    describe: 'an answer from your documents',
    match: (p, s) => p === 'chat' && /"answer"\s*:/.test(s) && /"sources"\s*:/.test(s),
    validate: (v) => (isObj(v) && typeof v.answer === 'string' ? null : 'the object must have a string "answer"'),
    schema: { type: 'object', properties: { answer: { type: 'string' }, sources: arrayOf({ type: 'integer' }) } }
  },
  {
    id: 'chat-envelope',
    describe: 'a reply',
    match: (p, s) => (p === 'chat' || p === 'welcome') && /"reply"/.test(s),
    validate: (v) => {
      if (!isObj(v) || typeof v.reply !== 'string') return 'the object must have a string "reply" field and an "actions" array'
      if (v.actions !== undefined && !Array.isArray(v.actions)) return '"actions" must be an array'
      return null
    }
  },
  {
    id: 'workspace-actions',
    describe: 'suggested actions',
    match: (_p, s) => /\{\s*"actions"\s*:\s*\[/.test(s) && !/"reply"/.test(s),
    normalize: (v) => (Array.isArray(v) && v.every(looksLikeCard) ? { actions: v } : v),
    validate: (v) => (isObj(v) && Array.isArray(v.actions) ? null : 'reply with a JSON object { "actions": [ ... ] }'),
    schema: { type: 'object', properties: { actions: arrayOf(ANY_OBJECT) } }
  },
  {
    id: 'title-backfill',
    describe: 'titles',
    match: (p) => p === 'title_backfill',
    validate: (v) => (isObj(v) && Array.isArray(v.titles) ? null : 'the object must have a "titles" array'),
    schema: { type: 'object', properties: { titles: arrayOf({ type: 'object', properties: { i: { type: 'integer' }, title: { type: 'string' } } }) } }
  },
  {
    id: 'enrichment',
    describe: 'a document description',
    match: (p) => p === 'enrichment',
    validate: (v) => (isObj(v) && typeof v.summary === 'string' ? null : 'the object must have a string "summary"'),
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        category: { type: 'string' },
        entities: arrayOf({ type: 'string' }),
        dates: arrayOf({ type: 'string' }),
        keywords: arrayOf({ type: 'string' }),
        language: { type: 'string' }
      }
    }
  }
]

/** The contract this call asks for, or null (then only "valid JSON of the demanded shape" is checked). */
export function contractFor(purpose: string, system: string): Contract | null {
  return CONTRACTS.find((c) => c.match(purpose, system)) ?? null
}

/**
 * The first balanced JSON value in model text: fences and surrounding prose
 * ignored, strings and escapes respected. `cutOff` when it opens and never
 * closes (truncated output).
 */
export function firstJsonValue(text: string): { raw: string } | { cutOff: true } | null {
  let s = text
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence && /[[{]/.test(fence[1])) s = fence[1]
  const start = s.search(/[[{]/)
  if (start < 0) return null
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null
      if (stack.length === 0) return { raw: s.slice(start, i + 1) }
    }
  }
  return { cutOff: true }
}

/** Remove trailing commas before } or ] (outside strings). */
export function stripTrailingCommas(raw: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      out += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j])) j++
      if (raw[j] === '}' || raw[j] === ']') continue
    }
    out += ch
  }
  return out
}

/**
 * A cut-off JSON reply, closed at its last COMPLETE element: everything up to
 * the last whole top-level field or whole array entry is kept, the half-written
 * remainder is dropped, and the open brackets are closed. Never closes a
 * half-written string or object, so text that was cut mid-sentence is never
 * passed off as finished. Null when nothing whole can be kept. Exported for tests.
 *
 * Cut points are only allowed directly inside the top-level value, or between
 * the entries of an array that sits directly inside it ({ reply, actions: [] },
 * { rows: [] }, { suggestions: [] }): deeper, an entry would be kept half-made.
 */
export function closeTruncated(text: string): string | null {
  let s = text
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*)$/)
  if (fence && /[[{]/.test(fence[1])) s = fence[1].replace(/```[\s\S]*$/, '')
  const start = s.search(/[[{]/)
  if (start < 0) return null
  const stack: string[] = []
  let inStr = false
  let esc = false
  let best: { at: number; closers: string } | null = null
  const allowed = (): boolean => stack.length === 1 || (stack.length === 2 && stack[1] === ']')
  const mark = (at: number): void => {
    if (allowed()) best = { at, closers: [...stack].reverse().join('') }
  }
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null
      if (stack.length === 0) return null // it closed: not truncated, nothing to repair
      mark(i + 1)
    } else if (ch === ',') mark(i)
  }
  if (!best) return null
  const b = best as { at: number; closers: string }
  return s.slice(start, b.at) + b.closers
}

export type StructuredResult =
  | { ok: true; value: unknown; text: string; changed: boolean; contract: Contract | null; repairs: string[] }
  | { ok: false; problem: string; contract: Contract | null; cutOff: boolean }

/**
 * Parse a model reply for a call that demands JSON of `shape`: tolerant
 * extraction, repair, normalisation to the call's contract, strict validation.
 * On success `text` is the JSON the call site should parse (the original text
 * when nothing needed changing).
 */
export function parseStructured(text: string, shape: 'object' | 'array', purpose: string, system: string): StructuredResult {
  const contract = contractFor(purpose, system)
  const repairs: string[] = []
  const found = firstJsonValue(text)
  if (!found) return { ok: false, problem: `no JSON ${shape} was found`, contract, cutOff: false }
  if ('cutOff' in found) return { ok: false, problem: 'the JSON was cut off before it closed; reply with a complete, shorter JSON', contract, cutOff: true }
  let raw = found.raw
  if (raw.length !== text.trim().length) repairs.push('extracted')
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    const fixed = stripTrailingCommas(raw)
    try {
      v = JSON.parse(fixed)
      raw = fixed
      repairs.push('trailing-commas')
    } catch (e) {
      return { ok: false, problem: `the JSON did not parse (${(e as Error).message})`, contract, cutOff: false }
    }
  }
  if (contract?.normalize) {
    const n = contract.normalize(v)
    if (n !== v) {
      v = n
      repairs.push('normalized')
    }
  }
  if (!contract && (shape === 'array' ? !Array.isArray(v) : !isObj(v))) {
    return { ok: false, problem: `the output must be a JSON ${shape}`, contract, cutOff: false }
  }
  const problem = contract ? contract.validate(v) : null
  if (problem) return { ok: false, problem, contract, cutOff: false }
  const changed = repairs.length > 0
  return { ok: true, value: v, text: changed ? JSON.stringify(v) : text, changed, contract, repairs }
}

/**
 * The last resort for a reply that was cut off and could not be retried in
 * full (the on-device model ran out of room): close it at its last complete
 * element and accept it only if THE CALL'S contract still holds. A reply whose
 * main field was itself cut off fails here, honestly.
 */
export function salvageTruncated(text: string, shape: 'object' | 'array', purpose: string, system: string): StructuredResult | null {
  const closed = closeTruncated(text)
  if (!closed) return null
  const r = parseStructured(closed, shape, purpose, system)
  if (!r.ok) return null
  return { ...r, text: r.changed ? r.text : closed, changed: true, repairs: [...r.repairs, 'closed-truncated'] }
}
