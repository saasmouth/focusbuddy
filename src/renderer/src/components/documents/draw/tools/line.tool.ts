// Line tool (\, Illustrator's Line Segment key): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'line', kind: 'line', label: 'Line', icon: 'horizontal_rule', key: '\\', order: 100, undoLabel: 'Line' })
