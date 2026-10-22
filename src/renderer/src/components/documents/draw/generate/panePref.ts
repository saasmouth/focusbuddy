// Which right-hand pane PlexiiDraw had open, remembered per profile.
//
// Its own key rather than a field in editor/shellPrefs.ts: that store is d1's
// and this is one boolean's worth of state for a pane they do not otherwise
// know about. plexii.draw.sidePane is the key they specified.
//
// CLOSED BY DEFAULT, always. An AI pane that opened itself would cover the
// canvas of every existing drawing on this device the first time someone
// updated, and in a 480px desk widget it would cover the canvas entirely.
// Someone has to ask for it.

const KEY = 'plexii.draw.sidePane'

export function readSidePane(): string | null {
  try {
    const v = globalThis.localStorage?.getItem(KEY)
    return v === 'ai' ? 'ai' : null
  } catch {
    return null
  }
}

export function writeSidePane(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(KEY, id)
    else globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* a remembered pane is a convenience */
  }
}
