import { useMemo, type MutableRefObject } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import type { MapBody, MapEdge, MapLayer, MapNode, MapNodeStyle, MapSettings } from '@shared/types'
import { getShape } from '@shared/diagram/shapes'
import { nodeBox, nodeSize } from '@shared/diagram/geom'
import * as ops from '@shared/diagram/ops'
import { getPage, withPage, addPage, renamePage, deletePage, movePage, pageList } from '@shared/diagram/pages'
import type { History } from '@shared/diagram/history'
import type { LiveUndo } from '../../../lib/yjsKeyedJson'
import type { DiagramTheme } from '@shared/diagram/style'
import { tidyConnections } from '@shared/diagram/tidy'
import { layoutDiagram, type LayoutAlgorithm } from '@shared/diagram/layout'
import { mermaidToMap, mapToMermaid } from '@shared/diagram/mermaid'
import { drawioToMap, mapToDrawio } from '@shared/diagram/drawio'
import { generateFromTable, type GenerateOptions } from '@shared/diagram/data'
import { normalizeMapBody } from '@shared/mapGraph'
import { fresh } from '@shared/diagram/sharedRefs'
import { alignBoxes, distributeBoxes, type AlignEdge } from '../map/mapAlign'
import { mapTemplate, type MapTemplateId } from '../map/mapTemplates'
import { shortcutKey } from './keys'
import { diagramBodyFromSelection, placeDiagramSnippet } from './diagramSnippets'
import type { DiagramSnippetBody } from '@shared/snippets'
import type { QuickDir } from './DiagramContext'
import type { Tool } from './DiagramEditor'
import { readClipboardForms } from '../../../lib/clipboardForms'
import { fromAnotherApp, pasteConverted } from '../../../lib/clipboardPaste'

// Every editor action in one place. Menus, the toolbar, keyboard shortcuts, the
// context menu and the inspector all call these, so an action behaves the same
// however it is reached.

interface Deps {
  rf: ReactFlowInstance
  // Width of the pinned overlay panels on the canvas's left (SPEC §2.4): Fit
  // and zoom-to-selection centre the drawing in what is actually visible.
  fitInset: MutableRefObject<number>
  bodyRef: MutableRefObject<MapBody>
  pageIdxRef: MutableRefObject<number>
  selRef: MutableRefObject<ops.Sel>
  setSel: (s: ops.Sel) => void
  update: (fn: (g: ops.Graph) => ops.Graph, key?: string | false) => void
  updateBody: (fn: (b: MapBody) => MapBody, key?: string | false) => void
  setBody: (b: MapBody) => void
  history: MutableRefObject<History<MapBody>>
  // Present in a live shared document: undo/redo go through it instead.
  liveUndo: MutableRefObject<LiveUndo | undefined>
  flush: () => void
  styleClip: MutableRefObject<Partial<MapNodeStyle> | null>
  pasteOffset: MutableRefObject<number>
  setHistoryTick: (fn: (n: number) => number) => void
  setEditingId: (id: string | null) => void
  setPageIdx: (i: number) => void
  newEdge: (s: string, t: string, sh: string | null, th: string | null) => MapEdge
  theme: DiagramTheme
  settings: MapSettings
  title: string
  wrapRef: MutableRefObject<HTMLDivElement | null>
}

export type Commands = ReturnType<typeof makeCommands>

