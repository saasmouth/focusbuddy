import { describe, it, expect } from 'vitest'
import { deflateSync, strToU8 } from 'fflate'
import { drawioToMap, mapToDrawio, parseXml, parseStyle, type DrawioPage } from '../../src/shared/diagram/drawio'
import { SHAPES, isShapeId } from '../../src/shared/diagram/shapes'
import type { MapEdge, MapNode } from '../../src/shared/types'

const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]))

// What diagrams.net does when it saves a compressed page.
function compress(xml: string): string {
  const bytes = deflateSync(strToU8(encodeURIComponent(xml)))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// ── a realistic hand-written diagrams.net file ──────────────────────────────

const MODEL = `<mxGraphModel dx="1000" dy="600" grid="1" gridSize="10">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="start" value="Start" style="ellipse;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="80" height="80" as="geometry" />
    </mxCell>
    <mxCell id="dec" value="&lt;b&gt;Approve?&lt;/b&gt;&lt;br&gt;second&amp;nbsp;line" style="rhombus;whiteSpace=wrap;html=1;fontColor=#990000;fontSize=14;fontStyle=3;" vertex="1" parent="1">
      <mxGeometry x="200" y="30" width="120" height="100" as="geometry" />
    </mxCell>
    <mxCell id="db" value="Store" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;dashed=1;" vertex="1" parent="1">
      <mxGeometry x="400" y="40" width="60" height="80" as="geometry" />
    </mxCell>
    <mxCell id="doc" value="Report" style="shape=document;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="40" y="200" width="120" height="80" as="geometry" />
    </mxCell>
    <mxCell id="io" value="Input" style="shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="200" y="200" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="actor" value="User" style="shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;" vertex="1" parent="1">
      <mxGeometry x="400" y="200" width="30" height="60" as="geometry" />
    </mxCell>
    <mxCell id="txt" value="Just text" style="text;html=1;strokeColor=none;fillColor=none;" vertex="1" parent="1">
      <mxGeometry x="40" y="320" width="60" height="30" as="geometry" />
    </mxCell>
    <mxCell id="rr" value="Rounded" style="rounded=1;whiteSpace=wrap;html=1;arcSize=20;" vertex="1" parent="1">
      <mxGeometry x="200" y="320" width="100" height="50" as="geometry" />
    </mxCell>
    <mxCell id="lane" value="Lane A" style="swimlane;horizontal=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="40" y="420" width="500" height="160" as="geometry" />
    </mxCell>
    <mxCell id="inlane" value="Inside" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="lane">
      <mxGeometry x="60" y="40" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="grp" value="" style="group" vertex="1" connectable="0" parent="1">
      <mxGeometry x="600" y="40" width="200" height="100" as="geometry" />
    </mxCell>
    <mxCell id="g1" value="G1" style="whiteSpace=wrap;html=1;" vertex="1" parent="grp">
      <mxGeometry width="80" height="40" as="geometry" />
    </mxCell>
    <mxCell id="g2" value="G2" style="whiteSpace=wrap;html=1;" vertex="1" parent="grp">
      <mxGeometry x="120" y="60" width="80" height="40" as="geometry" />
    </mxCell>
    <mxCell id="weird" value="Mystery" style="shape=mxgraph.aws4.lambda;" vertex="1" parent="1">
      <mxGeometry x="600" y="200" width="60" height="60" as="geometry" />
    </mxCell>
    <object label="Linked" link="https://example.com" tooltip="Hover text" owner="ops" id="obj">
      <mxCell style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
        <mxGeometry x="600" y="320" width="100" height="40" as="geometry" />
      </mxCell>
    </object>
    <mxCell id="e1" value="" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;endFill=0;" edge="1" parent="1" source="start" target="dec">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
    <mxCell id="e1label" value="go" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e1">
      <mxGeometry x="-0.5" relative="1" as="geometry"><mxPoint as="offset" /></mxGeometry>
    </mxCell>
    <mxCell id="e2" value="yes" style="html=1;dashed=1;startArrow=ERmandOne;endArrow=ERzeroToMany;strokeColor=#ff0000;strokeWidth=2;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="dec" target="db">
      <mxGeometry relative="1" as="geometry">
        <Array as="points">
          <mxPoint x="360" y="80" />
          <mxPoint x="370" y="100" />
        </Array>
      </mxGeometry>
    </mxCell>
    <mxCell id="e3" style="curved=1;endArrow=oval;html=1;" edge="1" parent="1" source="inlane" target="doc">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
    <mxCell id="e4" style="endArrow=classic;" edge="1" parent="1" source="start">
      <mxGeometry relative="1" as="geometry"><mxPoint x="10" y="10" as="targetPoint" /></mxGeometry>
    </mxCell>
  </root>
</mxGraphModel>`

const FILE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- saved by diagrams.net -->
<mxfile host="app.diagrams.net" version="24.0.0">
  <diagram id="p1" name="Main flow">${MODEL}</diagram>
  <diagram id="p2" name="Second">${compress('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Alpha" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell><mxCell id="b" value="Beta ünïcode" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="60" height="60" as="geometry"/></mxCell><mxCell id="ab" value="link" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>')}</diagram>
</mxfile>`

describe('drawioToMap — a realistic file', () => {
  const { pages, warnings } = drawioToMap(FILE)
  const main = pages[0]!
  const n = byId(main.nodes)
  const e = byId(main.edges)

  it('reads every page with its name', () => {
    expect(pages.map((p) => p.name)).toEqual(['Main flow', 'Second'])
  })

  it('imports vertices with absolute geometry, labels and styles', () => {
    // group cell dissolves; edge-label cell is not a node
    expect(main.nodes.map((x) => x.id).sort()).toEqual(
      ['actor', 'db', 'dec', 'doc', 'g1', 'g2', 'inlane', 'io', 'lane', 'obj', 'rr', 'start', 'txt', 'weird'].sort()
    )
    expect(n.get('start')).toMatchObject({ x: 40, y: 40, width: 80, height: 80, label: 'Start', color: '#6c8ebf' })
    expect(n.get('start')!.style?.fill).toBe('#dae8fc')
    const dec = n.get('dec')!
    expect(dec.shape).toBe('decision')
    expect(dec.label).toBe('Approve?\nsecond line')
    expect(dec.style).toMatchObject({ textColor: '#990000', fontSize: 14, bold: true, italic: true })
    expect(['database', 'fc-database']).toContain(n.get('db')!.shape)
    expect(n.get('db')!.style?.strokeDash).toBe('dashed')
    expect(n.get('io')!.shape).toBe('data')
    expect(n.get('txt')!.shape).toBe('note')
    expect(n.get('rr')!.shape).toBe('process')
    expect(n.get('rr')!.style?.radius).toBeGreaterThan(0)
    for (const node of main.nodes) expect(isShapeId(node.shape)).toBe(true)
  })

  it('makes swimlanes containers and converts child geometry to absolute', () => {
    expect(n.get('lane')!.shape).toBe('lane')
    const inl = n.get('inlane')!
    expect(inl.parentId).toBe('lane')
    expect([inl.x, inl.y]).toEqual([100, 460])
  })

  it('dissolves groups into a shared groupId with absolute coordinates', () => {
    const g1 = n.get('g1')!
    const g2 = n.get('g2')!
    expect(g1.groupId).toBeDefined()
    expect(g1.groupId).toBe(g2.groupId)
    expect([g1.x, g1.y]).toEqual([600, 40])
    expect([g2.x, g2.y]).toEqual([720, 100])
  })

  it('imports <object> wrappers: label, link, tooltip, custom data', () => {
    const o = n.get('obj')!
    expect(o).toMatchObject({ label: 'Linked', link: 'https://example.com', description: 'Hover text' })
    expect(o.data).toEqual({ owner: 'ops' })
  })

  it('imports edges: arrows, routing, labels, waypoints, ports, colours', () => {
    const e1 = e.get('e1')!
    expect(e1).toMatchObject({ source: 'start', target: 'dec', routing: 'orthogonal', endArrow: 'triangle', label: 'go' })
    expect(e1.labelPos).toBeCloseTo(0.25)
    const e2 = e.get('e2')!
    expect(e2).toMatchObject({
      label: 'yes',
      dash: 'dashed',
      startArrow: 'crowOne',
      endArrow: 'crowZeroOrMany',
      stroke: '#ff0000',
      strokeWidth: 2,
      routing: 'straight',
      sourceHandle: 'right',
      targetHandle: 'left'
    })
    expect(e2.waypoints).toEqual([
      { x: 360, y: 80 },
      { x: 370, y: 100 }
    ])
    expect(e.get('e3')).toMatchObject({ routing: 'curved', endArrow: 'circle', source: 'inlane' })
  })

  it('warns about what it could not represent', () => {
    expect(e.has('e4')).toBe(false)
    expect(warnings.some((w) => /edge\(s\) without both/.test(w))).toBe(true)
    expect(warnings.some((w) => /mxgraph\.aws4\.lambda/.test(w))).toBe(true)
    expect(n.get('weird')!.shape).toBe('process')
  })

  it('decompresses compressed pages (base64 → deflate → URI-encoded XML)', () => {
    const p2 = pages[1]!
    expect(p2.nodes.map((x) => x.label)).toEqual(['Alpha', 'Beta ünïcode'])
    expect(p2.nodes[0]).toMatchObject({ x: 10, y: 20, width: 100, height: 40 })
    expect(p2.edges).toHaveLength(1)
    expect(p2.edges[0]).toMatchObject({ source: 'a', target: 'b', label: 'link', endArrow: 'arrow' })
  })
})

describe('drawioToMap — compressed fixture built in the test', () => {
  it('reads a page that is only compressed text', () => {
    const inner = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="s" value="Swim" style="swimlane;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="300" height="200" as="geometry"/></mxCell>
      <mxCell id="c" value="Child &amp; co" style="shape=hexagon;" vertex="1" parent="s"><mxGeometry x="20" y="40" width="100" height="60" as="geometry"/></mxCell>
      <mxCell id="d" value="Cloud" style="ellipse;shape=cloud;" vertex="1" parent="1"><mxGeometry x="500" y="100" width="120" height="80" as="geometry"/></mxCell>
      <mxCell id="x" edge="1" parent="1" source="c" target="d" style="endArrow=diamond;endFill=0;startArrow=dash;"><mxGeometry relative="1" as="geometry"/></mxCell>
      </root></mxGraphModel>`
    const file = `<mxfile><diagram name="Packed">${compress(inner)}</diagram></mxfile>`
    const { pages, warnings } = drawioToMap(file)
    expect(warnings.filter((w) => !/not supported/.test(w))).toEqual([])
    const p = pages[0]!
    expect(p.name).toBe('Packed')
    const m = byId(p.nodes)
    expect(m.get('s')!.shape).toBe('lane')
    expect(m.get('c')).toMatchObject({ x: 120, y: 140, label: 'Child & co', shape: 'hexagon', parentId: 's' })
    expect(p.edges[0]).toMatchObject({ endArrow: 'diamondOpen', startArrow: 'bar' })
  })

  it('accepts a bare mxGraphModel and URI-encoded (uncompressed) pages', () => {
    const bare = drawioToMap('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="1" y="2" width="30" height="40" as="geometry"/></mxCell></root></mxGraphModel>')
    expect(bare.pages[0]!.nodes[0]).toMatchObject({ id: 'a', x: 1, y: 2, width: 30, height: 40 })
    const enc = encodeURIComponent('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="z" value="Zed" vertex="1" parent="1"><mxGeometry x="5" y="5" width="50" height="50" as="geometry"/></mxCell></root></mxGraphModel>')
    const r = drawioToMap(`<mxfile><diagram name="E">${enc}</diagram></mxfile>`)
    expect(r.pages[0]!.nodes[0]!.label).toBe('Zed')
  })
})

