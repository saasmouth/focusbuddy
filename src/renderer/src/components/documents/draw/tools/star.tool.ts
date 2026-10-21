// Star tool (S): drag a box; Shift constrains it. See shapeTool.tsx.
import { shapeTool } from './shapeTool'

export default shapeTool({ id: 'star', kind: 'star', label: 'Star', icon: 'star', key: 'S', order: 90, undoLabel: 'Star' })
