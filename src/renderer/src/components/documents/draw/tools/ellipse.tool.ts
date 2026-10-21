// Ellipse tool (L, as in Illustrator): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'ellipse', kind: 'ellipse', label: 'Ellipse', icon: 'circle', key: 'L', order: 70, undoLabel: 'Ellipse' })
