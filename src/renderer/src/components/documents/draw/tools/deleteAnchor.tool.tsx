// Delete Anchor Point (−): click an anchor of any path to remove it; the path
// stays joined and keeps as much of its shape as one segment can carry. Alt
// switches to Add Anchor Point for the click.

import type { DrawTool } from '../editor/types'
import { AnchorOverlay } from './anchorOverlay'
import { addAnchorAt, deleteAnchorAt } from './addAnchor.tool'

const deleteAnchorTool: DrawTool = {
  id: 'deleteAnchor',
  label: 'Delete Anchor Point',
  icon: 'do_not_disturb_on',
  group: 1,
  order: 33,
  key: '-',
  cursor: 'default',
  overlayOrder: 50,
  anchorTool: true,
  onPointerDown(ctx, e) {
    if (e.altKey) addAnchorAt(ctx, e)
    else deleteAnchorAt(ctx, e)
  },
  Overlay({ state, k }) {
    return state.tool === 'deleteAnchor' ? <AnchorOverlay state={state} k={k} /> : null
  }
}

export default deleteAnchorTool
