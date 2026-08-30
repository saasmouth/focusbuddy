// DEC-059 — who is making this write.
//
// crdtSync applies remote events by calling the same user-facing IPC a person
// uses, so by default the main process cannot tell a replayed change from
// something you just did — and it minted a "user did this" Object Event for
// every replayed field write (811 per boot across 28 widgets, all permanent:
// PLX-EVT-030 forbids deleting an Event).
//
// Passing the origin explicitly, rather than tracking "are we replaying?" in
// main-side state, is deliberate. A stateful scope that failed to close would
// silently swallow REAL user Events until it expired, and nothing would look
// broken. An argument cannot leak past the call it is on.
export type WriteOrigin = 'user' | 'sync'
