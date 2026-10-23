// Unified context menu, public surface. Import this once (the app does so via
// the UnifiedContextMenu mount) to register the core providers and expose the
// resolver and the menu-context helpers every right-click surface uses.

import './providers'

export { resolveMenu } from './resolve'
export { MenuSection, MENU_GROUP_ORDER } from './types'
export type { MenuContext, MenuContribution, MenuGroup, ObjectKind, MenuSelection, FrameCallbacks } from './types'
export { MENU_ROW_CEILING } from './resolve'
export { bodyMenuTarget } from './bodyTarget'
export {
  registerWidgetContextActions,
  registerPluginContextActions,
  clearWidgetContextActions
} from './registry'
export { buildContextForWidget, buildContextForSelection, buildContextForMulti } from './buildContext'
