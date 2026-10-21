// Star tool (no key: Illustrator has none, and S is Scale): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'star', kind: 'star', label: 'Star', icon: 'star', order: 90, undoLabel: 'Star' })
