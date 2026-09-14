// Which widget chrome is in use.
//
// An experiment, so it is a SKIN rather than a rewrite: 'classic' leaves every
// existing pixel where it was, and 'studio' is the lighter card look from the
// reference. Anything that cannot be done as an override of classic does not
// belong in a skin, and the day one wins the other is deleted rather than left
// as a permanent fork of the header.
export type WidgetSkin = 'classic' | 'studio'

const KEY = 'fb.widget.skin'

/** Studio by default on this branch: it is the thing being tried. */
export function widgetSkin(): WidgetSkin {
  try {
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'studio'
  } catch {
    return 'studio'
  }
}

export function setWidgetSkin(skin: WidgetSkin): void {
  try {
    localStorage.setItem(KEY, skin)
  } catch {
    /* private mode: this session keeps the default */
  }
  applyWidgetSkin()
}

/** Stamp the choice on the document so CSS can do the rest. */
export function applyWidgetSkin(): void {
  try {
    document.documentElement.dataset.widgetSkin = widgetSkin()
  } catch {
    /* no document */
  }
}
