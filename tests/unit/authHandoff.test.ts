// What Plexii does with a haptyx://auth?token= link (security, 2026-11-20):
// only a sign-in it started is adopted without a question; every other link is
// checked with the server and asked about, naming the SERVER's account.
import { describe, expect, it, vi } from 'vitest'
import { receiveAuthHandoff, receiveAuthNotice, signInUrl, type HandoffDeps, type NoticeDeps } from '../../src/renderer/src/lib/authHandoff'

const SERVER = { id: 'a1', email: 'sender@evil.test' } as never
function deps(over: Partial<HandoffDeps> = {}): HandoffDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    getMe: vi.fn(async () => ({ status: 'ok', account: SERVER }) as never),
    confirm: vi.fn(async (r: { title: string; cancelIsDefault?: boolean }) => {
      asked.push(`${r.title}|cancelIsDefault=${r.cancelIsDefault}`)
      return false
    }) as never,
    alert: vi.fn(async () => undefined) as never,
    ...over
  }
}
const link = (startedHere: boolean) => ({ sessionToken: 'tok', email: 'victim@example.test', startedHere })

describe('a sign-in link', () => {
  it('Plexii started it: adopted at once, with no server check and no question', async () => {
    const d = deps(); const adopt = vi.fn(async () => undefined)
    expect(await receiveAuthHandoff(link(true), adopt, d)).toBe('adopted')
    expect(adopt).toHaveBeenCalledWith({ sessionToken: 'tok', email: 'victim@example.test' })
    expect(d.getMe).not.toHaveBeenCalled()
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('anything else is asked about, naming the server account (never the link email), Cancel by default', async () => {
    const d = deps(); const adopt = vi.fn(async () => undefined)
    expect(await receiveAuthHandoff(link(false), adopt, d)).toBe('declined')
    expect(d.asked).toEqual(['Sign in to Plexii as sender@evil.test?|cancelIsDefault=true'])
    expect(adopt).not.toHaveBeenCalled()
  })

  it('a yes adopts it, under the server account', async () => {
    const d = deps({ confirm: vi.fn(async () => true) as never }); const adopt = vi.fn(async () => undefined)
    expect(await receiveAuthHandoff(link(false), adopt, d)).toBe('adopted')
    expect(adopt).toHaveBeenCalledWith({ sessionToken: 'tok', email: 'sender@evil.test' })
  })

  it('a startedHere that is not exactly true is not trusted', async () => {
    const d = deps(); const adopt = vi.fn(async () => undefined)
    await receiveAuthHandoff({ sessionToken: 'tok', email: null, startedHere: 'yes' as never }, adopt, d)
    expect(d.confirm).toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
  })

  it('a token the server does not know: a notice, no question, nothing adopted', async () => {
    const d = deps({ getMe: vi.fn(async () => ({ status: 'unauthenticated' }) as never) }); const adopt = vi.fn(async () => undefined)
    expect(await receiveAuthHandoff(link(false), adopt, d)).toBe('invalid')
    expect(d.alert).toHaveBeenCalled()
    expect(d.confirm).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
  })

  it('the server cannot be reached: a notice, nothing adopted', async () => {
    const d = deps({ getMe: vi.fn(async () => ({ status: 'unreachable' }) as never) }); const adopt = vi.fn(async () => undefined)
    expect(await receiveAuthHandoff(link(false), adopt, d)).toBe('unreachable')
    expect(adopt).not.toHaveBeenCalled()
  })
})

// ── Auth step 2 (2026-11-20): the URL a sign-in opens, and the notices ──────
describe('the URL a sign-in this app starts opens', () => {
  const begin = { state: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345', codeChallenge: 'X'.repeat(43) }
  it('the website: state, PKCE challenge (S256) and this client', () => {
    const u = new URL(signInUrl('https://www.plexiidesk.com/account/login?from=app', 'website', begin))
    expect(Object.fromEntries(u.searchParams)).toEqual({
      from: 'app',
      state: begin.state,
      code_challenge: begin.codeChallenge,
      code_challenge_method: 'S256',
      client_id: 'plexiidesk'
    })
  })
  it('SSO: state and PKCE challenge, as /auth/sso/start takes them (no client)', () => {
    const u = new URL(signInUrl('https://api.plexiidesk.com/auth/sso/start?domain=acme.com', 'sso', begin))
    expect(Object.fromEntries(u.searchParams)).toEqual({ domain: 'acme.com', state: begin.state, code_challenge: begin.codeChallenge, code_challenge_method: 'S256' })
  })
  it('the verifier is never in it', () => {
    expect(signInUrl('https://x.test/a', 'website', begin)).not.toMatch(/verifier/)
  })
})

describe('what the window does with a notice from main', () => {
  function noticeDeps(over: Partial<NoticeDeps> = {}): NoticeDeps & { alerts: string[]; toasts: string[]; began: number } {
    const d = {
      alerts: [] as string[],
      toasts: [] as string[],
      began: 0,
      alert: vi.fn(async (a: { title: string; body?: string }) => {
        d.alerts.push(`${a.title} | ${a.body ?? ''}`)
      }) as never,
      notify: (text: string) => {
        d.toasts.push(text)
      },
      signedInAs: () => null as string | null,
      beginBrowserSignIn: async () => {
        d.began++
      },
      ...over
    }
    return d
  }

  it('a code link this Plexii did not start: one alert, saying so plainly', async () => {
    const d = noticeDeps()
    await receiveAuthNotice({ kind: 'link-refused', why: 'not-started' }, d)
    expect(d.alerts).toEqual(['This sign-in link has expired or wasn’t started from this Plexii | Sign in again from Plexii.'])
  })

  it('the server said no, or could not be reached', async () => {
    const d = noticeDeps()
    await receiveAuthNotice({ kind: 'link-refused', why: 'refused' }, d)
    await receiveAuthNotice({ kind: 'link-refused', why: 'unreachable' }, d)
    expect(d.alerts).toEqual([
      'This sign-in link has expired | Sign in again from Plexii.',
      'Plexii couldn’t finish signing in | It couldn’t reach the server. Check your connection, then sign in again from Plexii.'
    ])
  })

  it('one alert at a time: links arriving while one is up are not stacked on top', async () => {
    let close: () => void = () => {}
    const d = noticeDeps({
      alert: vi.fn(
        () =>
          new Promise<void>((r) => {
            close = r
          })
      ) as never
    })
    const first = receiveAuthNotice({ kind: 'link-refused', why: 'not-started' }, d)
    await receiveAuthNotice({ kind: 'link-refused', why: 'not-started' }, d)
    await receiveAuthNotice({ kind: 'link-refused', why: 'refused' }, d)
    expect(d.alert).toHaveBeenCalledTimes(1)
    close()
    await first
    // Once it is closed, the next one is shown.
    const next = receiveAuthNotice({ kind: 'link-refused', why: 'refused' }, d)
    expect(d.alert).toHaveBeenCalledTimes(2)
    close()
    await next
  })

  it('/start with nobody signed in: a sign-in begins in the browser', async () => {
    const d = noticeDeps()
    await receiveAuthNotice({ kind: 'start' }, d)
    expect(d.began).toBe(1)
    expect(d.alerts).toEqual([])
  })

  it('/start with someone signed in: never switches accounts; a quiet line says who is signed in', async () => {
    const d = noticeDeps({ signedInAs: () => 'me@example.com' })
    await receiveAuthNotice({ kind: 'start' }, d)
    expect(d.began).toBe(0)
    expect(d.toasts).toEqual(['You’re already signed in to Plexii as me@example.com.'])
  })
})

