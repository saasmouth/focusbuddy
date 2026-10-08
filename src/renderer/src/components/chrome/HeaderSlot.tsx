import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Render children into a named slot in the app header, from anywhere.
//
// WHY A PORTAL RATHER THAN LIFTING STATE. The desk breadcrumb and the desk
// presence bar were floating on the canvas surface — two separate bars at the
// top, one left, one right — and the ask was to move them into the header bar
// and combine them. Both are driven entirely by Canvas: the breadcrumb needs
// the active task, the node tree, rename, assign-to-room and
// create-room-from-desk; the presence bar needs the desk id. Hoisting all of
// that into App to get two bars 40px higher would move a large amount of wiring
// for a layout change, and every one of those callbacks would have become a
// prop threaded through App for no other reason.
//
// So the DATA stays where it is and only the pixels move. Canvas keeps owning
// the components; this puts them in the header's slot.
//
// It renders nothing until the slot exists. The header mounts in the same
// commit as the canvas, so the first paint can miss it — hence the state +
// effect rather than a bare getElementById, which would silently drop the
// content on mount and only recover on the next re-render.
export default function HeaderSlot({
  id,
  children,
  fallback = null
}: {
  id: string
  children: ReactNode
  /** Rendered in place when there is no header on this surface at all. */
  fallback?: ReactNode
}): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const find = (): void => setHost(document.getElementById(id))
    find()
    // The slot can appear later (a surface that mounts its own header, or the
    // header remounting on a mode change), so watch for it rather than looking
    // once. Cheap: one observer, childList only, and it stops as soon as the
    // slot is found.
    const mo = new MutationObserver(find)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [id])

  if (!host) return fallback ? <>{fallback}</> : null
  return createPortal(children, host)
}
