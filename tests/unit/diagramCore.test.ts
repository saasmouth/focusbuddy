import { describe, expect, it } from 'vitest'
import { normalizeMapBody } from '../../src/shared/mapGraph'
import { normalizeBody } from '../../src/shared/diagram/normalize'
import { resolveEdgeStyle, resolveNodeStyle, dashArray, contrastText, THEMES } from '../../src/shared/diagram/style'
import { boundView, cellText, generateFromTable, renderTemplate, ruleMatches } from '../../src/shared/diagram/data'
import { snapToGuides, snapToGrid } from '../../src/shared/diagram/guides'
import { History } from '../../src/shared/diagram/history'
import { nodeSize, parsePort, portId, sideOf, portPoint, rotatePt } from '../../src/shared/diagram/geom'
import type { FbRow, FbTable } from '../../src/shared/fields'

describe('normalize: the shape-loss bug', () => {
  it('keeps every legacy shape id across a reload (triangle, star, arrow, cross, pentagon, callout)', () => {
    const shapes = ['triangle', 'pentagon', 'star', 'cross', 'arrow', 'callout', 'process', 'lane', 'widget']
    const body = normalizeMapBody({
      version: 1,
      nodes: shapes.map((shape, i) => ({ id: `n${i}`, x: i, y: 0, label: shape, shape, color: '#000000' })),
      edges: []
    })
    expect(body.nodes.map((n) => n.shape)).toEqual(shapes)
    // And again, as the DB does on every read.
    expect(normalizeMapBody(JSON.parse(JSON.stringify(body))).nodes.map((n) => n.shape)).toEqual(shapes)
  })

  it('maps unknown shapes to process and drops dangling edges', () => {
    const b = normalizeBody({ nodes: [{ id: 'a', shape: 'nope' }, { id: 'b' }], edges: [{ source: 'a', target: 'zz' }, { source: 'a', target: 'b' }] })
    expect(b.nodes[0]!.shape).toBe('process')
    expect(b.edges).toHaveLength(1)
    expect(b.edges[0]!.id).toBe('e-a-b')
  })
})

describe('normalize: v2 fields', () => {
  it('keeps well-formed v2 fields and drops malformed ones', () => {
    const b = normalizeBody({
      nodes: [
        {
          id: 'a',
          shape: 'process',
          rotation: 450,
          locked: true,
          groupId: 'g1',
          style: { fill: '#fff', fontSize: 14, bold: true, textAlign: 'left', strokeDash: 'dotted', bogus: 1, opacity: 9 },
          data: { owner: 'Sam', n: 3, obj: { x: 1 } },
          binding: { source: { kind: 'table', tableId: 't1', rowId: 'r1' }, labelTemplate: '{Name}', rules: [{ columnId: 'c', op: 'eq', value: 'x', fill: '#f00' }, { op: 'bad' }] },
          cells: [['a', 1], 'not a row']
        },
        { id: 'b', parentId: 'missing' }
      ],
      edges: [{ id: 'e', source: 'a', target: 'b', routing: 'curved', endArrow: 'crowMany', startArrow: 'zzz', waypoints: [{ x: 1, y: 2 }, { x: 'q' }], dash: 'dashdot', labelPos: 2 }],
      settings: { gridSize: 10, snap: false, lineJumps: true, theme: 'dark', defaultRouting: 'nope' },
      layers: [{ id: 'l1', name: 'Base', visible: false }],
      pages: [{ id: 'p2', name: 'Detail', nodes: [{ id: 'x' }], edges: [] }, { id: 'p2' }]
    })
    const a = b.nodes[0]!
    expect(a.rotation).toBe(90)
    expect(a.locked).toBe(true)
    expect(a.style).toEqual({ fill: '#fff', fontSize: 14, bold: true, textAlign: 'left', strokeDash: 'dotted' })
    expect(a.data).toEqual({ owner: 'Sam', n: '3' })
    expect(a.binding?.rules).toHaveLength(1)
    expect(a.cells).toEqual([['a', '1']])
    expect(b.nodes[1]!.parentId).toBeUndefined()
    const e = b.edges[0]!
    expect(e.routing).toBe('curved')
    expect(e.endArrow).toBe('crowMany')
    expect(e.startArrow).toBeUndefined()
    expect(e.waypoints).toEqual([{ x: 1, y: 2 }])
    expect(e.labelPos).toBeUndefined()
    expect(b.settings).toEqual({ gridSize: 10, snap: false, lineJumps: true, theme: 'dark' })
    expect(b.layers).toEqual([{ id: 'l1', name: 'Base', visible: false, locked: false }])
    expect(b.pages).toHaveLength(1)
    expect(b.pages![0]!.nodes[0]!.id).toBe('x')
  })

  it('never throws on garbage', () => {
    for (const g of [null, 1, 'x', [], { nodes: 'x' }, { nodes: [null, 1, { id: 5 }] }]) {
      expect(() => normalizeBody(g)).not.toThrow()
    }
  })
})

