// The recipient half of a desk claim link.
//
// Someone is handed a URL by a person they know. They have no account and have
// never heard of Plexii. What happens next decides whether this feature is worth
// having, so the order matters: they are told what is being offered BEFORE being
// asked to sign up, because "create an account to find out what this is" is how
// a share link gets closed.
//
// The preview is fetched without any credentials -- the server answers with the
// desk's title, who is sharing it and what it would grant, and nothing else.
import { signalConfig } from '@renderer/lib/signalConfig'
import { sessionToken } from './session'

const base = (): string => signalConfig.httpUrl.replace(/\/+$/, '')

export interface ClaimPreview {
  ok: true
  rootId: string
  permission: 'view' | 'edit'
  title: string
  ownerName: string
  singleUse: boolean
}

export interface ClaimProblem {
  ok: false
  error: string
}

/**
 * Read the claim token out of the URL.
 *
 * Both shapes are accepted: /claim/<token> is what gets shared, and ?claim=
 * survives being pasted somewhere that mangles paths.
 */
export function claimTokenFromUrl(url = window.location.href): string | null {
  const u = new URL(url)
  const fromQuery = u.searchParams.get('claim')
  if (fromQuery) return fromQuery
  const m = /^\/claim\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname)
  return m ? m[1] : null
}

/** What this link offers, without signing in. */
export async function previewClaim(token: string): Promise<ClaimPreview | ClaimProblem> {
  try {
    const res = await fetch(`${base()}/workspace/desk/claim/${encodeURIComponent(token)}`)
    const body = (await res.json().catch(() => null)) as (ClaimPreview | ClaimProblem) | null
    if (!body) return { ok: false, error: 'Could not read this link.' }
    return body
  } catch {
    // Distinguished from a dead link on purpose: telling someone their link has
    // expired when they are simply offline is a lie they cannot recover from.
    return { ok: false, error: 'Could not reach Plexii. Check your connection and try again.' }
  }
}

/** Turn the token into real access. Requires a signed-in session. */
export async function claimDesk(token: string): Promise<{ ok: boolean; rootId?: string; error?: string }> {
  const auth = sessionToken()
  if (!auth) return { ok: false, error: 'Sign in first.' }
  try {
    const res = await fetch(`${base()}/workspace/desk/claim/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}` }
    })
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; rootId?: string; error?: string }
      | null
    if (!body) return { ok: false, error: 'Could not add this desk.' }
    return body.ok ? { ok: true, rootId: body.rootId } : { ok: false, error: body.error ?? 'Could not add this desk.' }
  } catch {
    return { ok: false, error: 'Could not reach Plexii. Check your connection and try again.' }
  }
}

/**
 * Drop the token from the address bar once it has been used.
 *
 * Otherwise a reload re-runs the claim, and -- worse -- the link sits in the
 * recipient's history and address bar to be copied and forwarded onward.
 */
export function clearClaimFromUrl(): void {
  try {
    window.history.replaceState({}, '', '/')
  } catch {
    /* a browser that refuses history rewriting still works, just untidily */
  }
}
