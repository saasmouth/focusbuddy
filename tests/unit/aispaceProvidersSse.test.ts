// @vitest-environment node
//
// The pure pieces under the model adapters: the SSE reader, Retry-After,
// catalogue-id matching and secret scrubbing.

import { describe, expect, it } from 'vitest'
import { listedMatches, parseRetryAfter, readSse, type SseEvent } from '../../src/main/aispace/providers/http'
import { scrubSecret } from '../../src/main/aispace/providers/types'

function streamOf(parts: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++])
      else ctrl.close()
    },
    cancel() {
      onCancel?.()
    }
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const ev of readSse(body)) out.push(ev)
  return out
}

// Every line-ending style, a comment, a multi-line data field, a field with no
// space after the colon, an event with no data (not dispatched), a default
// event name, and multi-byte UTF-8.
const RAW =
  ': comment first\n\n' +
  'event: alpha\ndata: {"t":"é日本"}\n\n' +
  'event: beta\r\ndata: line one\r\ndata: line two\r\n\r\n' +
  'event: gamma\rdata:no-space\r\r' +
  'event: empty\n\n' +
  'data: default name\n\n' +
  'event: trailing\ndata: never ended'

const EXPECTED: SseEvent[] = [
  { event: 'alpha', data: '{"t":"é日本"}' },
  { event: 'beta', data: 'line one\nline two' },
  { event: 'gamma', data: 'no-space' },
  { event: 'message', data: 'default name' }
]

describe('readSse', () => {
  it('parses every line-ending style and discards an unterminated last event', async () => {
    expect(await collect(streamOf([new TextEncoder().encode(RAW)]))).toEqual(EXPECTED)
  })

  it('gives the same events however the bytes are split (CR/LF and UTF-8 across chunks)', async () => {
    const bytes = new TextEncoder().encode(RAW)
    for (let cut = 1; cut < bytes.length; cut++) {
      const events = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]))
      expect(events, `split at byte ${cut}`).toEqual(EXPECTED)
    }
    // And one byte at a time.
    expect(await collect(streamOf(Array.from(bytes, (b) => Uint8Array.of(b))))).toEqual(EXPECTED)
  })

  it('reports every chunk as activity, comments included', async () => {
    let seen = 0
    const body = streamOf([new TextEncoder().encode(': ping\n\n'), new TextEncoder().encode('data: x\n\n')])
    for await (const _ of readSse(body, () => seen++)) void _
    expect(seen).toBe(2)
  })

  it('cancels the body when the reader stops early, so the connection closes', async () => {
    let cancelled = false
    const parts = [new TextEncoder().encode('data: 1\n\n'), new TextEncoder().encode('data: 2\n\n')]
    for await (const _ of readSse(streamOf(parts, () => (cancelled = true)))) {
      void _
      break
    }
    expect(cancelled).toBe(true)
  })
})

describe('parseRetryAfter', () => {
  const h = (init: Record<string, string>): Headers => new Headers(init)
  it('reads seconds, milliseconds and HTTP dates', () => {
    expect(parseRetryAfter(h({ 'retry-after': '7' }))).toBe(7_000)
    expect(parseRetryAfter(h({ 'retry-after': '1.5' }))).toBe(1_500)
    expect(parseRetryAfter(h({ 'retry-after-ms': '250', 'retry-after': '9' }))).toBe(250)
    const now = Date.parse('2026-11-24T10:00:00Z')
    expect(parseRetryAfter(h({ 'retry-after': 'Tue, 24 Nov 2026 10:00:30 GMT' }), now)).toBe(30_000)
    expect(parseRetryAfter(h({ 'retry-after': 'Tue, 24 Nov 2026 09:00:00 GMT' }), now)).toBe(0)
  })
  it('returns null when absent or unreadable', () => {
    expect(parseRetryAfter(h({}))).toBeNull()
    expect(parseRetryAfter(h({ 'retry-after': 'soon' }))).toBeNull()
  })
})

describe('listedMatches', () => {
  it('accepts the exact id and dated snapshots only', () => {
    expect(listedMatches('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true)
    expect(listedMatches('claude-sonnet-5-5-20261001', 'claude-sonnet-5-5')).toBe(true)
    expect(listedMatches('gpt-5.5-2026-10-01', 'gpt-5.5')).toBe(true)
    expect(listedMatches('claude-sonnet-5-5-preview', 'claude-sonnet-5-5')).toBe(false)
    expect(listedMatches('claude-sonnet-5-50', 'claude-sonnet-5-5')).toBe(false)
    expect(listedMatches('gpt-5.5-turbo', 'gpt-5.5')).toBe(false)
    expect(listedMatches('gpt-5.5-mini', 'gpt-5.5')).toBe(false)
  })
})

describe('scrubSecret', () => {
  it('removes the exact secret whatever its shape, and anything key-shaped', () => {
    expect(scrubSecret('key=odd.KEY.123456 next', 'odd.KEY.123456')).toBe('key=[redacted] next')
    expect(scrubSecret('see sk-ant-test-abcdefghijklmnop here')).toBe('see [redacted] here')
    expect(scrubSecret('Authorization: Bearer abcdefghijklmnopqrstu')).toBe('Authorization: Bearer [redacted]')
  })
})
