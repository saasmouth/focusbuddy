import { useEffect, useMemo, useState } from 'react'
import { useKnowledgeStore } from '../../stores/knowledge'
import { useViewStore } from '../../stores/view'
import { DashboardHeader } from '../plexi'
import Icon from '../Icon'
import type { KnowledgeEntry } from '@shared/knowledge'

// Brain Map — an Obsidian-style graph of your PlexiBrain knowledge. Every entry
// is a node; two nodes are linked when they share at least one tag. The graph is
// built only from real knowledge entries and their real tags, laid out on a
// radial ring (no physics dependency, deterministic, cheap). Nothing is
// invented: a brain with no entries shows an honest empty state, and a brain
// with entries but no shared tags shows the nodes with no edges, which is the
// truth.

interface GraphNode {
  entry: KnowledgeEntry
  x: number
  y: number
}

interface GraphEdge {
  a: string
  b: string
  shared: number
}

const SIZE = 720
const CENTER = SIZE / 2

function buildGraph(entries: KnowledgeEntry[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const n = entries.length
  if (n === 0) return { nodes: [], edges: [] }

  // Radial layout: pinned entries cluster toward the centre, the rest ring out.
  // A single entry sits dead centre. Deterministic so the map does not jiggle
  // between renders.
  const nodes: GraphNode[] = entries.map((entry, i) => {
    if (n === 1) return { entry, x: CENTER, y: CENTER }
    const ring = entry.pinned ? 0.42 : 0.82
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2
    const r = (SIZE / 2 - 60) * ring
    return { entry, x: CENTER + Math.cos(angle) * r, y: CENTER + Math.sin(angle) * r }
  })

  // Edges: shared tags. Count the overlap so a stronger relationship draws a
  // heavier line.
  const edges: GraphEdge[] = []
  for (let i = 0; i < entries.length; i++) {
    const ti = new Set(entries[i].tags.map((t) => t.toLowerCase()))
    if (ti.size === 0) continue
    for (let j = i + 1; j < entries.length; j++) {
      const shared = entries[j].tags.filter((t) => ti.has(t.toLowerCase())).length
      if (shared > 0) edges.push({ a: entries[i].id, b: entries[j].id, shared })
    }
  }
  return { nodes, edges }
}

// Module-level so reopening the Brain Map within the window doesn't re-sync on
// every mount — one workspace→brain sync per this gap is plenty.
const BRAIN_SYNC_MIN_GAP_MS = 30_000
let lastBrainSyncAt = 0

export default function BrainMapView(): JSX.Element {
  const entries = useKnowledgeStore((s) => s.entries)
  const loaded = useKnowledgeStore((s) => s.loaded)
  const load = useKnowledgeStore((s) => s.load)
  const goKnowledge = useViewStore((s) => s.goKnowledge)
  const [hoverId, setHoverId] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // Keep the brain current automatically: syncing the workspace in whenever the
  // map is opened means the graph always reflects every desk/document/note/file
  // without a manual command. Debounced across remounts (module-level guard) so
  // reopening the map repeatedly doesn't re-sync; non-fatal (the map still shows
  // whatever's already indexed if a sync fails). Files are skipped when unchanged,
  // so this is cheap after the first run.
  useEffect(() => {
    const now = Date.now()
    if (now - lastBrainSyncAt < BRAIN_SYNC_MIN_GAP_MS) return
    lastBrainSyncAt = now
    void window.api.brain
      .ingestWorkspace()
      .then(() => load())
      .catch(() => {})
  }, [load])

  const { nodes, edges } = useMemo(() => buildGraph(entries), [entries])
  const posById = useMemo(() => new Map(nodes.map((nd) => [nd.entry.id, nd])), [nodes])

  // Which node ids are connected to the hovered one (for a light highlight).
  const neighbours = useMemo(() => {
    if (!hoverId) return new Set<string>()
    const set = new Set<string>([hoverId])
    for (const e of edges) {
      if (e.a === hoverId) set.add(e.b)
      if (e.b === hoverId) set.add(e.a)
    }
    return set
  }, [hoverId, edges])

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="brain-map-view">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <DashboardHeader
          title="Brain Map"
          subtitle="Your knowledge as a graph. Each entry is a node, linked to others it shares a tag with."
        />

        {!loaded ? (
          <div className="flex items-center gap-2 px-3 py-10 text-[13px] text-[var(--ink-70)]">
            <Icon name="progress_activity" size={16} className="text-[rgb(var(--accent))] animate-spin" /> Loading your brain…
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-16 text-center" data-testid="brain-map-empty">
            <Icon name="bubble_chart" size={30} className="text-[var(--ink-30)]" />
            <p className="mt-3 text-[14px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
              Your brain is empty. Save facts, decisions and processes into PlexiiBrain, tag them, and
              this map draws the connections between them.
            </p>
          </div>
        ) : (
          <div className="fb-card mt-2 p-3">
            <svg
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="w-full h-auto"
              role="img"
              aria-label="Knowledge graph"
              data-testid="brain-map-svg"
            >
              {edges.map((e) => {
                const a = posById.get(e.a)
                const b = posById.get(e.b)
                if (!a || !b) return null
                const lit = hoverId === null || neighbours.has(e.a) && neighbours.has(e.b)
                return (
                  <line
                    key={`${e.a}-${e.b}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="rgb(var(--accent))"
                    strokeWidth={Math.min(1 + e.shared * 0.6, 3)}
                    strokeOpacity={lit ? 0.45 : 0.12}
                  />
                )
              })}
              {nodes.map((nd) => {
                const lit = hoverId === null || neighbours.has(nd.entry.id)
                const r = nd.entry.pinned ? 13 : 10
                return (
                  <g
                    key={nd.entry.id}
                    transform={`translate(${nd.x} ${nd.y})`}
                    className="cursor-pointer"
                    data-testid={`brain-node-${nd.entry.id}`}
                    onMouseEnter={() => setHoverId(nd.entry.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onClick={() => goKnowledge(nd.entry.id)}
                    opacity={lit ? 1 : 0.35}
                  >
                    <circle
                      r={r}
                      fill={nd.entry.pinned ? 'rgb(var(--accent))' : 'var(--surface-base)'}
                      stroke="rgb(var(--accent))"
                      strokeWidth={2}
                    />
                    <text
                      x={0}
                      y={r + 14}
                      textAnchor="middle"
                      className="fb-tabular"
                      fontSize={12}
                      fill="var(--ink-90)"
                    >
                      {(nd.entry.title || 'Untitled').slice(0, 22)}
                    </text>
                  </g>
                )
              })}
            </svg>
            <p className="mt-1 px-1 text-[11.5px] text-[var(--ink-50)]">
              {nodes.length} entr{nodes.length === 1 ? 'y' : 'ies'}, {edges.length} link{edges.length === 1 ? '' : 's'} by shared tags. Click a node to open it.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
