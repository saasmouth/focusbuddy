// Account state inside the Worker.
//
// On the desktop this reads a file and decrypts the session token through the
// OS keychain. In the browser the session lives on the main thread, in
// localStorage, managed by src/web/api/session.ts -- so the Worker does not own
// it and cannot read it. It is handed over once, in the init message the bridge
// sends before any call is answered, and cached here.
//
// The token is held in memory only. Nothing in this file writes it anywhere,
// which is why the setters below refuse rather than persist: two writers to one
// session, one of them unable to read what the other stored, is how a signed-in
// user ends up signed out on refresh.
export interface PublicAccountState {
  sessionToken: string | null
  skippedAt: number | null
  cachedEmail: string | null
}

let state: PublicAccountState = { sessionToken: null, skippedAt: null, cachedEmail: null }

/** Called by the Worker entry when the bridge sends the session across. */
export function adoptSession(next: PublicAccountState): void {
  state = next
}

export function accountEmail(): string | null {
  return state.cachedEmail
}

export function loadAccountState(): PublicAccountState {
  return state
}

/** The desktop uses this to defer keychain access until a window is up. */
export function markUiVisible(): void {
  // The browser has no keychain prompt to defer, so there is nothing to mark.
}

const OWNED_ELSEWHERE =
  'The browser session is owned by the page, not the Worker. Use window.api.account.'

export function saveSession(_token: string, _email: string | null): void {
  throw new Error(OWNED_ELSEWHERE)
}

export function clearSession(): void {
  throw new Error(OWNED_ELSEWHERE)
}

export function setSkipped(_skipped: boolean): void {
  throw new Error(OWNED_ELSEWHERE)
}

export function setCachedEmail(_email: string | null): void {
  throw new Error(OWNED_ELSEWHERE)
}
