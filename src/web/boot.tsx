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
import { installBrowserApi } from './api/bridge'
import { login, signup, resolveSession, type CloudAccount } from './api/session'

function SignIn({ onDone }: { onDone: (a: CloudAccount | null) => void }): React.JSX.Element {
  const [mode, setMode] = useState<'in' | 'up'>('in')
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
    const result = mode === 'in' ? await login(email, password, code || undefined) : await signup(email, password)
    setBusy(false)
    if (result.ok) { onDone(result.account ?? null); return }
    if (result.needsCode) { setNeedsCode(true); return }
    setError(result.error ?? 'Sign-in failed.')
  }

  return (
    <div style={S.shell}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.brand}>Plexii</div>
        <div style={S.sub}>{mode === 'in' ? 'Sign in to your workspace' : 'Create your workspace'}</div>
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
          {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
        <button style={S.link} type="button" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null) }}>
          {mode === 'in' ? 'Create an account instead' : 'I already have an account'}
        </button>
      </form>
    </div>
  )
}

function Boot(): React.JSX.Element {
  const [state, setState] = useState<'checking' | 'signin' | 'loading' | 'ready' | 'failed'>('checking')
  const [detail, setDetail] = useState('')

  useEffect(() => {
    void resolveSession().then((account) => setState(account ? 'loading' : 'signin'))
  }, [])

  useEffect(() => {
    if (state !== 'loading') return
    installBrowserApi()
    // Dynamic, and only now: importing the renderer statically would evaluate
    // its module graph -- and its window.api reads -- during this file's own
    // import, before the line above had run.
    import('@renderer/main')
      .then(() => setState('ready'))
      .catch((err: Error) => { setDetail(err.message); setState('failed') })
  }, [state])

  if (state === 'checking') return <div style={S.shell}><div style={S.sub}>Checking your session…</div></div>
  if (state === 'signin') return <SignIn onDone={() => setState('loading')} />
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
  return state === 'loading' ? <div style={S.shell}><div style={S.sub}>Opening your workspace…</div></div> : <></>
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
  error: { color: '#ff8a8a', fontSize: 13, lineHeight: 1.4 }
}

ReactDOM.createRoot(document.getElementById('boot') as HTMLElement).render(
  <React.StrictMode><Boot /></React.StrictMode>
)
