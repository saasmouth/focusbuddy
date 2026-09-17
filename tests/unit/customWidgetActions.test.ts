// The policy that decides what a generated widget may do.
//
// Everything judged here crossed a postMessage boundary from code a model wrote
// and nobody read. The tests that matter most are the refusals: the scope rule
// (a widget may only touch what the user wired into it) is what makes granting
// a widget write access grant it nothing beyond the sources the user chose.
import { describe, it, expect } from 'vitest'
import {
  judgeWidgetAction,
  describeWidgetAction,
  WIDGET_ACTION_KINDS,
  type ActionScope
} from '../../src/shared/customWidgetActions'

const wired = (acts: boolean, tableIds: string[] = ['tbl-1']): ActionScope => ({ tableIds, acts })

describe('the verb list is closed', () => {
  it('refuses anything not on it', () => {
    for (const kind of ['delete-widget', 'run-shell', 'nodes:delete', 'fetch', '', 'eval']) {
      const v = judgeWidgetAction({ kind, tableId: 'tbl-1', cells: { a: 1 } }, wired(true))
      expect(v.ok, `${kind} must be refused`).toBe(false)
    }
  })

  it('names what IS allowed, so the widget can correct itself', () => {
    const v = judgeWidgetAction({ kind: 'wat' }, wired(true))
    expect(v.ok).toBe(false)
    if (!v.ok) for (const k of WIDGET_ACTION_KINDS) expect(v.reason).toContain(k)
  })

  it('refuses anything that is not an object at all', () => {
    for (const bad of [null, undefined, 'add-table-row', 7, [], true]) {
      expect(judgeWidgetAction(bad, wired(true)).ok).toBe(false)
    }
  })
})

describe('scope — a widget may only touch what is wired into it', () => {
  it('allows a table it is wired to', () => {
    const v = judgeWidgetAction({ kind: 'add-table-row', tableId: 'tbl-1', cells: { Name: 'x' } }, wired(true))
    expect(v.ok).toBe(true)
  })

  it('refuses a table it is NOT wired to, even with write access on', () => {
    // The whole point: switching a widget on grants it its OWN sources, not the
    // workspace. Without this, one consent would be consent to everything.
    const v = judgeWidgetAction({ kind: 'add-table-row', tableId: 'tbl-other', cells: { Name: 'x' } }, wired(true))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('wired into it')
  })

  it('refuses every table when nothing is wired in', () => {
    const v = judgeWidgetAction({ kind: 'set-cell', tableId: 'tbl-1', rowId: 'r1', cells: { a: 1 } }, wired(true, []))
    expect(v.ok).toBe(false)
  })

  it('applies the scope rule to set-cell as well as add-table-row', () => {
    const v = judgeWidgetAction({ kind: 'set-cell', tableId: 'nope', rowId: 'r1', cells: { a: 1 } }, wired(true))
    expect(v.ok).toBe(false)
  })
})

describe('consent — once, not never and not constantly', () => {
  it('proposes a write when the widget has not been switched on', () => {
    const v = judgeWidgetAction({ kind: 'add-table-row', tableId: 'tbl-1', cells: { a: 'x' } }, wired(false))
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.needsApproval).toBe(true)
  })

  it('runs a write directly once it has been', () => {
    // A tool that asks permission on every row is a tool nobody keeps.
    const v = judgeWidgetAction({ kind: 'add-table-row', tableId: 'tbl-1', cells: { a: 'x' } }, wired(true))
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.needsApproval).toBe(false)
  })

  it('never lets consent stand in for scope', () => {
    const v = judgeWidgetAction({ kind: 'add-table-row', tableId: 'elsewhere', cells: { a: 'x' } }, wired(true))
    expect(v.ok).toBe(false)
  })
})

