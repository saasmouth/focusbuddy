// Is snap-to-grid on?
//
// A preference rather than a constant because a free canvas is the product's
// whole claim, and someone who wants a thing three pixels off the grid is
// entitled to it. Default ON: drift accumulates invisibly, and a desk that
// never drifts is one nobody has to tidy.
const KEY = 'fb.canvas.snap'

export function snapEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function setSnapEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode: the session keeps the default */
  }
  try {
    window.dispatchEvent(new CustomEvent('fb:snap-changed'))
  } catch {
    /* no window */
  }
}
