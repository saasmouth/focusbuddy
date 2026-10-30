import { describe, it, expect, vi, afterEach } from 'vitest'

// A page read must ALWAYS finish (reported from live use, 2026-10-30).
//
// The sidebar assistant hung for 373 seconds and produced nothing. The cause
// was here: the abort timer was cleared the moment the response HEADERS
// arrived, and `res.text()` then read the body with no deadline at all. A
// server that answers immediately and then drips its body forever held the
// promise open, so Promise.all in prepareChatCall never settled, so the chat
// never got a prompt to send. No error, no timeout, no output.
//
// The old code had the same hole, but only desk agents reached it — a rare,
// user-initiated, visibly-running thing. Putting it in the chat path turned a
// latent flaw into a hang on an ordinary question.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

/** Headers arrive at once; the body never produces a byte and never ends. */
function neverEndingBody(): Response {
  const stream = new ReadableStream({
    start() {
      /* deliberately never enqueues and never closes */
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } })
}

describe('fetchPageText always finishes', () => {
  it('gives up on a body that never arrives, instead of hanging', async () => {
    globalThis.fetch = (async () => neverEndingBody()) as unknown as typeof fetch
    const { fetchPageText, isFetchFailure } = await import('../../src/main/webPage')
    const started = Date.now()
    const out = await fetchPageText('https://slow.test/page', 1000, 400)
    const took = Date.now() - started
    expect(isFetchFailure(out)).toBe(true)
    // Well inside the deadline, and nowhere near the 373 seconds reported.
    expect(took).toBeLessThan(3000)
  })

  it('stops at the cap instead of buffering an endless body', async () => {
    // A body that keeps producing. Without a byte cap this never returns and
    // eats memory on the way.
    const chunk = new TextEncoder().encode('x'.repeat(4096))
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(chunk)
          }
        }),
        { status: 200, headers: { 'content-type': 'text/html' } }
      )) as unknown as typeof fetch
    const { fetchPageText, isFetchFailure } = await import('../../src/main/webPage')
    const out = await fetchPageText('https://endless.test/page', 2000, 5000)
    expect(isFetchFailure(out)).toBe(false)
    expect(out.length).toBeLessThanOrEqual(2000)
  })

  it('still reads an ordinary page', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><title>Hi</title><body><p>Real content here.</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as unknown as typeof fetch
    const { fetchPageText } = await import('../../src/main/webPage')
    const out = await fetchPageText('https://ok.test/page')
    expect(out).toContain('Page title: Hi')
    expect(out).toContain('Real content here.')
  })
})