describe('shape validation', () => {
  it('requires a table id', () => {
    expect(judgeWidgetAction({ kind: 'add-table-row', cells: { a: 1 } }, wired(true)).ok).toBe(false)
  })

  it('requires something to write', () => {
    for (const cells of [undefined, {}, [], 'x', null]) {
      expect(judgeWidgetAction({ kind: 'add-table-row', tableId: 'tbl-1', cells }, wired(true)).ok).toBe(false)
    }
  })

  it('requires a row id to change a cell', () => {
    expect(
      judgeWidgetAction({ kind: 'set-cell', tableId: 'tbl-1', cells: { a: 1 } }, wired(true)).ok
    ).toBe(false)
  })

  it('drops cell values that are not values', () => {
    const v = judgeWidgetAction(
      { kind: 'add-table-row', tableId: 'tbl-1', cells: { keep: 'yes', nested: { a: 1 }, list: [1], fn: undefined } },
      wired(true)
    )
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'add-table-row') {
      expect(Object.keys(v.action.cells)).toEqual(['keep'])
    }
  })

  it('drops non-finite numbers rather than writing NaN into a cell', () => {
    const v = judgeWidgetAction(
      { kind: 'add-table-row', tableId: 'tbl-1', cells: { ok: 1, bad: NaN, worse: Infinity } },
      wired(true)
    )
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'add-table-row') {
      expect(Object.keys(v.action.cells)).toEqual(['ok'])
    }
  })

  it('keeps false and null, which are real values', () => {
    const v = judgeWidgetAction(
      { kind: 'add-table-row', tableId: 'tbl-1', cells: { done: false, note: null } },
      wired(true)
    )
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'add-table-row') {
      expect(v.action.cells).toEqual({ done: false, note: null })
    }
  })

  it('bounds a runaway string', () => {
    const v = judgeWidgetAction(
      { kind: 'add-table-row', tableId: 'tbl-1', cells: { a: 'x'.repeat(50_000) } },
      wired(true)
    )
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'add-table-row') {
      expect(String(v.action.cells.a).length).toBeLessThanOrEqual(4000)
    }
  })

  it('bounds the number of cells', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 500; i++) many[`c${i}`] = 'v'
    const v = judgeWidgetAction({ kind: 'add-table-row', tableId: 'tbl-1', cells: many }, wired(true))
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'add-table-row') {
      expect(Object.keys(v.action.cells).length).toBeLessThanOrEqual(64)
    }
  })
})

describe('open-url', () => {
  it('opens a real web address without a second consent', () => {
    // It leaves nothing behind and is what the user just clicked.
    const v = judgeWidgetAction({ kind: 'open-url', url: 'https://example.com/x' }, wired(false))
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.needsApproval).toBe(false)
  })

  it('refuses every scheme that is not http(s)', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'fb-widget://x',
      'about:blank',
      ''
    ]) {
      expect(judgeWidgetAction({ kind: 'open-url', url }, wired(true)).ok, url).toBe(false)
    }
  })
})

describe('create-knowledge-entry', () => {
  it('needs something to save', () => {
    expect(judgeWidgetAction({ kind: 'create-knowledge-entry' }, wired(true)).ok).toBe(false)
    expect(
      judgeWidgetAction({ kind: 'create-knowledge-entry', title: '  ', body: '' }, wired(true)).ok
    ).toBe(false)
  })

  it('never saves an untitled entry with no name at all', () => {
    const v = judgeWidgetAction({ kind: 'create-knowledge-entry', body: 'note' }, wired(true))
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'create-knowledge-entry') expect(v.action.title).toBe('Untitled')
  })

  it('drops tags that are not strings and bounds the rest', () => {
    const v = judgeWidgetAction(
      { kind: 'create-knowledge-entry', title: 't', body: 'b', tags: ['a', 2, null, '  ', 'b'] },
      wired(true)
    )
    expect(v.ok).toBe(true)
    if (v.ok && v.action.kind === 'create-knowledge-entry') expect(v.action.tags).toEqual(['a', 'b'])
  })
})

describe('describeWidgetAction', () => {
  it('says what will happen in the user’s terms', () => {
    expect(describeWidgetAction({ kind: 'add-table-row', tableId: 't', cells: { Name: 'Acme' } })).toContain('Acme')
    expect(describeWidgetAction({ kind: 'set-cell', tableId: 't', rowId: 'r', cells: { Status: 'Live' } })).toContain('Status')
    expect(describeWidgetAction({ kind: 'create-knowledge-entry', title: 'Rule', body: '' })).toContain('Rule')
    expect(describeWidgetAction({ kind: 'open-url', url: 'https://example.com/a' })).toContain('example.com')
  })

  it('never returns an empty label', () => {
    expect(describeWidgetAction({ kind: 'add-table-row', tableId: 't', cells: { n: 1 } })).not.toBe('')
    expect(describeWidgetAction({ kind: 'set-cell', tableId: 't', rowId: 'r', cells: {} })).not.toBe('')
  })
})
