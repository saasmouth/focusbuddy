// What Plexii does with a haptyx://auth?token= link (security, 2026-11-20):
// only a sign-in it started is adopted without a question; every other link is
// checked with the server and asked about, naming the SERVER's account.
import { describe, expect, it, vi } from 'vitest'
import { receiveAuthHandoff, type HandoffDeps } from '../../src/renderer/src/lib/authHandoff'

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
