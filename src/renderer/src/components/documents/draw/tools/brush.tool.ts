// Brush (B): paint on a paint layer with the chosen brush preset. Pressure-aware.
import { strokeTool } from './paintTool'

export default strokeTool({ id: 'brush', label: 'Brush', icon: 'brush', key: 'B', order: 120, erase: false })
