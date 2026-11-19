// Open the share sheet of the desk in view, from anywhere (the credit card's
// "Share another desk", 4.3.52). The desk's own menu (desk/DeskContextMenu)
// listens and takes the event; with no desk in view nothing takes it, and the
// caller goes somewhere a desk can be picked instead.

export const OPEN_SHARE_EVENT = 'fb:open-share'

/** True when a desk in view opened its share sheet. */
export function openShareForDeskInView(): boolean {
  const ev = new Event(OPEN_SHARE_EVENT, { cancelable: true })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}
