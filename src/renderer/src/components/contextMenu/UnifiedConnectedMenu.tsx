// Drop-in replacement for the old ConnectedToolMenu. It keeps the same prop
// shape so each content widget swaps one import, but it renders the full
// unified menu (the eight canonical sections, AI Assist, Create, Convert, ...)
// instead of the thin "Create + connect" list. The widget is looked up from the
// store by id, and any captured selection text becomes the menu's selection so
// AI Assist and Create both inherit it.

import { useWidgetStore } from '../../stores/widgets'
import { buildContextForWidget } from '../../lib/contextMenu/buildContext'
import { useFrameCallbacks, useFrameRows } from '../../lib/contextMenu/frameContext'
import type { MenuContribution } from '../../lib/contextMenu/types'
import UnifiedWidgetMenu from './UnifiedWidgetMenu'

export interface UnifiedConnectedMenuProps {
  sourceWidgetId: string
  x: number
  y: number
  onClose: () => void
  selectionContext?: {
    selectionText?: string
    imageUrl?: string
  }
  // Sub-object granularity (e.g. a table 'cell') and its payload, so per-widget
  // providers can offer cell/row/node actions for what was actually clicked.
  granularity?: string
  payload?: Record<string, unknown>
  /**
   * Rows this body adds for this one menu (the provider API, lib/contextMenu/
   * types.ts): each names its §9.3 group and the resolver places and counts it.
   */
  contributions?: MenuContribution[]
}

export default function UnifiedConnectedMenu(props: UnifiedConnectedMenuProps): JSX.Element | null {
  const widget = useWidgetStore((s) => s.widgets.find((w) => w.id === props.sourceWidgetId))
  const frame = useFrameCallbacks()
  const frameRows = useFrameRows()
  if (!widget) return null
  const menuContext = buildContextForWidget(
    widget,
    { clientX: props.x, clientY: props.y },
    {
      selectionText: props.selectionContext?.selectionText,
      frame,
      granularity: props.granularity,
      payload: props.payload,
      contributions: [...(frameRows ?? []), ...(props.contributions ?? [])]
    }
  )
  return <UnifiedWidgetMenu menuContext={menuContext} onClose={props.onClose} />
}
