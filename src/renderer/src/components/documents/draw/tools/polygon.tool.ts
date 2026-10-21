// Polygon tool (no key: Illustrator has none, and U is Mesh): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'polygon', kind: 'polygon', label: 'Polygon', icon: 'hexagon', order: 80, undoLabel: 'Polygon' })
