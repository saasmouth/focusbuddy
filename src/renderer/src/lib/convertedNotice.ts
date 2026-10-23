// The one line a converted insert or paste shows: "It becomes a picture: edit
// it in PlexiiDraw." It goes in the house notice toast (stores/notice.ts),
// because a snippet insert closes the library that asked for it, and a paste
// has no dialog at all; either way the line must outlive what triggered it.
// Never shown for content that landed as itself (conversionNotice returns null).

import { useNoticeStore } from '../stores/notice'

/** How long a conversion line stays: long enough to read two short sentences. */
export const CONVERTED_NOTICE_MS = 9000

export function announceConverted(text: string | null | undefined): void {
  if (!text) return
  if (collector) {
    collector.push({ kind: 'converted', text })
    return
  }
  useNoticeStore.getState().show({ text, icon: 'info' }, CONVERTED_NOTICE_MS)
}

/** A paste or insert that could not land, with the reason the conversion gave, verbatim. */
export function announceRefused(reason: string): void {
  if (collector) {
    collector.push({ kind: 'refused', text: reason })
    return
  }
  useNoticeStore.getState().show({ text: reason, icon: 'warning' }, CONVERTED_NOTICE_MS)
}

// ── One line per drop ────────────────────────────────────────────────────────
//
// A drop from Files can carry several items, and each runs the app's own paste
// path, which announces as it goes. While a drop is being collected those
// lines are gathered instead of shown, so the drop says ONE thing at the end
// (lib/filesContentDrop.ts composes it). Nothing else changes: outside a drop
// every announcement shows as before.

export interface CollectedNotice {
  kind: 'converted' | 'refused'
  text: string
}

let collector: CollectedNotice[] | null = null

/** Run `fn` with announcements gathered; returns its result and what it would have said. */
export async function collectNotices<T>(fn: () => Promise<T>): Promise<{ result: T; notices: CollectedNotice[] }> {
  const outer = collector
  const mine: CollectedNotice[] = []
  collector = mine
  try {
    const result = await fn()
    return { result, notices: mine }
  } finally {
    collector = outer
  }
}
