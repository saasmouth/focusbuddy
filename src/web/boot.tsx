// Entry point for Plexii in the browser.
//
// Three things happen before the app exists, in an order that matters. A cloud
// session is resolved, because there is no workspace to show without one.
// window.api is installed, because the renderer's very first module reads it.
// Only then is the renderer imported -- dynamically, so that its import graph,
// which touches window.api at module scope in several places, cannot begin to
// evaluate against an api that is not there yet.
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { installBrowserApi, installFileServer } from './api/bridge'
import { login, signup, resolveSession, type CloudAccount } from './api/session'
import {
  claimTokenFromUrl, previewClaim, claimDesk, clearClaimFromUrl, type ClaimPreview
} from './api/claim'

/**
 * What a claim link offers, shown before anything is asked of the visitor.
 *
 * Someone arriving here has been handed a URL by a person they know and has
 * never heard of Plexii. Being asked to create an account before being told
 * what is on the other side is how a share link gets closed, so the offer comes
 * first and the sign-up form sits underneath it.
 */
function ClaimOffer({ preview }: { preview: ClaimPreview }): React.JSX.Element {
  return (
    <div style={S.offer}>
      <div style={S.offerWho}>{preview.ownerName} shared a desk with you</div>
      <div style={S.offerTitle}>{preview.title || 'A desk'}</div>
      <div style={S.offerWhat}>
        {preview.permission === 'edit'
          ? 'You will be able to edit it, and your changes sync back.'
          : 'You will be able to see it, and it stays up to date as they work.'}
      </div>
    </div>
  )
}

function SignIn({
  onDone,
  offer,
  claimToken
}: {
  onDone: (a: CloudAccount | null) => void
  offer?: ClaimPreview | null
  claimToken?: string | null
}): React.JSX.Element {
  // Someone arriving from a share link almost certainly has no account, so the
  // form opens on sign-up for them and on sign-in for everyone else.
  const [mode, setMode] = useState<'in' | 'up'>(offer ? 'up' : 'in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result =
      mode === 'in' ? await login(email, password, code || undefined) : await signup(email, password, claimToken)
    setBusy(false)
    if (result.ok) { onDone(result.account ?? null); return }
    if (result.needsCode) { setNeedsCode(true); return }
    setError(result.error ?? 'Sign-in failed.')
  }

  return (
    <div style={S.shell}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.brand}>Plexii</div>
        {offer && <ClaimOffer preview={offer} />}
        <div style={S.sub}>
          {offer
            ? mode === 'up'
              ? 'Create an account to add it'
              : 'Sign in to add it'
            : mode === 'in'
              ? 'Sign in to your workspace'
              : 'Create your workspace'}
        </div>
        <input style={S.input} type="email" placeholder="Email" value={email} autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} required />
        <input style={S.input} type="password" placeholder="Password" value={password}
          autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
          onChange={(e) => setPassword(e.target.value)} required />
        {needsCode && (
          <input style={S.input} placeholder="Two-factor code" value={code} inputMode="numeric"
            onChange={(e) => setCode(e.target.value)} required />
        )}
        {error && <div style={S.error}>{error}</div>}
        <button style={{ ...S.button, opacity: busy ? 0.6 : 1 }} type="submit" disabled={busy}>
          {busy ? 'Working…' : offer ? (mode === 'up' ? 'Create account and add desk' : 'Sign in and add desk') : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
        <button style={S.link} type="button" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null) }}>
          {mode === 'in' ? 'Create an account instead' : 'I already have an account'}
        </button>
      </form>
    </div>
  )
}

