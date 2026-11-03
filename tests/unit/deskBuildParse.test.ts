// @vitest-environment node
// Reading a desk build's reply (deskBuildParse.ts). Pure: no model, no DB.
//
// The owner's report (4.3.45): "Deskbuild says json file is invalid". A rich
// desk ran past the 16,384-token cap, the reply stopped mid-widget, and the
// whole generation — every complete, configured work widget in it — was thrown
// away behind "AI returned invalid JSON". These pin the replacement: complete
// widgets are kept, pages written as markdown become page documents, and
// nothing is invented to fill a gap.
import { describe, it, expect } from 'vitest'
import { parseDeskBuild } from '../../src/main/ai/deskBuildParse'

const table = {
  id: 's1',
  kind: 'table',
  title: 'Suppliers',
  reason: 'Who supplies what',
  tableSchema: { columns: [{ id: 'c1', type: 'text-short', label: 'Name', config: {} }] }
}
const page = { id: 's2', kind: 'page', title: 'Plan', reason: 'The plan', pageMarkdown: '# Plan\n\n- [ ] Book venue\n\n```bash\nnpm ci\n```' }
const sticky = { id: 's3', kind: 'sticky', title: 'Today', reason: 'Focus', content: 'Call the printer' }

describe('parseDeskBuild — a whole reply', () => {
  it('reads minified JSON and turns a markdown page into a page document', () => {
    const r = parseDeskBuild(JSON.stringify({ intent: 'A launch desk', suggestions: [table, page, sticky] }))
    expect(r).toMatchObject({ ok: true, intent: 'A launch desk', recovered: false, dropped: 0 })
    if (!r.ok) return
    expect(r.suggestions.map((s) => s.kind)).toEqual(['table', 'page', 'sticky'])
    const p = r.suggestions[1] as unknown as Record<string, unknown>
    expect(p.pageMarkdown).toBeUndefined()
    const doc = p.pageContent as { type: string; content: Array<{ type: string; attrs?: Record<string, unknown> }> }
    expect(doc.type).toBe('doc')
    expect(doc.content.map((b) => b.type)).toEqual(['heading', 'taskList', 'codeBlock'])
  })

  it('keeps a page document the model sent directly', () => {
    const pageContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] }
    const r = parseDeskBuild(JSON.stringify({ suggestions: [{ id: 's1', kind: 'page', title: 'P', reason: '', pageContent }] }))
    expect(r.ok && r.suggestions[0].pageContent).toEqual(pageContent)
  })

  it('accepts a fenced reply, and a fence inside a widget does not break it', () => {
    const md = { id: 's1', kind: 'markdown', title: 'Snippets', reason: '', content: 'Deploy:\n```sh\nmake ship\n```' }
    for (const text of [JSON.stringify({ suggestions: [md] }), '```json\n' + JSON.stringify({ suggestions: [md] }) + '\n```']) {
      const r = parseDeskBuild(text)
      expect(r.ok, text).toBe(true)
      if (r.ok) expect(r.suggestions[0].content).toBe(md.content)
    }
  })

  it('drops kinds the canvas cannot render and things that are not widgets', () => {
    const r = parseDeskBuild(JSON.stringify({ suggestions: [sticky, { kind: 'hologram', title: 'x' }, 'nope', { title: 'no kind' }] }))
    expect(r.ok && r.suggestions.map((s) => s.title)).toEqual(['Today'])
  })

  it('gives every widget a unique id, so two cards never toggle together', () => {
    const r = parseDeskBuild(JSON.stringify({ suggestions: [{ ...sticky, id: 'a' }, { ...sticky, id: 'a' }, { ...sticky, id: '' }, { ...sticky, id: undefined }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.suggestions.map((s) => s.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids[0]).toBe('a')
  })
})

describe('parseDeskBuild — a reply that is not whole', () => {
  it('keeps every complete widget from a reply cut off mid-widget, and counts the partial one', () => {
    const whole = JSON.stringify({ intent: 'A launch desk', suggestions: [table, page, sticky] })
    const cut = whole.slice(0, whole.indexOf('Call the printer') + 4)
    const r = parseDeskBuild(cut)
    expect(r).toMatchObject({ ok: true, intent: 'A launch desk', recovered: true, dropped: 1 })
    if (!r.ok) return
    expect(r.suggestions.map((s) => s.title)).toEqual(['Suppliers', 'Plan'])
    expect((r.suggestions[1].pageContent as { type: string }).type).toBe('doc')
  })

  it('cut off between widgets: nothing partial to count', () => {
    const whole = JSON.stringify({ suggestions: [table, sticky] })
    const cut = whole.slice(0, whole.indexOf(',{"id":"s3"') + 1)
    expect(parseDeskBuild(cut)).toMatchObject({ ok: true, recovered: true, dropped: 0 })
  })

  it('one broken widget in the middle costs only that widget', () => {
    const broken = '{"id":"s2","kind":"note","title":"Bad","reason":"","content":"He said "hi" and left"}'
    const text = `{"suggestions":[${JSON.stringify(table)},${broken},${JSON.stringify(sticky)}]}`
    const r = parseDeskBuild(text)
    expect(r).toMatchObject({ ok: true, recovered: true, dropped: 1 })
    expect(r.ok && r.suggestions.map((s) => s.title)).toEqual(['Suppliers', 'Today'])
  })

  it('a brace or bracket inside a string never ends a widget early', () => {
    const tricky = { ...sticky, content: 'Use { and } and ] freely, even "quoted \\" ones"' }
    const whole = JSON.stringify({ suggestions: [tricky, table] })
    const r = parseDeskBuild(whole.slice(0, -3))
    expect(r.ok && r.suggestions.map((s) => s.content ?? null)).toEqual([tricky.content])
  })

  it('says plainly when there is no JSON at all, or no widget could be read', () => {
    expect(parseDeskBuild('I cannot help with that.')).toEqual({ ok: false, reason: 'no-json' })
    expect(parseDeskBuild('{"intent":"A desk","suggestions":[{"id":"s1","kind":"tab')).toEqual({ ok: false, reason: 'unreadable', dropped: 1 })
    expect(parseDeskBuild('{"intent":"A desk"')).toEqual({ ok: false, reason: 'unreadable', dropped: 0 })
  })
})