describe('style', () => {
  it('a v1 node resolves to the original look', () => {
    const s = resolveNodeStyle({ shape: 'decision', color: '#dc2626' })
    expect(s.stroke).toBe('#dc2626')
    expect(s.fill).toBe('#dc2626')
    expect(s.fillOpacity).toBeCloseTo(0.12)
    expect(resolveNodeStyle({ shape: 'process', color: '#dc2626' }).fill).toBe('#ffffff')
  })
  it('node style and rules override the theme', () => {
    const s = resolveNodeStyle({ shape: 'process', color: '#000', style: { fill: '#abcdef', fontSize: 20 } }, 'classic', { stroke: '#ff0000' })
    expect(s.fill).toBe('#abcdef')
    expect(s.fontSize).toBe(20)
    expect(s.stroke).toBe('#ff0000')
  })
  it('edges default to an arrow and honour legacy dashed', () => {
    const s = resolveEdgeStyle({ id: 'e', source: 'a', target: 'b', style: 'dashed' })
    expect(s.endArrow).toBe('arrow')
    expect(s.dash).toBe('dashed')
    expect(dashArray('dotted', 2)).toBe('2 5')
    expect(dashArray('solid', 2)).toBeUndefined()
  })
  it('has several themes and readable contrast', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(6)
    expect(contrastText('#000000')).toBe('#ffffff')
    expect(contrastText('#ffffff')).toBe('#1c1917')
  })
})

const table: FbTable = {
  id: 'tbl1',
  taskId: null,
  title: 'Team',
  createdAt: 0,
  updatedAt: 0,
  schema: {
    columns: [
      { id: 'name', type: 'text-short', label: 'Name', config: {} },
      { id: 'role', type: 'text-short', label: 'Role', config: {} },
      { id: 'boss', type: 'text-short', label: 'Manager', config: {} },
      { id: 'status', type: 'single-select', label: 'Status', config: { options: [{ id: 'o1', label: 'Active', color: 'green' }, { id: 'o2', label: 'Away' }] } },
      { id: 'n', type: 'number', label: 'Score', config: { suffix: '%' } }
    ]
  }
}
const row = (id: string, cells: Record<string, unknown>): FbRow => ({ id, tableId: 'tbl1', cells, sortOrder: 0, createdAt: 0, updatedAt: 0 })
const rows = [
  row('r1', { name: 'Ada', role: 'CEO', status: 'o1', n: 90 }),
  row('r2', { name: 'Ben', role: 'CTO', boss: 'Ada', status: 'o2', n: 40 }),
  row('r3', { name: 'Cy', role: 'Dev', boss: 'Ben', n: 75 }),
  row('r4', { name: 'Di', role: 'Dev', boss: 'Nobody' })
]

