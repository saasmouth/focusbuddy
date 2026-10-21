import { ReactFlowProvider } from '@xyflow/react'
import type { MapBody } from '@shared/types'
import DiagramEditor from './diagram/DiagramEditor'

// PlexiDiagrams editor — a Lucidchart-class diagram editor (see ./diagram/).
// Kept as the stable entry point: PlexiOffice, the document view, the live
// co-editing view and the desk widget all mount MapEditor with these props, and
// the saved body stays the portable MapBody (v1 readers keep working; v2 adds
// styles, rotation, groups, layers, pages, settings and data bindings).

interface Props {
  body: MapBody
  title?: string
  onChange: (body: MapBody) => void
  // Live co-editing only. When true, a change in the body prop's identity is
  // treated as a peer's merge and folded into the graph. Left off (the default)
  // for the normal single-user editor, where the parent feeds our own saves back
  // as a new body identity and folding them would fight the live editing state.
  foldExternal?: boolean
  readOnly?: boolean
}

export default function MapEditor(props: Props): JSX.Element {
  return (
    <ReactFlowProvider>
      <DiagramEditor {...props} />
    </ReactFlowProvider>
  )
}
