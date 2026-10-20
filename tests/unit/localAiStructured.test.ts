// @vitest-environment node
// Tolerant parsing → the call's contract → strict validation, for structured
// output from the on-device model (structuredOutput.ts). Never invents content.
import { describe, it, expect } from 'vitest'
import { parseStructured, firstJsonValue, stripTrailingCommas, contractFor } from '../../src/main/ai/local/structuredOutput'

const TABLE_SYS = 'Reply with a SINGLE JSON object: { "columnsToAdd": [...], "rows": [ {…} ] }. NO prose.'
const BUILD_SYS = 'Return ONLY JSON: {"intent": "...", "suggestions": [ {"id":"s1","kind":"sticky"} ]}'
const ROWS = [{ Name: 'Episode 1', Host: 'Alex' }, { Name: 'Episode 2', Host: 'Sam' }]

describe('contract recognition', () => {
  it('tells calls that share a purpose apart by what they ask for', () => {
    expect(contractFor('setup', TABLE_SYS)?.id).toBe('table-rows')
    expect(contractFor('setup', BUILD_SYS)?.id).toBe('build-suggestions')
    expect(contractFor('setup', 'return a JSON object with exactly these keys: "name", "blurb", and "systemPrompt"')?.id).toBe('agent-profile')
    expect(contractFor('chat', 'Return ONLY a single JSON object. Schema: {"actions":[ ... ]}')?.id).toBe('workspace-actions')
    expect(contractFor('chat', 'Reply with {"reply": "...", "actions": []}')?.id).toBe('chat-envelope')
    expect(contractFor('document', 'Write a document.')).toBeNull()
  })
})

describe('tolerant parsing', () => {
  it('takes the first balanced value through prose and fences, braces inside strings respected', () => {
    expect(firstJsonValue('Sure! Here you go:\n```json\n{"a":"x } y","b":[1,2]}\n```\nHope that helps.')).toEqual({ raw: '{"a":"x } y","b":[1,2]}' })
    expect(firstJsonValue('{"rows":[{"a":1},{"a":2}')).toEqual({ cutOff: true })
    expect(firstJsonValue('no json here')).toBeNull()
  })

  it('repairs trailing commas, but not inside strings', () => {
    expect(stripTrailingCommas('{"a":[1,2,],"b":"x,]",}')).toBe('{"a":[1,2],"b":"x,]"}')
  })

  it('table rows: prose + fence + trailing comma → accepted, normalised JSON handed to the call site', () => {
    const text = 'Here are the rows:\n```json\n{"columnsToAdd":[{"label":"Host","type":"text-short"},],"rows":' + JSON.stringify(ROWS) + '}\n```'
    const r = parseStructured(text, 'object', 'setup', TABLE_SYS)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.text)).toEqual({ columnsToAdd: [{ label: 'Host', type: 'text-short' }], rows: ROWS })
      expect(r.repairs).toEqual(expect.arrayContaining(['extracted', 'trailing-commas']))
    }
  })

  it('table rows: a bare array of rows, or rows under another key, or columns as "columns"', () => {
    for (const text of [JSON.stringify(ROWS), JSON.stringify({ items: ROWS }), JSON.stringify({ columns: [{ label: 'Host', type: 'text-short' }], data: ROWS })]) {
      const r = parseStructured(text, 'object', 'setup', TABLE_SYS)
      expect(r.ok, text).toBe(true)
      if (r.ok) expect((r.value as { rows: unknown[] }).rows).toEqual(ROWS)
    }
  })

  it('table rows: empty rows, rows that are not objects, or no rows at all are failures — never filled in', () => {
    expect(parseStructured('{"columnsToAdd":[],"rows":[]}', 'object', 'setup', TABLE_SYS)).toMatchObject({ ok: false, problem: expect.stringMatching(/"rows" is empty/) })
    expect(parseStructured('{"rows":["a","b"]}', 'object', 'setup', TABLE_SYS)).toMatchObject({ ok: false })
    expect(parseStructured('{"suggestions":[{"kind":"table"}]}', 'object', 'setup', TABLE_SYS)).toMatchObject({ ok: false, problem: expect.stringMatching(/"rows" array/) })
    expect(parseStructured('{"rows":[{}]}', 'object', 'setup', TABLE_SYS)).toMatchObject({ ok: false, problem: expect.stringMatching(/no cells/) })
  })

  it('Build with AI: a bare array of cards, a single card, or cards under "items" → {suggestions}', () => {
    const card = { id: 's1', kind: 'sticky', title: 'To read' }
    for (const text of [JSON.stringify([card]), JSON.stringify(card), JSON.stringify({ items: [card] })]) {
      const r = parseStructured(text, 'object', 'setup', BUILD_SYS)
      expect(r.ok, text).toBe(true)
      if (r.ok) expect((r.value as { suggestions: unknown[] }).suggestions).toEqual([card])
    }
    // A table card without columns is still invalid: nothing is invented.
    expect(parseStructured('{"suggestions":[{"kind":"table","title":"T"}]}', 'object', 'setup', BUILD_SYS)).toMatchObject({ ok: false })
  })

  it('a truncated reply is a cut-off failure (retried), never half handed over', () => {
    expect(parseStructured('{"rows":[{"Name":"Episode 1"},{"Name":"Ep', 'object', 'setup', TABLE_SYS)).toMatchObject({ ok: false, cutOff: true })
  })

  it('unchanged replies are passed through as written', () => {
    const text = JSON.stringify({ columnsToAdd: [], rows: ROWS })
    const r = parseStructured(text, 'object', 'setup', TABLE_SYS)
    expect(r).toMatchObject({ ok: true, changed: false, text })
  })
})

describe('runaway repetition guard (engineCore.isRunawayRepetition)', () => {
  it('catches the real loop the 4B model fell into, and leaves ordinary output alone', async () => {
    const { isRunawayRepetition } = await import('../../src/main/ai/local/engineCore')
    // Captured from a real Build with AI run (structured-before.json): an invented URL that never ended.
    const loop = '"content": "https://docs.google.com/document/d/1aBcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz' + 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'.repeat(12)
    expect(isRunawayRepetition(loop)).toBe(true)
    expect(isRunawayRepetition('x'.repeat(400))).toBe(true)
    const table = '| Week | Task |\n| --- | --- |\n' + Array.from({ length: 30 }, (_, i) => `| ${i + 1} | Plan item ${i + 1} |`).join('\n')
    expect(isRunawayRepetition(table)).toBe(false)
    const json = JSON.stringify({ rows: Array.from({ length: 20 }, (_, i) => ({ Name: `Episode ${i + 1}`, Done: false })) })
    expect(isRunawayRepetition(json)).toBe(false)
    expect(isRunawayRepetition('----------')).toBe(false)
  })
})