export function useDiagramCommands(d: Deps): Commands {
  // Stable across renders except when the theme/settings it reads change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => makeCommands(d), [d.theme, d.settings, d.title, d.newEdge, d.update, d.updateBody])
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function makeCommands(d: Deps) {
  const page = (): ops.Graph => getPage(d.bodyRef.current, d.pageIdxRef.current)
  const sel = (): ops.Sel => d.selRef.current
  // Copied style and the repeat-paste offset are the editor's, held in refs:
  // the command object can be rebuilt (a theme or settings change) between a
  // copy and its paste, and closure variables here would be lost with it.
  const styleClip = d.styleClip
  const pasteOffset = d.pasteOffset

  const viewportCenter = (): { x: number; y: number } => {
    const r = d.wrapRef.current?.getBoundingClientRect()
    if (!r) return { x: 200, y: 160 }
    return d.rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  const grid = (): number => (d.settings.snap === false ? 1 : d.settings.gridSize ?? 16)
  const snap = (v: number): number => Math.round(v / grid()) * grid()

  const selectNodes = (ids: string[], edges: string[] = []): void => d.setSel({ nodes: new Set(ids), edges: new Set(edges) })

  function makeNode(shapeId: string, center: { x: number; y: number }, extra: Partial<MapNode> = {}): MapNode {
    const def = getShape(shapeId)
    const w = extra.width ?? def.w
    const h = extra.height ?? def.h
    return {
      id: ops.uid('n'),
      x: snap(center.x - w / 2),
      y: snap(center.y - h / 2),
      label: def.defaultLabel ?? (def.special === 'icon' || def.special === 'image' || def.special === 'widget' ? (def.special === 'icon' ? def.label : '') : def.special === 'table' ? '' : def.label),
      shape: def.id,
      color: def.color ?? d.theme.palette[0] ?? '#2563eb',
      ...extra
    }
  }

  function add(nodes: MapNode[], edges: MapEdge[] = [], edit = false): void {
    // Containers go to the back so shapes dropped on them stay on top.
    d.update((g) => {
      const containers = nodes.filter((n) => getShape(n.shape).container)
      const rest = nodes.filter((n) => !getShape(n.shape).container)
      return ops.assignContainers({ ...g, nodes: [...containers, ...g.nodes, ...rest], edges: [...g.edges, ...edges] }, nodes.map((n) => n.id))
    })
    selectNodes(nodes.map((n) => n.id), edges.map((e) => e.id))
    if (edit && nodes.length === 1) window.setTimeout(() => d.setEditingId(nodes[0]!.id), 30)
  }

  type Pct = `${number}%`
  type Px = `${number}px`
  const insetPadding = (pct: number): { top: Pct; right: Pct; bottom: Pct; left: Pct | Px } => ({
    top: `${pct}%`,
    right: `${pct}%`,
    bottom: `${pct}%`,
    left: d.fitInset.current > 0 ? `${Math.round(d.fitInset.current + 24)}px` : `${pct}%`
  })
  const fit = (): void => void d.rf.fitView({ padding: insetPadding(10), duration: 250 })

  const cmds = {
    // ── create ────────────────────────────────────────────────────────────
    addShape(shapeId: string, opts: { center?: { x: number; y: number }; edit?: boolean; size?: { w: number; h: number } } = {}): string {
      const center = opts.center ?? viewportCenter()
      // Stagger repeated clicks so new shapes don't stack invisibly.
      const occupied = page().nodes.some((n) => Math.abs(n.x + nodeSize(n).w / 2 - center.x) < 6 && Math.abs(n.y + nodeSize(n).h / 2 - center.y) < 6)
      const c = occupied && !opts.center ? { x: center.x + 24, y: center.y + 24 } : center
      // An armed shape dragged out on the canvas takes the dragged size (SPEC §3.2).
      const n = makeNode(shapeId, c, opts.size ? { width: Math.max(16, Math.round(opts.size.w)), height: Math.max(12, Math.round(opts.size.h)) } : {})
      add([n], [], opts.edit)
      return n.id
    },
    addIcon(name: string, center = viewportCenter()): void {
      add([makeNode('icon', center, { icon: name, label: name.replace(/_/g, ' ') })])
    },
    async addImageFiles(files: File[], center = viewportCenter()): Promise<void> {
      const imgs = files.filter((f) => f.type.startsWith('image/')).slice(0, 10)
      const nodes: MapNode[] = []
      for (const [i, f] of imgs.entries()) {
        if (f.size > 2_500_000) {
          window.alert(`${f.name} is larger than 2.5 MB. Use a smaller image, or a link to it.`)
          continue
        }
        const url = await readAsDataUrl(f)
        const dims = await imageSize(url)
        const k = Math.min(1, 320 / Math.max(dims.w, dims.h))
        nodes.push(makeNode(imageShapeId(), { x: center.x + i * 24, y: center.y + i * 24 }, { image: url, label: '', width: Math.round(dims.w * k), height: Math.round(dims.h * k) }))
      }
      if (nodes.length) add(nodes)
    },
    addImageUrl(url: string, center = viewportCenter()): void {
      add([makeNode(imageShapeId(), center, { image: url, label: '', width: 240, height: 160 })])
    },
    addWidget(widgetId: string, at?: { x: number; y: number }): void {
      add([makeNode('widget', at ?? viewportCenter(), { widgetId, label: '' })])
    },
    // A batch from a dialog (apps, tools, data cards), laid out from 0,0; it is
    // moved into clear space below the existing shapes.
    addNodes(nodes: MapNode[], edges: MapEdge[] = []): void {
      add(ops.placeBelow(page().nodes, nodes), edges)
      fit()
    },
    // Quick-add from the arrows around a selected shape.
    quickAdd(id: string, dir: QuickDir): void {
      const g = page()
      const from = g.nodes.find((n) => n.id === id)
      if (!from) return
      const size = nodeSize(from)
      const pos = ops.slotBeside(g, from, dir, size)
      const n: MapNode = { ...makeNode(from.shape, { x: 0, y: 0 }), x: pos.x, y: pos.y, width: from.width, height: from.height, color: from.color, ...(from.style ? { style: fresh(from.style) } : {}), label: getShape(from.shape).defaultLabel ?? '' }
      const side = { up: 'top', right: 'right', down: 'bottom', left: 'left' }[dir]
      const opp = { up: 'bottom', right: 'left', down: 'top', left: 'right' }[dir]
      add([n], [d.newEdge(from.id, n.id, side, opp)], true)
    },
    // A connector dropped on empty canvas: make the chosen shape there and connect.
    addConnected(sourceId: string, sourceHandle: string | null, shapeId: string, at: { x: number; y: number }): void {
      const n = makeNode(shapeId, at)
      add([n], [d.newEdge(sourceId, n.id, sourceHandle, null)], true)
    },

    // ── text ──────────────────────────────────────────────────────────────
    commitLabel(id: string, label: string): void {
      if (id.startsWith('edge:')) {
        const eid = id.slice(5)
        const cur = page().edges.find((e) => e.id === eid)
        if (!cur || (cur.label ?? '') === label) return
        d.update((g) => ops.patchEdges(g, new Set([eid]), () => ({ label: label || undefined })))
        return
      }
      const cur = page().nodes.find((n) => n.id === id)
      if (!cur || cur.label === label) return
      d.update((g) => ops.patchNodes(g, new Set([id]), () => ({ label })))
    },
    commitCell(id: string, r: number, c: number, text: string): void {
      const n = page().nodes.find((x) => x.id === id)
      if (!n) return
      const m = /(\d+)x(\d+)/.exec(n.shape)
      const rows = Math.max(n.cells?.length ?? 0, m ? Number(m[2]) : 3, r + 1)
      const cols = Math.max(...(n.cells ?? [[]]).map((x) => x.length), m ? Number(m[1]) : 3, c + 1)
      const cells = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => n.cells?.[i]?.[j] ?? ''))
      if (cells[r]![c] === text) return
      cells[r]![c] = text
      d.update((g) => ops.patchNodes(g, new Set([id]), () => ({ cells })), `cell:${id}`)
    },
    editSelected(): void {
      const [id] = sel().nodes
      if (sel().nodes.size === 1 && id) d.setEditingId(id)
      else if (sel().edges.size === 1) d.setEditingId(`edge:${[...sel().edges][0]}`)
    },

    // ── selection & clipboard ────────────────────────────────────────────
    selectAll(): void {
      d.setSel(ops.selectAll(page()))
    },
    clearSelection(): void {
      d.setSel(ops.emptySel())
      d.setEditingId(null)
    },
    select(nodes: string[], edges: string[] = []): void {
      selectNodes(nodes, edges)
    },
    deleteSelection(): void {
      const s = sel()
      if (!s.nodes.size && !s.edges.size) return
      d.update((g) => ops.deleteSelection(g, s))
      d.setSel(ops.emptySel())
    },
    copy(data: DataTransfer | null): boolean {
      const s = sel()
      if (!s.nodes.size) return false
      const clip = ops.copySelection(page(), s)
      pasteOffset.current = 0
      const json = JSON.stringify(clip)
      try {
        data?.setData('text/plain', json)
        data?.setData('application/x-plexii-diagram', json)
      } catch {
        /* ignore */
      }
      ;(window as unknown as { __plexiiDiagramClip?: string }).__plexiiDiagramClip = json
      return true
    },
    async paste(data: DataTransfer | null): Promise<void> {
      // Another of our apps' content (a Cells range, a Deck/Design selection,
      // a drawing, a Write fragment) lands as a converted diagram snippet
      // would: a table shape, an image shape, notes. Diagrams' own copies and
      // everything else keep the paste below, unchanged.
      const read = await readClipboardForms(data)
      if (fromAnotherApp(read, 'diagram')) {
        await pasteConverted('diagram', (b) => b.kind === 'diagram' && cmds.insertSnippetBody(b), { read })
        return
      }
      const files = data ? [...data.files].filter((f) => f.type.startsWith('image/')) : []
      if (files.length) return cmds.addImageFiles(files)
      const text = data?.getData('application/x-plexii-diagram') || data?.getData('text/plain') || (window as unknown as { __plexiiDiagramClip?: string }).__plexiiDiagramClip || ''
      if (!text.trim()) return
      try {
        const parsed = JSON.parse(text)
        if (ops.isClip(parsed)) {
          pasteOffset.current += 24
          const { graph, sel: s } = ops.pasteClip(page(), parsed, { x: pasteOffset.current, y: pasteOffset.current })
          d.update(() => graph)
          d.setSel(s)
          return
        }
      } catch {
        /* not JSON */
      }
      if (/^\s*(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/m.test(text) || /^\s*(erDiagram|classDiagram)\b/m.test(text)) {
        cmds.importMermaid(text, 'add')
        return
      }
      if (/^\s*https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?\s*$/i.test(text)) {
        cmds.addImageUrl(text.trim())
        return
      }
      // Plain text: one note per line (up to 50), stacked.
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50)
      const c = viewportCenter()
      add(lines.map((l, i) => makeNode(lines.length > 1 ? 'process' : 'note', { x: c.x, y: c.y + i * 64 }, { label: l })))
    },
    duplicate(): void {
      if (!sel().nodes.size) return
      const { graph, sel: s } = ops.duplicate(page(), sel())
      d.update(() => graph)
      d.setSel(s)
    },

    // ── saved snippets (diagramSnippets.ts) ───────────────────────────────
    // The selection as a snippet body, or null when no shape is selected.
    snippetBody(): DiagramSnippetBody | null {
      return diagramBodyFromSelection(page(), sel())
    },
    // Insert a saved fragment like a paste: fresh ids, centred in view, one
    // undo step, selected afterwards. False when there was nothing to place.
    insertSnippetBody(body: DiagramSnippetBody): boolean {
      const placed = placeDiagramSnippet(page(), body, viewportCenter(), grid())
      if (!placed) return false
      d.update(() => placed.graph)
      d.setSel(placed.sel)
      return true
    },

    // ── history ──────────────────────────────────────────────────────────
    undo(): void {
      const live = d.liveUndo.current
      if (live) {
        // Reverse only our own last step; the result arrives back through the
        // live document like a collaborator's change and is folded in.
        d.flush()
        live.undo()
        d.setSel(ops.emptySel())
        return
      }
      const prev = d.history.current.undo(d.bodyRef.current)
      if (!prev) return
      d.setBody(prev)
      d.setHistoryTick((t) => t + 1)
      d.setSel(ops.emptySel())
    },
    redo(): void {
      const live = d.liveUndo.current
      if (live) {
        d.flush()
        live.redo()
        d.setSel(ops.emptySel())
        return
      }
      const next = d.history.current.redo(d.bodyRef.current)
      if (!next) return
      d.setBody(next)
      d.setHistoryTick((t) => t + 1)
      d.setSel(ops.emptySel())
    },

    // ── arrange ──────────────────────────────────────────────────────────
    group(): void {
      d.update((g) => ops.group(g, sel().nodes).graph)
    },
    ungroup(): void {
      d.update((g) => ops.ungroup(g, sel().nodes))
    },
    setLocked(locked: boolean): void {
      d.update((g) => ops.setLocked(g, sel(), locked))
    },
    // Hide the selected shapes; "Show all hidden" (Layers panel, Arrange menu)
    // brings them back.
    hideSelection(): void {
      const ids = sel().nodes
      if (!ids.size) return
      d.update((g) => ops.setHidden(g, ids, true))
      d.setSel(ops.emptySel())
    },
    showAllHidden(): void {
      d.update((g) => ops.showAllHidden(g))
    },
    toggleLock(): void {
      const g = page()
      const anyUnlocked = g.nodes.some((n) => sel().nodes.has(n.id) && !n.locked) || g.edges.some((e) => sel().edges.has(e.id) && !e.locked)
      cmds.setLocked(anyUnlocked)
    },
    order(how: 'front' | 'back' | 'forward' | 'backward'): void {
      d.update((g) => ops.reorder(g, sel().nodes, how))
    },
    align(edge: AlignEdge): void {
      d.update((g) => {
        const boxes = g.nodes.filter((n) => sel().nodes.has(n.id) && !n.locked).map((n) => nodeBox(n))
        const moves = alignBoxes(boxes, edge)
        return { ...g, nodes: g.nodes.map((n) => (moves.has(n.id) ? { ...n, x: Math.round(moves.get(n.id)!.x), y: Math.round(moves.get(n.id)!.y) } : n)) }
      })
    },
    distribute(axis: 'h' | 'v'): void {
      d.update((g) => {
        const boxes = g.nodes.filter((n) => sel().nodes.has(n.id) && !n.locked).map((n) => nodeBox(n))
        const moves = distributeBoxes(boxes, axis)
        return { ...g, nodes: g.nodes.map((n) => (moves.has(n.id) ? { ...n, x: Math.round(moves.get(n.id)!.x), y: Math.round(moves.get(n.id)!.y) } : n)) }
      })
    },
    matchSize(which: 'width' | 'height' | 'both'): void {
      d.update((g) => ops.matchSize(g, [...sel().nodes], which))
    },
    flip(axis: 'x' | 'y'): void {
      d.update((g) => ops.flip(g, sel().nodes, axis))
    },
    rotate(deg: number): void {
      d.update((g) => ops.rotateBy(g, sel().nodes, deg))
    },
    nudge(dx: number, dy: number): void {
      if (!sel().nodes.size) return
      d.update((g) => ops.nudge(g, sel().nodes, dx, dy), 'nudge')
    },

    // ── properties (inspector) ───────────────────────────────────────────
    setStyle(patch: Partial<MapNodeStyle>, key?: string): void {
      d.update((g) => ops.patchStyle(g, sel().nodes, patch), key)
    },
    setNodes(patch: Partial<MapNode>, key?: string): void {
      d.update((g) => ops.patchNodes(g, sel().nodes, () => patch), key)
    },
    setNode(id: string, patch: Partial<MapNode>, key?: string): void {
      d.update((g) => ops.patchNodes(g, new Set([id]), () => patch), key)
    },
    setEdges(patch: Partial<MapEdge>, key?: string): void {
      d.update((g) => ops.patchEdges(g, sel().edges, () => patch), key)
    },
    setGeometry(id: string, patch: { x?: number; y?: number; width?: number; height?: number; rotation?: number }, key?: string): void {
      d.update((g) => {
        const n = g.nodes.find((x) => x.id === id)
        if (!n) return g
        const moved = ops.patchNodes(g, new Set([id]), () => patch)
        // Moving a container moves its contents with it.
        if ((patch.x !== undefined && patch.x !== n.x) || (patch.y !== undefined && patch.y !== n.y)) {
          const dx = (patch.x ?? n.x) - n.x
          const dy = (patch.y ?? n.y) - n.y
          const kids = ops.descendants(g, [id])
          return { ...moved, nodes: moved.nodes.map((m) => (kids.has(m.id) ? { ...m, x: m.x + dx, y: m.y + dy } : m)) }
        }
        return moved
      }, key)
    },
    copyStyle(): void {
      const n = page().nodes.find((x) => sel().nodes.has(x.id))
      styleClip.current = n ? { ...(n.style ?? {}), stroke: n.style?.stroke ?? n.color } : null
    },
    pasteStyle(): void {
      if (styleClip.current) cmds.setStyle(styleClip.current)
    },
    hasStyleClipboard: (): boolean => !!styleClip.current,
    setSettings(patch: Partial<MapSettings>, key?: string): void {
      d.updateBody((b) => {
        const s: MapSettings = { ...(b.settings ?? {}), ...patch }
        for (const k of Object.keys(s) as (keyof MapSettings)[]) if (s[k] === undefined) delete s[k]
        return { ...b, settings: Object.keys(s).length ? s : undefined }
      }, key)
    },
    // Restyle every shape to the theme: clears per-shape colours and fills.
    applyThemeToAll(themeId: string): void {
      d.updateBody((b) => {
        const restyle = (g: ops.Graph): ops.Graph => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const st = { ...(n.style ?? {}) }
            delete st.fill
            delete st.stroke
            delete st.textColor
            delete st.fillOpacity
            return { ...n, style: Object.keys(st).length ? st : undefined }
          }),
          edges: g.edges.map((e) => ({ ...e, stroke: undefined, textColor: undefined }))
        })
        let out: MapBody = { ...b, settings: { ...(b.settings ?? {}), theme: themeId, background: undefined } }
        const all = pageList(out).length
        for (let i = 0; i < all; i++) out = withPage(out, i, restyle(getPage(out, i)))
        return normalizeMapBody(out)
      })
    },

    // ── automation ───────────────────────────────────────────────────────
    tidyConnections(): string {
      const g = page()
      const scope = sel().nodes.size > 1 ? sel().nodes : null
      const res = tidyConnections(
        g.nodes,
        scope ? g.edges.filter((e) => scope.has(e.source) || scope.has(e.target)) : g.edges,
        { gridSize: d.settings.snap === false ? undefined : d.settings.gridSize ?? 16 }
      )
      const tidied = new Map(res.edges.map((e) => [e.id, e]))
      d.update((pg) => ({ ...pg, nodes: res.nodes, edges: pg.edges.map((e) => tidied.get(e.id) ?? e) }))
      const c = res.changes
      return `Tidied: ${c.edgesRerouted} line${c.edgesRerouted === 1 ? '' : 's'} rerouted, ${c.portsReassigned} connection point${c.portsReassigned === 1 ? '' : 's'} reassigned, ${c.nodesNudged} shape${c.nodesNudged === 1 ? '' : 's'} straightened, ${c.overlapsResolved} overlap${c.overlapsResolved === 1 ? '' : 's'} fixed.`
    },
    layout(algorithm: LayoutAlgorithm, direction: 'TB' | 'LR' | 'BT' | 'RL' = 'TB'): void {
      const g = page()
      const only = sel().nodes.size > 1 ? [...sel().nodes] : undefined
      const laid = layoutDiagram(g.nodes, g.edges, { algorithm, direction, ...(only ? { onlyIds: only } : {}) })
      d.update((pg) => {
        const pos = new Map(laid.map((n) => [n.id, n]))
        // A re-layout makes manual bends meaningless; let the router redo them.
        // Position, and size for a container the layout grew to hold what is inside it.
        const apply = (n: MapNode): MapNode => {
          const l = pos.get(n.id)
          if (!l) return n
          const out: MapNode = { ...n, x: l.x, y: l.y }
          if (l.width !== n.width) out.width = l.width
          if (l.height !== n.height) out.height = l.height
          return out
        }
        return { ...pg, nodes: pg.nodes.map(apply), edges: pg.edges.map((e) => ({ ...e, waypoints: undefined })) }
      })
      window.setTimeout(fit, 60)
    },

    // ── view ─────────────────────────────────────────────────────────────
    fit,
    zoomIn: (): void => void d.rf.zoomIn({ duration: 150 }),
    zoomOut: (): void => void d.rf.zoomOut({ duration: 150 }),
    zoomTo: (z: number): void => void d.rf.zoomTo(z, { duration: 150 }),
    zoomToSelection(): void {
      const ids = [...sel().nodes]
      if (ids.length) void d.rf.fitView({ nodes: ids.map((id) => ({ id })), padding: insetPadding(20), duration: 250 })
    },
    focusNode(id: string): void {
      selectNodes([id])
      void d.rf.fitView({ nodes: [{ id }], padding: 1.2, duration: 250, maxZoom: 1.5 })
    },

    // ── pages ────────────────────────────────────────────────────────────
    gotoPage: (i: number): void => d.setPageIdx(i),
    addPage(): void {
      const n = pageList(d.bodyRef.current).length + 1
      const { body, index } = addPage(d.bodyRef.current, `Page ${n}`, ops.uid('page-'))
      d.updateBody(() => body)
      d.setPageIdx(index)
    },
    duplicatePage(i: number): void {
      const src = getPage(d.bodyRef.current, i)
      const name = `${pageList(d.bodyRef.current)[i]?.name ?? 'Page'} copy`
      const { body, index } = addPage(d.bodyRef.current, name, ops.uid('page-'), ops.copyPage(src))
      d.updateBody(() => body)
      d.setPageIdx(index)
    },
    renamePage(i: number, name: string): void {
      d.updateBody((b) => renamePage(b, i, name))
    },
    deletePage(i: number): void {
      if (pageList(d.bodyRef.current).length < 2) return
      d.updateBody((b) => deletePage(b, i))
      d.setPageIdx(Math.max(0, Math.min(i, pageList(d.bodyRef.current).length - 1) - (i > 0 ? 1 : 0)))
    },
    movePage(from: number, to: number): void {
      d.updateBody((b) => movePage(b, from, to))
      d.setPageIdx(to)
    },

    // ── layers ───────────────────────────────────────────────────────────
    addLayer(name?: string): string {
      const id = ops.uid('layer-')
      d.update((g) => {
        const layers: MapLayer[] = g.layers?.length ? [...g.layers] : [{ id: 'layer-base', name: 'Base', visible: true, locked: false }]
        layers.push({ id, name: name || `Layer ${layers.length + 1}`, visible: true, locked: false })
        return { ...g, layers }
      })
      return id
    },
    updateLayer(id: string, patch: Partial<MapLayer>): void {
      d.update((g) => ({ ...g, layers: (g.layers ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)) }))
    },
    deleteLayer(id: string): void {
      d.update((g) => ({
        ...g,
        layers: (g.layers ?? []).filter((l) => l.id !== id),
        nodes: g.nodes.map((n) => (n.layerId === id ? { ...n, layerId: undefined } : n)),
        edges: g.edges.map((e) => (e.layerId === id ? { ...e, layerId: undefined } : e))
      }))
    },
    moveSelectionToLayer(id: string | undefined): void {
      d.update((g) => ops.patchEdges(ops.patchNodes(g, sel().nodes, () => ({ layerId: id })), sel().edges, () => ({ layerId: id })))
    },

    // ── find ─────────────────────────────────────────────────────────────
    find(query: string, opts: { caseSensitive?: boolean } = {}): { id: string; kind: 'node' | 'edge'; text: string }[] {
      if (!query) return []
      const q = opts.caseSensitive ? query : query.toLowerCase()
      const has = (t: string | undefined): boolean => !!t && (opts.caseSensitive ? t : t.toLowerCase()).includes(q)
      const g = page()
      return [
        ...g.nodes.filter((n) => has(n.label) || has(n.description) || Object.values(n.data ?? {}).some(has) || n.cells?.some((r) => r.some(has))).map((n) => ({ id: n.id, kind: 'node' as const, text: n.label })),
        ...g.edges.filter((e) => has(e.label)).map((e) => ({ id: e.id, kind: 'edge' as const, text: e.label ?? '' }))
      ]
    },
    replaceAll(query: string, replacement: string, opts: { caseSensitive?: boolean } = {}): number {
      if (!query) return 0
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi')
      let count = 0
      const rep = (t: string): string =>
        t.replace(re, () => {
          count++
          return replacement
        })
      d.update((g) => ({
        ...g,
        nodes: g.nodes.map((n) => ({ ...n, label: rep(n.label), ...(n.cells ? { cells: n.cells.map((r) => r.map(rep)) } : {}) })),
        edges: g.edges.map((e) => (e.label ? { ...e, label: rep(e.label) } : e))
      }))
      return count
    },

    // ── templates, import, export ───────────────────────────────────────
    applyTemplate(id: MapTemplateId, mode: 'replace' | 'add' = 'replace'): void {
      const tpl = normalizeMapBody(mapTemplate(id))
      if (mode === 'replace') d.update((g) => ({ ...g, nodes: tpl.nodes, edges: tpl.edges }))
      else {
        const { graph } = ops.pasteClip(page(), { marker: 'plexii-diagram/v1', nodes: tpl.nodes, edges: tpl.edges }, offsetRight())
        d.update(() => graph)
      }
      window.setTimeout(fit, 60)
    },
    importMermaid(text: string, mode: 'replace' | 'add' = 'add'): string[] {
      const res = mermaidToMap(text)
      if (!res.nodes.length) return res.warnings.length ? res.warnings : ['No diagram found in that Mermaid text.']
      if (mode === 'replace') d.update((g) => ({ ...g, nodes: res.nodes, edges: res.edges }))
      else {
        const { graph, sel: s } = ops.pasteClip(page(), { marker: 'plexii-diagram/v1', nodes: res.nodes, edges: res.edges }, offsetRight())
        d.update(() => graph)
        d.setSel(s)
      }
      window.setTimeout(fit, 60)
      return res.warnings
    },
    importDrawio(xml: string): string[] {
      const res = drawioToMap(xml)
      if (!res.pages.length) return res.warnings.length ? res.warnings : ['No pages found in that draw.io file.']
      d.updateBody((b) => {
        let out = b
        const firstEmpty = !getPage(b, d.pageIdxRef.current).nodes.length
        res.pages.forEach((p, i) => {
          // The file's own layers come along, so hidden draw.io layers can be shown again.
          if (i === 0 && firstEmpty) {
            const cur = getPage(out, d.pageIdxRef.current)
            const layers = [...(cur.layers ?? []), ...(p.layers ?? [])]
            out = withPage(out, d.pageIdxRef.current, { ...cur, nodes: p.nodes, edges: p.edges, ...(layers.length ? { layers } : {}) })
          } else out = addPage(out, p.name || `Imported ${i + 1}`, ops.uid('page-'), { nodes: p.nodes, edges: p.edges, ...(p.layers ? { layers: p.layers } : {}) }).body
        })
        return normalizeMapBody(out)
      })
      window.setTimeout(fit, 60)
      return res.warnings
    },
    async importVsdx(): Promise<string | null> {
      const r = await window.api.map.import()
      if (!r.ok || !r.body) return r.error ?? null
      const b = normalizeMapBody(r.body)
      const { graph } = ops.pasteClip(page(), { marker: 'plexii-diagram/v1', nodes: b.nodes, edges: b.edges }, offsetRight())
      d.update(() => graph)
      window.setTimeout(fit, 60)
      return null
    },
    importJson(text: string): string | null {
      try {
        const parsed = JSON.parse(text)
        const b = normalizeMapBody(parsed)
        if (!b.nodes.length && !b.pages?.length) return 'That file has no PlexiiDiagrams shapes.'
        d.updateBody(() => ({ ...b, viewport: d.bodyRef.current.viewport }))
        d.setPageIdx(0)
        return null
      } catch (e) {
        return `Not a valid PlexiiDiagrams JSON file: ${(e as Error).message}`
      }
    },
    async exportAs(format: 'svg' | 'png' | 'jpg' | 'pdf', scope: 'page' | 'selection' = 'page'): Promise<string> {
      const g = page()
      const s = sel()
      const subset = scope === 'selection' && s.nodes.size ? ops.copySelection(g, s) : null
      const map: MapBody = {
        ...d.bodyRef.current,
        nodes: subset ? subset.nodes : g.nodes,
        edges: subset ? subset.edges : g.edges,
        layers: g.layers,
        pages: undefined
      }
      const res = await window.api.map.export({ map, title: d.title || 'diagram', format })
      if (res.ok && res.path) return `Saved ${res.path}${res.warning ? `. ${res.warning}` : ''}`
      return res.error ?? ''
    },
    exportText(kind: 'mermaid' | 'drawio' | 'json'): void {
      const b = d.bodyRef.current
      const g = page()
      let text: string
      let ext: string
      let type: string
      if (kind === 'mermaid') {
        text = mapToMermaid(g.nodes, g.edges, 'TD')
        ext = 'mmd'
        type = 'text/plain'
      } else if (kind === 'drawio') {
        text = mapToDrawio(pageList(b).map((p, i) => ({ name: p.name, ...getPage(b, i) })))
        ext = 'drawio'
        type = 'application/xml'
      } else {
        text = JSON.stringify(b, null, 2)
        ext = 'plexidiagram.json'
        type = 'application/json'
      }
      download(`${(d.title || 'diagram').replace(/[\\/:*?"<>|]+/g, '-')}.${ext}`, text, type)
    },
    copyMermaid(): string {
      const g = page()
      const text = mapToMermaid(g.nodes, g.edges, 'TD')
      void navigator.clipboard?.writeText(text).catch(() => {})
      return text
    },

    // ── AI ───────────────────────────────────────────────────────────────
    async aiGenerate(prompt: string, mode: 'replace' | 'add'): Promise<string | null> {
      const r = await window.api.documents.generate({ docType: 'map', prompt })
      if (!r.ok || !r.body) return r.error || 'Could not generate a diagram.'
      const norm = normalizeMapBody(r.body)
      const laid = layoutDiagram(norm.nodes, norm.edges, { algorithm: 'layered', direction: 'TB' })
      if (mode === 'replace') d.update((g) => ({ ...g, nodes: laid, edges: norm.edges }))
      else {
        const { graph, sel: s } = ops.pasteClip(page(), { marker: 'plexii-diagram/v1', nodes: laid, edges: norm.edges }, offsetRight())
        d.update(() => graph)
        d.setSel(s)
      }
      window.setTimeout(fit, 60)
      return null
    },

    // ── data sources ─────────────────────────────────────────────────────
    generateFromTable(table: Parameters<typeof generateFromTable>[0], rows: Parameters<typeof generateFromTable>[1], opts: GenerateOptions, mode: 'replace' | 'add'): string[] {
      const res = generateFromTable(table, rows, { ...opts, idPrefix: `t${ops.uid('')}-` })
      if (!res.nodes.length) return res.warnings.length ? res.warnings : ['That table has no rows.']
      const algorithm: LayoutAlgorithm = opts.kind === 'orgchart' ? 'tree' : opts.kind === 'mindmap' ? 'mindmap' : opts.kind === 'cards' ? 'grid' : 'layered'
      const laid = layoutDiagram(res.nodes, res.edges, { algorithm, direction: opts.kind === 'flow' ? 'LR' : 'TB' })
      if (mode === 'replace') d.update((g) => ({ ...g, nodes: laid, edges: res.edges }))
      else {
        const { graph, sel: s } = ops.pasteClip(page(), { marker: 'plexii-diagram/v1', nodes: laid, edges: res.edges }, offsetRight())
        // Keep bindings on the pasted copies (pasteClip preserves fields).
        d.update(() => graph)
        d.setSel(s)
      }
      window.setTimeout(fit, 60)
      return res.warnings
    },

    // ── keyboard ─────────────────────────────────────────────────────────
    handleKey(e: KeyboardEvent, ui: { setTool: (t: Tool) => void; tool: Tool }): boolean {
      const mod = isMac ? e.metaKey : e.ctrlKey
      const k = shortcutKey(e)
      const step = e.shiftKey ? 10 : 1
      if (k === 'delete' || k === 'backspace') return cmds.deleteSelection(), true
      // Esc first disarms a tool (SPEC §3.2), then clears the selection.
      if (k === 'escape') return ui.tool !== 'select' ? ui.setTool('select') : cmds.clearSelection(), true
      if (k === 'enter' && !mod) return cmds.editSelected(), true
      if (k === 'arrowleft') return cmds.nudge(-step, 0), true
      if (k === 'arrowright') return cmds.nudge(step, 0), true
      if (k === 'arrowup') return cmds.nudge(0, -step), true
      if (k === 'arrowdown') return cmds.nudge(0, step), true
      if (mod) {
        if (k === 'z' && !e.shiftKey) return cmds.undo(), true
        if ((k === 'z' && e.shiftKey) || k === 'y') return cmds.redo(), true
        if (k === 'a') return cmds.selectAll(), true
        if (k === 'd') return cmds.duplicate(), true
        if (k === 'g' && !e.shiftKey) return cmds.group(), true
        if (k === 'g' && e.shiftKey) return cmds.ungroup(), true
        if (k === 'l' && e.shiftKey) return cmds.toggleLock(), true
        if (k === ']') return cmds.order(e.shiftKey ? 'front' : 'forward'), true
        if (k === '[') return cmds.order(e.shiftKey ? 'back' : 'backward'), true
        if (k === 'b') return toggleStyle('bold'), true
        if (k === 'i') return toggleStyle('italic'), true
        if (k === 'u') return toggleStyle('underline'), true
        if (k === '=' || k === '+') return cmds.zoomIn(), true
        if (k === '-') return cmds.zoomOut(), true
        if (k === '0') return cmds.zoomTo(1), true
        if (e.altKey && k === 'c') return cmds.copyStyle(), true
        if (e.altKey && k === 'v') return cmds.pasteStyle(), true
        return false
      }
      if (e.shiftKey && k === '!') return cmds.fit(), true
      if (e.shiftKey && (k === '1' || e.code === 'Digit1')) return cmds.fit(), true
      if (e.shiftKey && (k === '2' || e.code === 'Digit2' || k === '@')) return cmds.zoomToSelection(), true
      if (k === 'v') return ui.setTool('select'), true
      if (k === 'h') return ui.setTool('pan'), true
      if (k === 't') return ui.setTool('text'), true
      // Suite shape letters (Illustrator's, as in Draw): M rectangle, L ellipse.
      if (k === 'm') return ui.setTool('shape:process'), true
      if (k === 'l') return ui.setTool('shape:circle'), true
      return false
    }
  }

  function toggleStyle(key: 'bold' | 'italic' | 'underline'): void {
    const n = page().nodes.find((x) => sel().nodes.has(x.id))
    if (!n) return
    cmds.setStyle({ [key]: n.style?.[key] ? undefined : true })
  }

  // Imported/added content lands to the right of what's already there.
  function offsetRight(): { x: number; y: number } {
    const g = page()
    if (!g.nodes.length) return { x: 0, y: 0 }
    const right = Math.max(...g.nodes.map((n) => n.x + nodeSize(n).w))
    const top = Math.min(...g.nodes.map((n) => n.y))
    return { x: Math.round(right + 120), y: Math.round(top) }
  }

  return cmds
}

function imageShapeId(): string {
  return 'image'
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(f)
  })
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const img = new Image()
    img.onload = () => res({ w: img.naturalWidth || 200, h: img.naturalHeight || 150 })
    img.onerror = () => res({ w: 200, h: 150 })
    img.src = url
  })
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}
