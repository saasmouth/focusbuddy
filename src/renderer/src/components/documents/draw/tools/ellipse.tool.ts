// Ellipse tool (O): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'ellipse', kind: 'ellipse', label: 'Ellipse', icon: 'circle', key: 'O', order: 70, undoLabel: 'Ellipse' })
