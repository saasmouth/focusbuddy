// Live co-editing of a drawing: may this session write the v2 drawing format?
//
// Every client of a live room publishes an awareness state. Builds that read
// and write PlexiiDraw's v2 format (4.3.39-local.8 on) add `drawV2: true` to
// it. A session upgrades a v1 drawing to v2 only when EVERY client present says
// so: a client that says nothing is an older build, which could not show the
// groups, masks or artboards v2 holds, so the drawing stays v1 for the session.

/** The awareness field a v2-capable client publishes. */
export const DRAW_V2_AWARENESS_FIELD = 'drawV2'

/** True when every client in `states` (this one included) advertises v2. An empty room is trivially fine. */
export function liveRoomReadsDrawV2(states: Map<number, unknown>, selfClientId: number): boolean {
  for (const [id, st] of states) {
    if (id === selfClientId) continue
    const v = st && typeof st === 'object' ? (st as Record<string, unknown>)[DRAW_V2_AWARENESS_FIELD] : undefined
    if (v !== true) return false
  }
  return true
}
