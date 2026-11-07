// Claiming a visitor's copy of a shared desk (shared/deskHandoff.ts) with the
// signed-in session: POST /desk-handoffs/:id/claim on Signal.
//
// The answer decides what happens to the id the app is keeping:
//   ok           import it, then forget the id
//   gone         expired or never existed: forget it, and say so
//   elsewhere    another account claimed it first: forget it, and say so
//   unauthorized the session is not good: keep it, a sign-in will retry
//   unavailable  the server could not answer (or has no such route yet):
//                keep it, and try again at the next sign-in or launch
//   offline      no network: keep it
import { signalConfig } from './signalConfig'

export type ClaimResult =
  | { ok: true; title: string; bundle: string }
  | { ok: false; kind: 'gone' | 'elsewhere' | 'unauthorized' | 'unavailable' | 'offline' }

const urlFor = (path: string): string => signalConfig.httpUrl.replace(/\/+$/, '') + path

/** Read the claim's status and body into a result. Exported for the tests. */
export function claimOutcome(status: number, body: unknown): ClaimResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (status === 200 && typeof b.bundle === 'string') {
    return { ok: true, title: typeof b.title === 'string' ? b.title : '', bundle: b.bundle }
  }
  if (status === 401 || status === 403) return { ok: false, kind: 'unauthorized' }
  if (status === 409) return { ok: false, kind: 'elsewhere' }
  if (status === 410) return { ok: false, kind: 'gone' }
  if (status === 404) {
    // Fastify's own 404 for a route this server does not have yet ("Route
    // POST:/desk-handoffs/... not found") is not the handoff being gone: an
    // older server must not make the app throw the person's desk away.
    const message = typeof b.message === 'string' ? b.message : ''
    if (/^Route .* not found/i.test(message)) return { ok: false, kind: 'unavailable' }
    return { ok: false, kind: 'gone' }
  }
  return { ok: false, kind: 'unavailable' }
}

export async function claimDeskHandoff(id: string, token: string): Promise<ClaimResult> {
  try {
    const res = await fetch(urlFor(`/desk-handoffs/${encodeURIComponent(id)}/claim`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Fastify refuses an empty JSON body before auth (fastify-empty-json-body).
      body: '{}'
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return claimOutcome(res.status, body)
  } catch {
    return { ok: false, kind: 'offline' }
  }
}