describe('drawioToMap — malformed input warns, never throws', () => {
  const cases: [string, string][] = [
    ['empty', ''],
    ['not xml', 'hello world'],
    ['no model', '<mxfile><diagram name="x"></diagram></mxfile>'],
    ['bad base64', '<mxfile><diagram name="x">!!!not-base64-deflate!!!</diagram></mxfile>'],
    ['unclosed tags', '<mxfile><diagram name="x"><mxGraphModel><root><mxCell id="0"/><mxCell id="a" vertex="1" parent="0"><mxGeometry x="1"'],
    ['mismatched close', '<mxGraphModel><root></mxCell><mxCell id="a" value="A" vertex="1"/></root></mxGraphModel></nope>'],
    ['dangling edge', '<mxGraphModel><root><mxCell id="e" edge="1" source="nope" target="gone"/></root></mxGraphModel>']
  ]
  for (const [name, src] of cases) {
    it(name, () => {
      let r: ReturnType<typeof drawioToMap> | undefined
      expect(() => (r = drawioToMap(src))).not.toThrow()
      expect(r!.warnings.length).toBeGreaterThan(0)
    })
  }
  it('non-string input', () => {
    expect(() => drawioToMap(undefined as unknown as string)).not.toThrow()
  })
})

describe('XML and style helpers', () => {
  it('parses attributes with entities, quotes, self-closing tags, CDATA and comments', () => {
    const doc = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><a k='1 &gt; 0' v="&#x41;&#66;&quot;"><!-- c --><b/><c>t &amp; <![CDATA[<raw>]]></c></a>`)
    const a = doc.children[0]!
    expect(a.name).toBe('a')
    expect(a.attrs).toEqual({ k: '1 > 0', v: 'AB"' })
    expect(a.children.map((c) => c.name)).toEqual(['b', 'c'])
    expect(a.children[1]!.text).toBe('t & <raw>')
  })
  it('splits style strings into base names and key/values', () => {
    expect(parseStyle('ellipse;whiteSpace=wrap;html=1;fillColor=#fff;')).toEqual({
      base: ['ellipse'],
      s: { whiteSpace: 'wrap', html: '1', fillColor: '#fff' }
    })
  })
})

// ── export and round trip ───────────────────────────────────────────────────

function samplePages(): DrawioPage[] {
  const nodes: MapNode[] = [
    { id: 'lane', x: 0, y: 0, label: 'Sales <team> & "co"', shape: 'lane', color: '#64748b', width: 700, height: 220 },
    { id: 'a', x: 60, y: 40, label: 'Start', shape: 'terminator', color: '#16a34a', parentId: 'lane' },
    { id: 'b', x: 260, y: 30, label: 'Approve?\nTwo lines', shape: 'decision', color: '#dc2626', parentId: 'lane', style: { fill: '#fee2e2', fontSize: 15, bold: true } },
    { id: 'c', x: 480, y: 40, label: 'Store', shape: 'database', color: '#2563eb', parentId: 'lane', style: { strokeDash: 'dashed' } },
    { id: 'd', x: 40, y: 300, label: 'Rounded', shape: 'process', color: '#2563eb', style: { radius: 12, textColor: '#111827' }, width: 150, height: 60 },
    { id: 'e', x: 260, y: 300, label: 'Note text', shape: 'note', color: '#7c3aed' },
    { id: 'f', x: 420, y: 300, label: 'Flipped', shape: 'trapezoid', color: '#2563eb', flipY: true, rotation: 15 },
    { id: 'g', x: 600, y: 300, label: 'Linked', shape: 'process', color: '#2563eb', link: 'https://plexii.example', description: 'tip', data: { owner: 'ops' } },
    { id: 'h', x: 800, y: 300, label: 'Hidden', shape: 'circle', color: '#2563eb', hidden: true, locked: true },
    { id: '1', x: 900.5, y: 40.25, label: 'Id one', shape: 'hexagon', color: '#2563eb' }
  ]
  const edges: MapEdge[] = [
    { id: 'e1', source: 'a', target: 'b', label: 'submit', routing: 'orthogonal' },
    { id: 'e2', source: 'b', target: 'c', label: 'yes', dash: 'dashed', endArrow: 'crowZeroOrMany', startArrow: 'crowOne', stroke: '#ff0000', strokeWidth: 2 },
    { id: 'e3', source: 'b', target: 'd', label: 'no', routing: 'curved', waypoints: [{ x: 300, y: 250 }, { x: 120, y: 260 }], sourceHandle: 'bottom', targetHandle: 'p:0.25:0' },
    { id: 'e4', source: 'd', target: 'e', endArrow: 'triangle', routing: 'straight', labelPos: 0.25, label: 'later' },
    { id: 'e5', source: 'e', target: '1', endArrow: 'diamondOpen', startArrow: 'circle' }
  ]
  return [
    { name: 'Page <1>', nodes, edges },
    { name: 'Empty', nodes: [], edges: [] }
  ]
}

describe('mapToDrawio', () => {
  const xml = mapToDrawio(samplePages())

  it('writes a well-formed uncompressed mxfile diagrams.net can open', () => {
    expect(xml.startsWith('<mxfile')).toBe(true)
    expect(xml).toContain('compressed="false"')
    expect((xml.match(/<diagram /g) ?? []).length).toBe(2)
    expect(xml).toContain('name="Page &lt;1&gt;"')
    // structurally balanced
    const warnings: string[] = []
    parseXml(xml, warnings)
    expect(warnings).toEqual([])
    // swimlane child geometry is relative to the lane
    expect(xml).toMatch(/id="b"[^>]*parent="lane"/)
    expect(xml).toMatch(/<mxGeometry x="260" y="30"/)
    expect(xml).toContain('swimlane;horizontal=0;')
    expect(xml).toContain('rhombus;')
    expect(xml).toContain('shape=cylinder3')
    expect(xml).toContain('fillColor=#fee2e2')
    expect(xml).toContain('endArrow=ERzeroToMany')
    expect(xml).toContain('<Array as="points">')
    expect(xml).toContain('visible="0"')
    expect(xml).toContain('<UserObject label="Linked" link="https://plexii.example" tooltip="tip" owner="ops" id="g">')
    // a node id "1" must not collide with the layer cell
    expect(xml).not.toMatch(/<mxCell id="1" parent=/)
  })

  it('round-trips map → drawio → map preserving counts, labels, positions and styling', () => {
    const src = samplePages()
    const { pages, warnings } = drawioToMap(xml)
    expect(warnings).toEqual([])
    expect(pages.map((p) => p.name)).toEqual(src.map((p) => p.name))
    const before = src[0]!
    const after = pages[0]!
    expect(after.nodes).toHaveLength(before.nodes.length)
    expect(after.edges).toHaveLength(before.edges.length)
    const am = byId(after.nodes)
    for (const n of before.nodes) {
      const r = am.get(n.id)!
      expect(r, n.id).toBeDefined()
      expect(r.label).toBe(n.label)
      expect(r.shape).toBe(n.shape)
      expect(Math.abs(r.x - n.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(r.y - n.y)).toBeLessThanOrEqual(1)
      expect(r.color).toBe(n.color)
      expect(r.parentId).toBe(n.parentId)
      if (n.width) expect(r.width).toBe(n.width)
      expect(!!r.hidden).toBe(!!n.hidden)
      expect(!!r.locked).toBe(!!n.locked)
      expect(!!r.flipY).toBe(!!n.flipY)
      expect(r.rotation).toBe(n.rotation)
    }
    expect(am.get('b')!.style).toMatchObject({ fill: '#fee2e2', fontSize: 15, bold: true })
    expect(am.get('c')!.style?.strokeDash).toBe('dashed')
    expect(am.get('d')!.style).toMatchObject({ radius: 12, textColor: '#111827' })
    expect(am.get('g')).toMatchObject({ link: 'https://plexii.example', description: 'tip', data: { owner: 'ops' } })
    const ae = byId(after.edges)
    for (const e of before.edges) {
      const r = ae.get(e.id)!
      expect(r.source).toBe(e.source)
      expect(r.target).toBe(e.target)
      expect(r.label).toBe(e.label)
      expect(r.endArrow).toBe(e.endArrow ?? 'arrow')
      expect(r.startArrow).toBe(e.startArrow ?? 'none')
      expect(r.routing).toBe(e.routing ?? 'orthogonal')
      expect(r.waypoints).toEqual(e.waypoints)
    }
    expect(ae.get('e2')).toMatchObject({ dash: 'dashed', stroke: '#ff0000', strokeWidth: 2 })
    expect(ae.get('e3')).toMatchObject({ sourceHandle: 'bottom', targetHandle: 'p:0.25:0' })
    expect(ae.get('e4')!.labelPos).toBeCloseTo(0.25)
    expect(pages[1]!.nodes).toEqual([])
  })

  it('is stable: drawio → map → drawio gives the same XML', () => {
    const { pages } = drawioToMap(xml)
    expect(mapToDrawio(pages)).toBe(xml)
  })

  it('round-trips a compressed copy of its own output', () => {
    const models = [...xml.matchAll(/<mxGraphModel[\s\S]*?<\/mxGraphModel>/g)].map((m) => m[0])
    const packed = `<mxfile>${models.map((m, i) => `<diagram name="P${i}">${compress(m)}</diagram>`).join('')}</mxfile>`
    const r = drawioToMap(packed)
    expect(r.warnings).toEqual([])
    expect(r.pages[0]!.nodes).toHaveLength(samplePages()[0]!.nodes.length)
    expect(r.pages[0]!.nodes.find((n) => n.id === 'b')!.label).toBe('Approve?\nTwo lines')
  })
})

describe('mapToDrawio — every registered shape', () => {
  it('survives map → drawio → map with its id, size and position', () => {
    const nodes: MapNode[] = SHAPES.map((d, i) => ({
      id: `s${i}`,
      x: (i % 20) * 240,
      y: Math.floor(i / 20) * 200,
      label: d.label,
      shape: d.id,
      color: '#334155'
    }))
    const xml = mapToDrawio([{ name: 'All', nodes, edges: [] }])
    const { pages, warnings } = drawioToMap(xml)
    expect(warnings).toEqual([])
    const back = byId(pages[0]!.nodes)
    for (const n of nodes) {
      const r = back.get(n.id)!
      expect(r.shape, n.shape).toBe(n.shape)
      expect(r.label).toBe(n.label)
      expect([r.x, r.y]).toEqual([n.x, n.y])
      const def = SHAPES.find((d) => d.id === n.shape)!
      expect([r.width, r.height]).toEqual([def.w, def.h])
    }
  })
})
