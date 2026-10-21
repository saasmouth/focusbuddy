// Line tool (L): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'line', kind: 'line', label: 'Line', icon: 'horizontal_rule', key: 'L', order: 100, undoLabel: 'Line' })
