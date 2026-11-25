// The window takes what main kept for it, without a gap (4.3.56).
//
// Main keeps every link until a window takes it (deepLinkDelivery.test.ts); the
// message it sends is a nudge. App.tsx took what waited FIRST and subscribed
// after (an await apart; for share and meeting links, a whole accept or join),
// so a link arriving in between was lost. listenThenTake subscribes first, takes
// on every nudge, and hands each item over once, in order.
import { describe, expect, it } from 'vitest'
import { listenThenTake, listenThenTakeAll } from '../../src/renderer/src/lib/listenThenTake'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function harness<T>(initial: T[]) {
  const waiting = [...initial]
  const log: string[] = []
  let nudge: (() => void) | null = null
  const listen = (n: () => void): (() => void) => {
    log.push('listen')
    nudge = n
    return () => {
      log.push('unlisten')
      nudge = null
    }
  }
  const takeOne = async (): Promise<T | null> => {
    log.push('take')
    await tick()
    return waiting.length ? (waiting.shift() as T) : null
  }
  const takeAll = async (): Promise<T[]> => {
    log.push('take')
    await tick()
    return waiting.splice(0)
  }
  return { waiting, log, listen, takeOne, takeAll, nudge: () => nudge?.() }
}

describe('listenThenTake', () => {
  it('listens before it first takes', async () => {
    const h = harness(['a'])
    const got: string[] = []
    listenThenTake(h.listen, h.takeOne, (x) => void got.push(x))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.log[0]).toBe('listen')
    expect(got).toEqual(['a'])
  })

  it('an item that arrives while the first is being handled (a slow accept) is not lost', async () => {
    const h = harness(['a'])
    const got: string[] = []
    let release: () => void = () => undefined
    listenThenTake(h.listen, h.takeOne, async (x) => {
      got.push(x)
      if (x === 'a') await new Promise<void>((r) => (release = r))
    })
    await new Promise((r) => setTimeout(r, 10))
    h.waiting.push('b')
    h.nudge()
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual(['a', 'b'])
  })

  it('handling is not waited for: a second item is handed over while the first is still open (an alert up)', async () => {
    const h = harness(['a', 'b'])
    const got: string[] = []
    listenThenTake(h.listen, h.takeOne, (x) => {
      got.push(x)
      return new Promise(() => undefined) // never closes
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual(['a', 'b'])
  })

  it('each item once, in order, however many nudges', async () => {
    const h = harness<string>([])
    const got: string[] = []
    listenThenTake(h.listen, h.takeOne, (x) => void got.push(x))
    h.waiting.push('a', 'b', 'c')
    h.nudge()
    h.nudge()
    h.nudge()
    await new Promise((r) => setTimeout(r, 30))
    expect(got).toEqual(['a', 'b', 'c'])
  })

  it('one item failing does not stop the rest', async () => {
    const h = harness(['bad', 'good'])
    const got: string[] = []
    listenThenTake(h.listen, h.takeOne, (x) => {
      if (x === 'bad') throw new Error('no')
      got.push(x)
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual(['good'])
  })

  it('stopped: it stops listening and takes nothing more', async () => {
    const h = harness<string>([])
    const got: string[] = []
    const stop = listenThenTake(h.listen, h.takeOne, (x) => void got.push(x))
    await new Promise((r) => setTimeout(r, 10))
    stop()
    h.waiting.push('late')
    h.nudge()
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([])
    expect(h.waiting, 'left for the next window to take').toEqual(['late'])
  })
})

describe('listenThenTakeAll (notices come as a batch)', () => {
  it('listens first, then hands over each waiting notice once', async () => {
    const h = harness(['n1', 'n2'])
    const got: string[] = []
    listenThenTakeAll(h.listen, h.takeAll, (x) => void got.push(x))
    h.waiting.push('n3')
    h.nudge()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.log[0]).toBe('listen')
    expect(got).toEqual(['n1', 'n2', 'n3'])
  })
})

describe('App.tsx uses it for every link main keeps', () => {
  it('auth, share, meeting and markdown links one at a time, notices as a batch', async () => {
    const src = (await import('node:fs')).readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(src).toContain('listenThenTake(window.api.auth.onIncomingToken')
    expect(src).toContain('listenThenTake(window.api.share.onIncomingToken')
    expect(src).toContain('listenThenTake(window.api.meet.onIncomingRoom')
    expect(src).toContain('listenThenTake(window.api.mdext.onIncomingPath')
    expect(src).toContain('listenThenTakeAll(api.onNotice')
  })
})
