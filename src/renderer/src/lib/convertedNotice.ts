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
  useNoticeStore.getState().show({ text, icon: 'info' }, CONVERTED_NOTICE_MS)
}
