import { createContext, useContext } from 'react'
import type { MapEdge, MapNode, MapSettings } from '@shared/types'
import type { FbRow, FbTable } from '@shared/fields'
import type { Route } from '@shared/diagram/routing'

// Everything a canvas node or edge needs that does not belong in React Flow's
// per-element data: the routed lines, theme, live table data and the editor's
// actions. One context instead of prop-drilling through React Flow.

export type QuickDir = 'up' | 'right' | 'down' | 'left'

export interface DiagramCtxValue {
  themeId: string
  settings: MapSettings
  zoom: number
  routes: Map<string, Route>
  nodesById: Map<string, MapNode>
  edgesById: Map<string, MapEdge>
  selectedNodeCount: number
  connecting: boolean
  editingId: string | null
  setEditingId: (id: string | null) => void
  commitLabel: (id: string, label: string) => void
  commitCell: (id: string, row: number, col: number, text: string) => void
  quickAdd: (id: string, dir: QuickDir) => void
  beginRotate: (id: string, e: React.PointerEvent) => void
  // Record an undo step now (call at the START of a drag; moves then update live).
  checkpoint: () => void
  // Edges: waypoint and label dragging (no history of their own; see checkpoint).
  setWaypoints: (edgeId: string, pts: { x: number; y: number }[] | undefined) => void
  setLabelPos: (edgeId: string, t: number) => void
  editEdgeLabel: (edgeId: string) => void
  tables: Record<string, FbTable>
  rows: Record<string, FbRow[]>
  readOnly: boolean
}

export const DiagramCtx = createContext<DiagramCtxValue | null>(null)

export function useDiagramCtx(): DiagramCtxValue {
  const v = useContext(DiagramCtx)
  if (!v) throw new Error('useDiagramCtx outside DiagramCtx provider')
  return v
}
