// The URLs a browser widget itself saved, recently.
//
// WebViewWidget saves every navigation's URL into widget.content, and treats a
// content change it did not make as an outside request to load (a sibling
// instance, an edit from elsewhere). It recognised its own saves by the LAST
// one only. Saves reach the store asynchronously, so a page that changes its
// address quickly (history.pushState — quote boards, news lists, search) had
// the echo of an older save arrive after newer ones: taken for an outside
// request and loaded, the page restarted, pushed the same addresses again, and
// reloaded in a loop — 156 reloads in 8 seconds on one test desk, and the
// GUEST_VIEW_MANAGER_CALL ERR_ABORTED storm in the owner's crash log
// (2026-11-03). Every save of the last few seconds counts as our own.

export const OWN_WRITE_WINDOW_MS = 15_000
const MAX = 64

export class RecentOwnWrites {
  private items: Array<{ url: string; at: number }> = []

  constructor(seed?: string, now = Date.now()) {
    if (seed) this.note(seed, now)
  }

  /** Record a URL this widget just saved. */
  note(url: string, now = Date.now()): void {
    this.items = this.items.filter((i) => i.url !== url && now - i.at <= OWN_WRITE_WINDOW_MS)
    this.items.push({ url, at: now })
    if (this.items.length > MAX) this.items.shift()
  }

  /** Did this widget save `url` within the window? (Its store echo can arrive late.) */
  has(url: string, now = Date.now()): boolean {
    return this.items.some((i) => i.url === url && now - i.at <= OWN_WRITE_WINDOW_MS)
  }

  /** Start again from one URL (a different widget mounted in this instance). */
  reset(seed?: string, now = Date.now()): void {
    this.items = []
    if (seed) this.note(seed, now)
  }
}
