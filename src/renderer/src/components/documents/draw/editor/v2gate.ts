// Whether this drawing may take content only the v2 drawing format can store
// (groups, clipping masks, several artboards, template layers, a matrix on
// text, images and work widgets), and why not when it may not.
//
// v2 writes are on (DRAW_V2_WRITES): a v1 drawing becomes v2 on its first
// edit. The one exception is a live co-editing session with someone on an
// older version of PlexiiDesk that does not say it reads v2: the drawing then
// stays v1 for that session (DrawStudio's v2Blocked, set by LiveDocEditorView),
// and the v2-only commands show disabled with the reason. A drawing that is
// already v2, or already holds v2-only content, stays v2 regardless.

import { isV1Representable } from '@shared/draw/migrate'
import type { EditorState } from './types'

type Gate = Pick<EditorState, 'doc' | 'storedSchema' | 'v2Writes'>

/** May this drawing hold v2-only content now? */
export function v2Writable(s: Gate): boolean {
  return s.v2Writes || s.storedSchema >= 2 || !isV1Representable(s.doc)
}

/** Why v2 content cannot go into this drawing now (a clause to end a sentence with). */
export function v2BlockedReason(s: Pick<EditorState, 'v2Blocked'>): string {
  return s.v2Blocked ?? 'this build does not write it yet'
}

/** The reason live sessions give: someone present cannot read the newer format. */
export const LIVE_V1_PEER_REASON = 'someone in this live session is using an older version of PlexiiDesk, so this drawing stays in the older format until they update'
