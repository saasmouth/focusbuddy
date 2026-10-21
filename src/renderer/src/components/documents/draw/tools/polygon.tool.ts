// Polygon tool (U): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'polygon', kind: 'polygon', label: 'Polygon', icon: 'hexagon', key: 'U', order: 80, undoLabel: 'Polygon' })
