import { useEffect, useRef } from 'react'

/**
 * Run `save` once, when the component unmounts, with the values of its last
 * render.
 *
 * Widgets debounce their writes, and an effect's cleanup that only clears the
 * timer drops the last edit: closing a desk, switching away, the canvas
 * remounting its widgets on a layout change, or a widget file's tile closing in
 * PlexiiLite, a moment after typing, and the edit was never written. `save`
 * writes whatever is still pending and does nothing when nothing is (it checks
 * against what was last written), so calling it on every unmount is safe.
 * StickyWidget and NoteWidget do the same by hand.
 */
export function useSaveOnUnmount(save: () => void): void {
  const latest = useRef(save)
  latest.current = save
  useEffect(() => () => latest.current(), [])
}
