// The file-size cap, and keeping the client's copy of it honest.
//
// The server refuses bytes over MAX_LIVE_FILE_BYTES with a 413. The client now
// says so in advance, which is only an improvement while the two numbers agree
// -- a client that promises a 60MB file will sync, because its own constant
// drifted upward, is worse than one that said nothing at all.
//
// So this reads the server's source and compares. The two live in sibling
// packages of one repository; when the sibling is not present (a deploy context
// that checked out only this package) the comparison is skipped rather than
// failed, because absence is not disagreement.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  MAX_SYNCED_FILE_BYTES,
  exceedsSyncLimit,
  syncLimitLabel
} from '../../src/shared/fileSyncLimits'
import { MAX_PUBLIC_FILE_BYTES } from '../../src/renderer/src/lib/shareSnapshot'

describe('the cap itself', () => {
  it('is 50 MB', () => {
    expect(MAX_SYNCED_FILE_BYTES).toBe(50 * 1024 * 1024)
    expect(syncLimitLabel()).toBe('50 MB')
  })

  it('is one number, not two', () => {
    // The public-share path had its own copy with a comment saying it had to
    // match. A comment is not a mechanism.
    expect(MAX_PUBLIC_FILE_BYTES).toBe(MAX_SYNCED_FILE_BYTES)
  })
})

describe('exceedsSyncLimit', () => {
  it('is false at exactly the limit and true one byte over', () => {
    // The server's check is `> MAX`, so a file of exactly 50 MB is accepted.
    // Marking it as too large would be a lie in the safe direction, which is
    // still a lie.
    expect(exceedsSyncLimit(MAX_SYNCED_FILE_BYTES)).toBe(false)
    expect(exceedsSyncLimit(MAX_SYNCED_FILE_BYTES + 1)).toBe(true)
  })

  it('treats a missing or zero size as fine, never as oversized', () => {
    // A folder, a doc, or a row whose size was never recorded must not be
    // labelled undeliverable on the strength of a null.
    for (const v of [0, null, undefined]) expect(exceedsSyncLimit(v), String(v)).toBe(false)
  })

  it('flags the real files that prompted this', () => {
    expect(exceedsSyncLimit(4584 * 1024 * 1024)).toBe(true) // a 4.6GB installer
    expect(exceedsSyncLimit(184 * 1024 * 1024)).toBe(true) // a 184MB recording
    expect(exceedsSyncLimit(35 * 1024 * 1024)).toBe(false) // a 35MB zip, which does sync
  })
})

describe('agreement with the server', () => {
  const serverSrc = resolve(__dirname, '../../../focusbuddy-signal/src/server.ts')

  it.skipIf(!existsSync(serverSrc))('matches the server MAX_LIVE_FILE_BYTES', () => {
    const src = readFileSync(serverSrc, 'utf-8')
    const m = /const MAX_LIVE_FILE_BYTES\s*=\s*([^\n]+)/.exec(src)
    expect(m, 'MAX_LIVE_FILE_BYTES not found in the server source').toBeTruthy()
    // Evaluate the literal expression (e.g. `50 * 1024 * 1024`) rather than
    // matching its text, so a rewrite that keeps the value still passes.
    const expr = m![1].replace(/[^0-9*+\-/() ]/g, '').trim()
    // eslint-disable-next-line no-new-func
    const serverValue = Number(new Function(`return (${expr})`)())
    expect(serverValue).toBe(MAX_SYNCED_FILE_BYTES)
  })
})