function Boot(): React.JSX.Element {
  const [state, setState] = useState<'checking' | 'signin' | 'claiming' | 'loading' | 'ready' | 'failed'>('checking')
  const [detail, setDetail] = useState('')
  const [offer, setOffer] = useState<ClaimPreview | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const token = claimTokenFromUrl()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // The preview is fetched first and without credentials, so a visitor sees
      // what they have been offered whether or not they are signed in.
      const preview = token ? await previewClaim(token) : null
      if (cancelled) return
      if (preview && !preview.ok) setClaimError(preview.error)
      if (preview?.ok) setOffer(preview)
      const account = await resolveSession()
      if (cancelled) return
      // Already signed in with a link in hand: claim it now rather than asking
      // them to sign in to an account they are already in.
      if (account && token && preview?.ok) setState('claiming')
      else setState(account ? 'loading' : 'signin')
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  // Claiming happens after authentication, whichever way it was reached.
  useEffect(() => {
    if (state !== 'claiming' || !token) return
    void claimDesk(token).then((res) => {
      if (!res.ok) setClaimError(res.error ?? 'Could not add this desk.')
      // Either way the app opens: a failed claim should not strand someone
      // outside a workspace they now have an account for.
      clearClaimFromUrl()
      setState('loading')
    })
  }, [state, token])

  useEffect(() => {
    if (state !== 'loading') return
    installBrowserApi()
    // The file server must be controlling the page before any widget renders an
    // image, so it is awaited alongside the renderer import rather than raced
    // with it.
    void installFileServer()
      // Dynamic, and only now: importing the renderer statically would evaluate
      // its module graph -- and its window.api reads -- during this file's own
      // import, before installBrowserApi had run.
      .then(() => import('@renderer/main'))
      .then(() => setState('ready'))
      .catch((err: Error) => { setDetail(err.message); setState('failed') })
  }, [state])

  if (state === 'checking') return <div style={S.shell}><div style={S.sub}>Checking your session…</div></div>
  if (state === 'signin') {
    return (
      <SignIn
        offer={offer}
        claimToken={token}
        onDone={() => setState(token && offer ? 'claiming' : 'loading')}
      />
    )
  }
  if (state === 'claiming') {
    return (
      <div style={S.shell}>
        <div style={S.sub}>Adding {offer?.title || 'the desk'} to your workspace…</div>
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div style={S.shell}>
        <div style={S.card}>
          <div style={S.brand}>Plexii</div>
          <div style={S.sub}>The workspace could not start.</div>
          <div style={S.error}>{detail}</div>
        </div>
      </div>
    )
  }
  // 'loading' covers the page until the renderer mounts beneath; 'ready' means
  // the renderer owns the document and the gate renders nothing at all, which
  // lets #boot:empty take it out of the layout.
  if (state === 'loading') {
    return (
      <div style={S.shell}>
        <div style={S.card}>
          <div style={S.brand}>Plexii</div>
          <div style={S.sub}>Opening your workspace…</div>
          {/* A claim that failed after sign-up is said out loud here rather
              than swallowed: the visitor has an account but not the desk they
              came for, and needs to know to ask for a fresh link. */}
          {claimError && <div style={S.error}>{claimError}</div>}
        </div>
      </div>
    )
  }
  return <></>
}

const S: Record<string, React.CSSProperties> = {
  shell: { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
    background: '#0f1115', color: '#e7e9ee', fontFamily: 'Inter, system-ui, sans-serif' },
  card: { display: 'flex', flexDirection: 'column', gap: 12, width: 320, padding: 28,
    background: '#171a21', border: '1px solid #262b36', borderRadius: 14 },
  brand: { fontSize: 26, fontWeight: 600, letterSpacing: -0.4 },
  sub: { fontSize: 14, opacity: 0.7, marginBottom: 4 },
  input: { padding: '10px 12px', borderRadius: 8, border: '1px solid #2c313d',
    background: '#0f1115', color: '#e7e9ee', fontSize: 14, outline: 'none' },
  button: { padding: '10px 12px', borderRadius: 8, border: 'none', background: '#4f7cff',
    color: 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  link: { background: 'none', border: 'none', color: '#8fa6ff', fontSize: 13, cursor: 'pointer', padding: 0 },
  error: { color: '#ff8a8a', fontSize: 13, lineHeight: 1.4 },
  offer: {
    display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px', borderRadius: 10,
    background: '#12203a', border: '1px solid #24406e', marginBottom: 4
  },
  offerWho: { fontSize: 12, opacity: 0.75, letterSpacing: 0.2 },
  offerTitle: { fontSize: 17, fontWeight: 600 },
  offerWhat: { fontSize: 12, opacity: 0.7, lineHeight: 1.45 }
}

ReactDOM.createRoot(document.getElementById('boot') as HTMLElement).render(
  <React.StrictMode><Boot /></React.StrictMode>
)
