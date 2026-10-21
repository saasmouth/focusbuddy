// 4.3.40 PlexiiDiagrams fixes. Each test fails without its fix.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { drawioToMap, mapToDrawio } from '../../src/shared/diagram/drawio'
import * as ops from '../../src/shared/diagram/ops'
import { mapToSvg } from '../../src/shared/mapExport'
import type { MapBody } from '../../src/shared/types'

// A draw.io file with the default layer, a HIDDEN layer "Notes" holding one
// shape, a visible locked layer, and one shape individually hidden.
const xml = `<mxfile><diagram name="P"><mxGraphModel><root>
  <mxCell id="0" />
  <mxCell id="1" parent="0" />
  <mxCell id="L2" value="Notes" parent="0" visible="0" />
  <mxCell id="L3" value="Frame" style="locked=1;" parent="0" />
  <mxCell id="a" value="Visible" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry" /></mxCell>
  <mxCell id="b" value="On hidden layer" style="rounded=1;" vertex="1" parent="L2"><mxGeometry x="200" y="0" width="120" height="60" as="geometry" /></mxCell>
  <mxCell id="c" value="On locked layer" style="rounded=1;" vertex="1" parent="L3"><mxGeometry x="400" y="0" width="120" height="60" as="geometry" /></mxCell>
  <mxCell id="d" value="Own hidden" style="rounded=1;" vertex="1" parent="1" visible="0"><mxGeometry x="600" y="0" width="120" height="60" as="geometry" /></mxCell>
  <mxCell id="e1" edge="1" parent="L2" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
</root></mxGraphModel></diagram></mxfile>`

describe('4a: hidden draw.io content is recoverable', () => {
  const page = drawioToMap(xml).pages[0]!
  const node = (id: string) => page.nodes.find((n) => n.id === id)!

  it('a hidden draw.io layer becomes a hidden LAYER, not hidden shapes', () => {
    const notes = page.layers?.find((l) => l.name === 'Notes')
    expect(notes).toMatchObject({ visible: false, locked: false })
    expect(node('b').layerId).toBe(notes!.id)
    expect(node('b').hidden).toBeUndefined() // the layer hides it; showing the layer shows it
    expect(page.edges.find((e) => e.id === 'e1')!.layerId).toBe(notes!.id)
  })

  it('a locked draw.io layer becomes a locked layer; the default layer stays the base', () => {
    const frame = page.layers?.find((l) => l.name === 'Frame')
    expect(frame).toMatchObject({ visible: true, locked: true })
    expect(node('c').layerId).toBe(frame!.id)
    expect(node('c').locked).toBeUndefined()
    expect(node('a').layerId).toBeUndefined()
    expect(page.layers).toHaveLength(2)
  })

  it('a shape hidden on its own is hidden, and Show all hidden brings it back', () => {
    expect(node('d').hidden).toBe(true)
    const g = { nodes: page.nodes, edges: page.edges }
    expect(ops.hiddenCount(g)).toBe(1)
    const shown = ops.showAllHidden(g)
    expect(ops.hiddenCount(shown)).toBe(0)
    expect(shown.nodes.find((n) => n.id === 'd')!.hidden).toBeUndefined()
  })

  it('Hide shape hides only the chosen shapes, recoverably', () => {
    const g = { nodes: page.nodes.map((n) => ({ ...n, hidden: undefined })), edges: page.edges }
    const hidden = ops.setHidden(g, new Set(['a']), true)
    expect(hidden.nodes.filter((n) => n.hidden).map((n) => n.id)).toEqual(['a'])
    expect(ops.hiddenCount(ops.showAllHidden(hidden))).toBe(0)
  })

  it('export keeps hidden-layer shapes hidden (round trip does not reveal them)', () => {
    const out = mapToDrawio([{ name: 'P', nodes: page.nodes, edges: page.edges, layers: page.layers }])
    const cellFor = (label: string): string => out.split('\n').find((l) => l.includes(`value="${label}"`)) ?? ''
    expect(cellFor('On hidden layer')).toContain('visible="0"')
    expect(cellFor('Visible')).not.toContain('visible="0"')
  })

  it('the hide/show controls are wired into the editor', () => {
    const d = (f: string) => readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram', f), 'utf-8')
    expect(d('ContextMenu.tsx')).toContain('run: cmd.hideSelection')
    expect(d('LayersPanel.tsx')).toContain('data-testid="diagram-show-hidden"')
    expect(d('DiagramChrome.tsx')).toContain('run: cmd.showAllHidden')
  })
})

describe('4b: changing the page default arrow never rewrites existing lines', () => {
  it('a new line saves its end arrow explicitly, even the default "arrow"', () => {
    expect(ops.newEdgeDefaults({})).toEqual({ routing: 'orthogonal', endArrow: 'arrow' })
    expect(ops.newEdgeDefaults({ defaultEndArrow: 'none', defaultRouting: 'curved' })).toEqual({ routing: 'curved', endArrow: 'none' })
  })

  it('an existing line with no saved arrow keeps its arrowhead when the page default changes', () => {
    const body: MapBody = {
      version: 1,
      nodes: [
        { id: 'a', x: 0, y: 0, label: 'A', shape: 'process', color: '#2563eb' },
        { id: 'b', x: 300, y: 0, label: 'B', shape: 'process', color: '#2563eb' }
      ],
      edges: [{ id: 'old', source: 'a', target: 'b' }],
      settings: { defaultEndArrow: 'none' }
    }
    expect((mapToSvg(body).svg.match(/class="pd-arrowhead"/g) ?? []).length).toBe(1)
  })

  it('the canvas draws lines the same way (no page default at render time)', () => {
    const edge = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/DiagramEdge.tsx'), 'utf-8')
    expect(edge).not.toContain('settings.defaultEndArrow')
    const ed = readFileSync(join(__dirname, '../../src/renderer/src/components/documents/diagram/DiagramEditor.tsx'), 'utf-8')
    expect(ed).toContain('...ops.newEdgeDefaults(settings)')
  })
})
