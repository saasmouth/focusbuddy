// Rounded rectangle tool (D): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'roundRect', kind: 'roundRect', label: 'Rounded rectangle', icon: 'rounded_corner', key: 'D', order: 60, undoLabel: 'Rounded rectangle' })
