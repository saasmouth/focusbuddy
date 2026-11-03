// A browser widget recognises its own late-arriving saves (lib/recentOwnWrites).
import { describe, expect, it } from 'vitest'
import { OWN_WRITE_WINDOW_MS, RecentOwnWrites } from '../../src/renderer/src/lib/recentOwnWrites'

describe('RecentOwnWrites', () => {
  it('an older save echoing after newer ones is still recognised as our own', () => {
    const w = new RecentOwnWrites('https://q.example/', 0)
    for (let i = 1; i <= 5; i++) w.note(`https://q.example/?t=${i}`, i * 120)
    // the store's echo of t=1 arrives last — it is ours, not a load request
    expect(w.has('https://q.example/?t=1', 700)).toBe(true)
    expect(w.has('https://q.example/', 700)).toBe(true)
  })
  it('a URL we never saved is an outside change', () => {
    const w = new RecentOwnWrites('https://a.example/', 0)
    expect(w.has('https://b.example/', 10)).toBe(false)
  })
  it('own saves are forgotten after the window, so a later outside write of the same URL loads', () => {
    const w = new RecentOwnWrites(undefined, 0)
    w.note('https://a.example/x', 0)
    expect(w.has('https://a.example/x', OWN_WRITE_WINDOW_MS)).toBe(true)
    expect(w.has('https://a.example/x', OWN_WRITE_WINDOW_MS + 1)).toBe(false)
  })
  it('stays bounded, and reset starts over', () => {
    const w = new RecentOwnWrites()
    for (let i = 0; i < 500; i++) w.note(`https://a.example/${i}`, 1000)
    expect(w.has('https://a.example/499', 1000)).toBe(true)
    expect(w.has('https://a.example/0', 1000)).toBe(false)
    w.reset('https://b.example/', 1000)
    expect(w.has('https://a.example/499', 1000)).toBe(false)
    expect(w.has('https://b.example/', 1000)).toBe(true)
  })
})
