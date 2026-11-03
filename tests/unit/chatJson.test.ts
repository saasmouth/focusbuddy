import { describe, it, expect } from 'vitest'
import { extractJson, salvageEnvelope } from '../../src/main/ai/chatJson'

describe('extractJson', () => {
  it('returns the object slice for a well-formed envelope', () => {
    const s = '{"reply":"hi","actions":[]}'
    expect(extractJson(s)).toBe(s)
  })

  it('unwraps a markdown json fence', () => {
    const s = '```json\n{"reply":"hi","actions":[]}\n```'
    expect(extractJson(s)).toBe('{"reply":"hi","actions":[]}')
  })

  it('returns null when the closing brace is missing (truncated)', () => {
    // No closing brace at all — the old code path that produced the raw-JSON dump.
    expect(extractJson('{"reply":"hi","actions":[{"kind":"create-todo-list"')).toBeNull()
  })

  // A desk build writes markdown INSIDE its JSON, and markdown has code fences.
  // The old regex took the first ``` … ``` pair anywhere in the text, so a
  // widget's code block was returned as "the JSON" and the whole reply failed
  // with "AI returned invalid JSON".
  it('does not mistake a code fence inside a string value for the wrapper', () => {
    const s = JSON.stringify({ suggestions: [{ kind: 'markdown', content: 'Run:\n```bash\nnpm test\n```\nthen ship.' }] })
    expect(extractJson(s)).toBe(s)
    expect(JSON.parse(extractJson(s) as string).suggestions[0].content).toContain('npm test')
  })

  it('unwraps a fenced reply whose JSON itself contains a fence', () => {
    const inner = JSON.stringify({ reply: 'ok', code: '```js\nx()\n```' })
    expect(extractJson('```json\n' + inner + '\n```')).toBe(inner)
  })

  it('unwraps a fence that follows a sentence of preamble', () => {
    expect(extractJson('Here it is:\n```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('keeps the first of two fenced blocks when each is whole', () => {
    expect(extractJson('```json\n{"a":1}\n```\nand\n```json\n{"b":2}\n```')).toBe('{"a":1}')
  })
})

describe('salvageEnvelope', () => {
  it('recovers complete actions from a truncated array and drops the partial tail', () => {
    // Mirrors the real bug: two complete actions, then a third cut off mid-cells.
    const truncated =
      '{"reply":"Here is your workspace.","actions":[' +
      '{"kind":"create-todo-list","title":"Gates","items":["a","b"],"reason":"r1"},' +
      '{"kind":"create-table","id":"tbl-assets","title":"Registry","columns":[{"label":"Asset","type":"text-short"}],"reason":"r2"},' +
      '{"kind":"add-table-row","tableId":"$tbl-assets","cells":{"Asset":"15-slide demo deck","Type":"Deck","Notes":"cut off here'

    const out = salvageEnvelope(truncated)
    expect(out).not.toBeNull()
    expect(out!.reply).toBe('Here is your workspace.')
    // The two complete actions survive; the truncated add-table-row is dropped.
    expect(out!.actions).toHaveLength(2)
    expect((out!.actions[0] as { kind: string }).kind).toBe('create-todo-list')
    expect((out!.actions[1] as { kind: string }).kind).toBe('create-table')
  })

  it('keeps nested braces and brackets balanced when scanning objects', () => {
    const truncated =
      '{"reply":"x","actions":[' +
      '{"kind":"create-table","columns":[{"label":"A","options":["x","y"]}]},' +
      '{"kind":"add-table-row","cells":{"A":{"nested":true}}},' +
      '{"kind":"create-widget","widgetKind":"sticky"' // cut off, unbalanced

    const out = salvageEnvelope(truncated)
    expect(out!.actions).toHaveLength(2)
  })

  it('keeps the reply when not a single action completed (A1: prose is worth salvaging)', () => {
    // Old contract returned null here, which turned a recoverable answer into
    // an error bubble. The reply survives; the half-written action is dropped.
    const justOpened = '{"reply":"x","actions":[{"kind":"create-todo-list","items":["a"'
    const out = salvageEnvelope(justOpened)
    expect(out?.reply).toBe('x')
    expect(out?.actions).toEqual([])
  })

  it('recovers exactly 3 complete actions from the exact bug payload shape: two create-todo-list, one create-table, then add-table-row cut off mid-cells', () => {
    // This is the verbatim payload shape that triggered the original bug.
    // Two complete create-todo-list actions, one complete create-table action,
    // then an add-table-row that was truncated mid-cells array. The salvage
    // must recover exactly 3 complete actions and drop the partial fourth.
    const bugPayload =
      '{"reply":"Here is your podcast launch workspace.","actions":[' +
      '{"kind":"create-todo-list","title":"Pre-launch checklist","items":["Record pilot episode","Buy domain","Submit to Apple Podcasts","Set up newsletter"],"reason":"tracks launch milestones"},' +
      '{"kind":"create-todo-list","title":"Episode backlog","items":["Intro to deep work","Managing interruptions","Listener Q&A 1"],"reason":"episode ideas to record"},' +
      '{"kind":"create-table","id":"tbl-episodes","title":"Episode tracker","columns":[{"label":"Title","type":"text-short"},{"label":"Status","type":"single-select","options":["Draft","Recorded","Live"]},{"label":"Publish date","type":"date"}],"reason":"track each episode"},' +
      '{"kind":"add-table-row","tableId":"$tbl-episodes","cells":{"Title":"Pilot","Status":"Draft","Publish date":"cut off here'
    // The add-table-row is intentionally not closed — it simulates the model
    // running out of tokens mid-JSON.

    const out = salvageEnvelope(bugPayload)
    expect(out).not.toBeNull()
    expect(out!.reply).toBe('Here is your podcast launch workspace.')
    expect(out!.actions).toHaveLength(3)
    expect((out!.actions[0] as { kind: string }).kind).toBe('create-todo-list')
    expect((out!.actions[1] as { kind: string }).kind).toBe('create-todo-list')
    expect((out!.actions[2] as { kind: string }).kind).toBe('create-table')
    // The partial add-table-row must NOT appear.
    const kinds = (out!.actions as Array<{ kind: string }>).map((a) => a.kind)
    expect(kinds).not.toContain('add-table-row')
  })

  it('handles a brace inside a string value without miscounting depth', () => {
    const truncated =
      '{"reply":"y","actions":[' +
      '{"kind":"create-widget","widgetKind":"note","content":"a } b ] c {"},' +
      '{"kind":"create-widget","widgetKind":"sticky","content":"tail' // cut off

    const out = salvageEnvelope(truncated)
    expect(out!.actions).toHaveLength(1)
    expect((out!.actions[0] as { content: string }).content).toBe('a } b ] c {')
  })
})

describe('salvageEnvelope — question', () => {
  const Q = '{"prompt":"Which desk?","options":["Marketing","A new desk"],"allowFreeText":true}'

  it('keeps a complete question when the actions were cut off', () => {
    const truncated =
      `{"reply":"One thing first.","question":${Q},"actions":[{"kind":"create-table","ti`
    const out = salvageEnvelope(truncated)
    expect(out).not.toBeNull()
    expect(out!.reply).toBe('One thing first.')
    expect(out!.question).toEqual(JSON.parse(Q))
    expect(out!.actions).toHaveLength(0)
  })

  it('a complete question alone is worth salvaging — a turn that asks carries no actions', () => {
    const truncated = `{"reply":"One thing first.","question":${Q},"actions":[`
    const out = salvageEnvelope(truncated)
    expect(out).not.toBeNull()
    expect(out!.question).toEqual(JSON.parse(Q))
  })

  it('keeps the question even when the cutoff landed inside the "actions" key itself', () => {
    const truncated = `{"reply":"One thing first.","question":${Q},"act`
    const out = salvageEnvelope(truncated)
    expect(out).not.toBeNull()
    expect(out!.question).toEqual(JSON.parse(Q))
    expect(out!.actions).toHaveLength(0)
  })

  it('drops a question that was cut off mid-object but keeps the reply (A1)', () => {
    const truncated = '{"reply":"x","question":{"prompt":"cut","options":["a","b'
    const out = salvageEnvelope(truncated)
    expect(out?.reply).toBe('x')
    expect(out && 'question' in out && out.question !== undefined).toBeFalsy()
  })

  it('omits the key entirely when the envelope had no question', () => {
    const truncated =
      '{"reply":"x","actions":[{"kind":"create-todo-list","title":"Gates"},{"kind":"create-table","ti'
    const out = salvageEnvelope(truncated)
    expect(out).not.toBeNull()
    expect('question' in out!).toBe(false)
  })

  it('does not mistake a question spelled inside the reply prose for the field', () => {
    // The reply QUOTES a question-shaped fragment; the real envelope has no
    // question field. Salvaging one out of the prose would render a question
    // the model never asked.
    const truncated =
      '{"reply":"Write \\"question\\": {\\"prompt\\": \\"fake\\", \\"options\\": [\\"a\\", \\"b\\"]} in your config.",' +
      '"actions":[{"kind":"create-todo-list","title":"Gates"},{"kind":"create-table","ti'
    const out = salvageEnvelope(truncated)
    expect(out).not.toBeNull()
    expect('question' in out!).toBe(false)
    expect(out!.actions).toHaveLength(1)
  })
})

describe('salvage of unescaped-quote and cut-off prose (the A1 drive defect)', () => {
  it('recovers the full prose when the model forgot to escape its quotes', () => {
    const raw =
      '{"reply":"Send **fewer messages with a clearer "why"** and a sharper ask.","actions":[]}'
    const s = salvageEnvelope(raw)
    expect(s?.reply).toBe('Send **fewer messages with a clearer "why"** and a sharper ask.')
    expect(s?.replyCut).toBeFalsy()
    expect(s?.actions).toEqual([])
  })

  it('keeps a prose-only reply when the stream died mid-sentence, and marks the cut', () => {
    const raw = '{"reply":"The SDR role has evolved into a strategic operator'
    const s = salvageEnvelope(raw)
    expect(s?.reply).toContain('strategic operator')
    expect(s?.replyCut).toBe(true)
    expect(s?.actions).toEqual([])
  })

  it('still returns null when nothing at all is recoverable', () => {
    expect(salvageEnvelope('{"repl')).toBeNull()
    expect(salvageEnvelope('total garbage')).toBeNull()
  })
})
