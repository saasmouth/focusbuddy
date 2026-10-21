// Eraser (E): erase painted pixels with the brush's shape.
import { strokeTool } from './paintTool'

export default strokeTool({ id: 'eraser', label: 'Eraser', icon: 'ink_eraser', key: 'E', order: 130, erase: true })
