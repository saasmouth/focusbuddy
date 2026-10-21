// Rounded rectangle tool (no key: Illustrator has none, and D is default fill and stroke): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'roundRect', kind: 'roundRect', label: 'Rounded rectangle', icon: 'rounded_corner', order: 60, undoLabel: 'Rounded rectangle' })
