// The browser runtime's crypto shim against the real thing.
//
// The event store hashes each event's canonical JSON and chains it, so a
// browser-computed hash that differs from Node's by one byte would produce a
// chain the desktop reads as broken -- silently, and only for events that
// originated in the cloud. These compare the shim's output to node:crypto for
// the shapes the call sites actually produce.
import { describe, it, expect } from 'vitest'
import { createHash as nodeCreateHash } from 'node:crypto'
import { createHash, randomUUID } from '../../src/web/shims/crypto'

const nodeHash = (s: string): string => nodeCreateHash('sha256').update(s).digest('hex')

describe('createHash sha256', () => {
  it('matches node for the empty string', () => {
    expect(createHash('sha256').update('').digest('hex')).toBe(nodeHash(''))
  })

  it('matches node for the canonical event JSON the event store hashes', () => {
    const json = JSON.stringify({
      eventType: 'WidgetUpdated',
      subjectId: 'wid_01HZX',
      at: 1788907880959,
      payload: { title: 'Q3 planning', x: 120, y: 340 }
    })
    expect(createHash('sha256').update(json).digest('hex')).toBe(nodeHash(json))
  })

  it('matches node across every length near a block boundary', () => {
    // 55/56/57 and 63/64/65 are where the padding either fits in the block, or
    // forces one more -- the classic place a hand-written SHA-256 goes wrong.
    for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const s = 'a'.repeat(n)
      expect(createHash('sha256').update(s).digest('hex'), `length ${n}`).toBe(nodeHash(s))
    }
  })

  it('matches node for multi-byte UTF-8, which desk titles contain', () => {
    for (const s of ['Réunion', '设计评审', 'naïve café', '🧠 brain desk', 'Ω≈ç√']) {
      expect(createHash('sha256').update(s).digest('hex'), s).toBe(nodeHash(s))
    }
  })

  it('accumulates chained update() calls exactly as node does', () => {
    const chained = createHash('sha256').update('abc').update('def').update('ghi').digest('hex')
    expect(chained).toBe(nodeHash('abcdefghi'))
  })

  it('refuses algorithms it does not implement rather than returning a wrong digest', () => {
    expect(() => createHash('md5')).toThrow(/only sha256/)
    expect(() => createHash('sha256').digest('base64' as 'hex')).toThrow(/only hex/)
  })
})

describe('randomUUID', () => {
  it('produces distinct v4 uuids', () => {
    const a = randomUUID()
    const b = randomUUID()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })
})
