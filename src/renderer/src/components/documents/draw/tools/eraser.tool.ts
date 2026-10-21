// Eraser (Shift+E, as in Illustrator): erase painted pixels with the brush's shape.
import { strokeTool } from './paintTool'

export default strokeTool({ id: 'eraser', label: 'Eraser', icon: 'ink_eraser', key: 'Shift+E', order: 130, erase: true })