describe('data binding', () => {
  it('formats cells like the table widget', () => {
    expect(cellText('o1', table.schema.columns[3])).toBe('Active')
    expect(cellText(90, table.schema.columns[4])).toBe('90%')
    expect(cellText(null, table.schema.columns[0])).toBe('')
  })
  it('renders templates and leaves unknown names visible', () => {
    expect(renderTemplate('{Name} · {Role} ({Status})', table, rows[0]!)).toBe('Ada · CEO (Active)')
    expect(renderTemplate('{Nope}', table, rows[0]!)).toBe('{Nope}')
  })
  it('evaluates rules', () => {
    expect(ruleMatches({ id: 'a', columnId: 'n', op: 'gt', value: '50' }, table, rows[0]!)).toBe(true)
    expect(ruleMatches({ id: 'a', columnId: 'status', op: 'eq', value: 'away' }, table, rows[1]!)).toBe(true)
    expect(ruleMatches({ id: 'a', columnId: 'boss', op: 'empty' }, table, rows[0]!)).toBe(true)
  })
  it('bound view reports missing rows honestly', () => {
    const v = boundView({ source: { kind: 'table', tableId: 'tbl1', rowId: 'gone' } }, table, rows, 'Old label')
    expect(v.missing).toBe('row')
    expect(v.label).toBe('Old label')
    const w = boundView({ source: { kind: 'table', tableId: 'tbl1', rowId: 'r2' }, fields: ['role'], rules: [{ id: 'x', columnId: 'n', op: 'lt', value: '50', fill: '#f00' }] }, table, rows, '')
    expect(w.label).toBe('Ben')
    expect(w.fields).toEqual([{ name: 'Role', value: 'CTO' }])
    expect(w.rule?.fill).toBe('#f00')
  })
  it('generates an org chart from a manager-name column, warning on unmatched names', () => {
    const g = generateFromTable(table, rows, { kind: 'orgchart', linkColumnId: 'boss', colorColumnId: 'status' })
    expect(g.nodes).toHaveLength(4)
    expect(g.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(['ttbl1-r1>ttbl1-r2', 'ttbl1-r2>ttbl1-r3'])
    expect(g.warnings.join(' ')).toContain('Nobody')
    expect(g.nodes[0]!.color).toBe('#16a34a')
    expect(g.nodes[0]!.binding?.source).toEqual({ kind: 'table', tableId: 'tbl1', rowId: 'r1' })
  })
  it('generates a sequential flow and a grouped mind map', () => {
    expect(generateFromTable(table, rows, { kind: 'flow' }).edges).toHaveLength(3)
    const m = generateFromTable(table, rows, { kind: 'mindmap', linkColumnId: 'role' })
    expect(m.nodes.filter((n) => n.id.includes('-g-')).map((n) => n.label).sort()).toEqual(['CEO', 'CTO', 'Dev'])
  })
})

describe('guides', () => {
  it('snaps to an aligned edge and reports the guide', () => {
    const r = snapToGuides({ id: 'm', x: 103, y: 300, w: 50, h: 40 }, [{ id: 'a', x: 100, y: 0, w: 80, h: 40 }], 6)
    expect(r.dx).toBe(-3)
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 100)).toBe(true)
  })
  it('snaps centres and equal gaps', () => {
    const c = snapToGuides({ id: 'm', x: 0, y: 118, w: 40, h: 40 }, [{ id: 'a', x: 300, y: 100, w: 40, h: 80 }], 5)
    expect(c.dy).toBe(2)
    const g = snapToGuides({ id: 'm', x: 152, y: 0, w: 40, h: 40 }, [{ id: 'a', x: 0, y: 0, w: 100, h: 40 }, { id: 'b', x: 250, y: 0, w: 100, h: 40 }], 6)
    expect(g.dx).toBe(3) // equal gaps: (100 + 250 - 40) / 2 = 155
    expect(g.guides.filter((x) => x.kind === 'gap')).toHaveLength(2)
  })
  it('no snap beyond threshold; grid rounding', () => {
    expect(snapToGuides({ id: 'm', x: 0, y: 0, w: 10, h: 10 }, [{ id: 'a', x: 500, y: 500, w: 10, h: 10 }], 5)).toEqual({ dx: 0, dy: 0, guides: [] })
    expect(snapToGrid(23, 16)).toBe(16)
    expect(snapToGrid(25, 16)).toBe(32)
  })
})

