import { signalConfig } from './signalConfig'
import { localOnlyMode } from './localOnlyMode'

// Client for the signal's per-account synced KV (/account/state/:key). Used for
// small per-user client state that should follow the user across devices — e.g. the
// daily standup's "since last time" cursor + last-run date. The value is opaque JSON
// this client owns; last write wins. Best-effort: any failure returns null/false so
// callers fall back to a local default (offline-friendly). Paused, like the rest of
// the personal workspace, while "Keep this device local" is on (lib/localOnlyMode).

function urlFor(path: string): string {
  return signalConfig.httpUrl.replace(/\/+$/, '') + path
}

export async function getAccountState<T>(token: string, key: string): Promise<T | null> {
  if (localOnlyMode()) return null
  try {
    const res = await fetch(urlFor(`/account/state/${encodeURIComponent(key)}`), {
      headers: { Authorization: `Bearer ${token}` }
    })
    const json = (await res.json().catch(() => null)) as { ok?: boolean; value?: T | null } | null
    return json?.ok ? (json.value ?? null) : null
  } catch {
    return null
  }
}

export async function setAccountState(token: string, key: string, value: unknown): Promise<boolean> {
  if (localOnlyMode()) return false
  try {
    const res = await fetch(urlFor(`/account/state/${encodeURIComponent(key)}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    })
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null
    return !!json?.ok
  } catch {
    return false
  }
}
