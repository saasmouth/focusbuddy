// Rectangle tool (R): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'rect', kind: 'rect', label: 'Rectangle', icon: 'crop_square', key: 'R', order: 50, undoLabel: 'Rectangle' })