describe('history', () => {
  it('undoes, redoes and coalesces same-key edits', () => {
    const h = new History<{ v: number }>({ coalesceMs: 1000 })
    h.record({ v: 0 }, undefined, 0)
    h.record({ v: 1 }, 'type', 10)
    h.record({ v: 2 }, 'type', 20) // coalesced into the previous step
    expect(h.undo({ v: 3 })).toEqual({ v: 1 })
    expect(h.undo({ v: 1 })).toEqual({ v: 0 })
    expect(h.undo({ v: 0 })).toBeNull()
    expect(h.redo({ v: 0 })).toEqual({ v: 1 })
    expect(h.canRedo).toBe(true)
    h.record({ v: 1 }, undefined, 5000)
    expect(h.canRedo).toBe(false)
  })
})

describe('geom', () => {
  it('ports parse and round-trip', () => {
    expect(parsePort('top')).toEqual({ fx: 0.5, fy: 0 })
    expect(parsePort('p:0.25:1')).toEqual({ fx: 0.25, fy: 1 })
    expect(parsePort('garbage')).toBeNull()
    expect(portId(0.25, 1)).toBe('p:0.25:1')
    expect(portId(1, 0.5)).toBe('right')
    expect(sideOf(0.25, 1)).toBe('bottom')
  })
  it('sizes come from the registry unless set', () => {
    expect(nodeSize({ shape: 'decision' })).toEqual({ w: 130, h: 92 })
    expect(nodeSize({ shape: 'decision', width: 10, height: 20 })).toEqual({ w: 10, h: 20 })
  })
  it('rotated ports rotate about the centre', () => {
    const p = portPoint({ id: 'a', x: 0, y: 0, w: 100, h: 50, rotation: 90 }, 1, 0.5)
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(75)
    expect(rotatePt({ x: 1, y: 0 }, { x: 0, y: 0 }, 0)).toEqual({ x: 1, y: 0 })
  })
})

// Bodies saved by the 4.3.3x editor carry `arrow` and `cornerRadius`; they must
// open with the same arrowheads and corners they were drawn with.
describe('legacy edge fields', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 400, y: 200 }
  ]
  it('folds arrow both/none/end into start and end heads', () => {
    const b = normalizeBody({
      nodes,
      edges: [
        { id: 'both', source: 'a', target: 'b', arrow: 'both' },
        { id: 'none', source: 'a', target: 'b', arrow: 'none' },
        { id: 'end', source: 'a', target: 'b', arrow: 'end' },
        { id: 'explicit', source: 'a', target: 'b', arrow: 'none', endArrow: 'diamond' }
      ]
    })
    const by = Object.fromEntries(b.edges.map((e) => [e.id, resolveEdgeStyle(e)]))
    expect([by.both!.startArrow, by.both!.endArrow]).toEqual(['arrow', 'arrow'])
    expect([by.none!.startArrow, by.none!.endArrow]).toEqual(['none', 'none'])
    expect([by.end!.startArrow, by.end!.endArrow]).toEqual(['none', 'arrow'])
    expect(by.explicit!.endArrow).toBe('diamond')
  })
  it('keeps a per-edge corner radius, and 0 gives hard corners', async () => {
    const { routeAll } = await import('../../src/shared/diagram/routing')
    const b = normalizeBody({ nodes, edges: [{ id: 'hard', source: 'a', target: 'b', cornerRadius: 0 }, { id: 'soft', source: 'a', target: 'b', cornerRadius: 12, sourceHandle: 'bottom', targetHandle: 'left' }] })
    expect(b.edges.map((e) => e.cornerRadius)).toEqual([0, 12])
    const routes = routeAll(b.nodes, b.edges, { cornerRadius: 8 })
    expect(routes.get('hard')!.path).not.toMatch(/[QA]/)
    expect(routes.get('soft')!.path).toMatch(/[QA]/)
  })
})
