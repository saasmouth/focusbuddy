import { describe, expect, it } from 'vitest'
import { dismissOverlaysJs, overlayNotice } from '../../src/main/ai/browserOverlays'

// The consent-wall pass, RUN against a real DOM rather than asserted on its
// source. It executes inside arbitrary pages on the open web, so the failure
// that matters is not "missed a banner" — it is "hid the article".

interface Result { hidden: string[]; unfroze: boolean }

// The test environment has no layout engine, so every rect is 0x0 and the
// "is this big enough to be in the way" test could never fire. A real browser
// measures; here the declared size stands in for it.
function giveLayout(): void {
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const st = (el as HTMLElement).style
    const w = parseFloat(st.width) || 0
    const h = parseFloat(st.height) || 0
    ;(el as HTMLElement).getBoundingClientRect = () =>
      ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 }) as DOMRect
  }
}

function run(html: string, style = ''): Result {
  document.head.innerHTML = `<style>${style}</style>`
  document.body.innerHTML = html
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
  giveLayout()
  // eslint-disable-next-line no-eval
  return eval(dismissOverlaysJs()) as Result
}

const BIG = 'position:fixed;width:900px;height:300px;'
const vis = (sel: string): string => (document.querySelector(sel) as HTMLElement)?.style.display ?? ''

describe('hiding consent walls', () => {
  it('hides a fixed banner that talks about cookies', () => {
    const r = run(
      `<div id="cmp" style="${BIG}">We value your privacy. We and our partners use cookies.
        <button>Accept all</button></div>
       <main id="content">The actual article.</main>`
    )
    expect(r.hidden).toHaveLength(1)
    expect(vis('#cmp')).toBe('none')
    expect(vis('#content'), 'the page itself must survive').not.toBe('none')
  })

  it('leaves ordinary fixed furniture alone', () => {
    // A sticky header and a chat bubble are fixed too. Hiding those would be
    // vandalism, and the page would still read fine, so nothing would report it.
    const r = run(
      `<header id="nav" style="${BIG}">Home · Products · Pricing</header>
       <div id="chat" style="position:fixed;width:300px;height:300px;">Chat with us</div>`
    )
    expect(r.hidden).toEqual([])
    expect(vis('#nav')).not.toBe('none')
    expect(vis('#chat')).not.toBe('none')
  })

  it('leaves content that merely mentions cookies alone', () => {
    // An article ABOUT cookie law is not a cookie banner. Position is what
    // separates them, which is why it is tested before the text.
    const r = run(`<article id="a">Cookie consent under GDPR: a guide to tracking rules.</article>`)
    expect(r.hidden).toEqual([])
    expect(vis('#a')).not.toBe('none')
  })

  it('refuses to hide a wrapper that CONTAINS the page', () => {
    // Some sites render everything inside a fixed shell. Hiding that blanks the
    // document and the run then reports on an empty page.
    const r = run(
      `<div id="shell" style="${BIG}">We use cookies.<main id="real">Everything.</main></div>`
    )
    expect(r.hidden).toEqual([])
    expect(vis('#shell')).not.toBe('none')
    expect(vis('#real')).not.toBe('none')
  })

  it('ignores a banner too small to be in the way', () => {
    const r = run(`<div id="tiny" style="position:fixed;width:80px;height:30px;">cookies</div>`)
    expect(r.hidden).toEqual([])
  })

  it('gives the page its scrolling back', () => {
    // Consent walls freeze the body; a run that cannot scroll reads one
    // screenful of a long page and concludes that is all there is.
    const r = run(`<div id="cmp" style="${BIG}">This site uses cookies.</div>`, 'body{overflow:hidden}')
    expect(r.unfroze).toBe(true)
    expect(document.body.style.overflow).toBe('auto')
  })

  it('never throws on a page with nothing in it', () => {
    expect(() => run('')).not.toThrow()
    expect(run('')).toEqual({ hidden: [], unfroze: false })
  })
})

describe('overlayNotice', () => {
  it('tells the model the banner is gone and not to answer it', () => {
    // Without this the banner it saw last round has simply vanished, and it
    // will reasonably conclude its click worked and keep clicking.
    const n = overlayNotice({ hidden: ['We value your privacy'], unfroze: true })
    expect(n).toContain('hidden for you')
    expect(n).toMatch(/do NOT try to accept/i)
  })

  it('says nothing when nothing was in the way', () => {
    expect(overlayNotice({ hidden: [], unfroze: false })).toBeNull()
    expect(overlayNotice(null)).toBeNull()
  })

  it('still reports a page that was merely frozen', () => {
    expect(overlayNotice({ hidden: [], unfroze: true })).toContain('scrolling')
  })
})
