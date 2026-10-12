/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { checkArgs, violationMessage, type ArgSpec } from '../../src/main/ipc/contracts'
import { IPC_ARG_CONTRACTS } from '../../src/main/ipc/ipcContracts.generated'

// The registry is GENERATED from the handler signatures. That is only safe while
// something proves the two have not drifted — otherwise a changed signature
// leaves a stale contract quietly rejecting or admitting the wrong thing, which
// is the same trap two hand-written copies of the work-item column manifest set.
const require = createRequire(import.meta.url)
const { derive } = require('../../scripts/derive-ipc-contracts.cjs') as {
  derive: () => Record<string, ArgSpec[]>
}

describe('the generated contracts match the handlers they came from', () => {
  it('has not drifted from the source signatures', () => {
    const fresh = derive()
    const committed = IPC_ARG_CONTRACTS as Record<string, readonly ArgSpec[]>

    const missing = Object.keys(fresh).filter((ch) => !(ch in committed))
    const stale = Object.keys(committed).filter((ch) => !(ch in fresh))
    expect(
      missing,
      `handlers gained enforceable arguments but the registry was not regenerated.\n` +
        `Run: node scripts/derive-ipc-contracts.cjs --write`
    ).toEqual([])
    expect(
      stale,
      `the registry names channels the handlers no longer declare.\n` +
        `Run: node scripts/derive-ipc-contracts.cjs --write`
    ).toEqual([])

    for (const [ch, spec] of Object.entries(fresh)) {
      expect(committed[ch], `${ch} contract differs from its signature`).toEqual(spec)
    }
  })

  it('covers a meaningful share of the IPC surface', () => {
    // Not a coverage target for its own sake — a floor, so a future refactor that
    // quietly emptied the registry would fail loudly rather than silently
    // disabling validation everywhere.
    expect(Object.keys(IPC_ARG_CONTRACTS).length).toBeGreaterThan(250)
  })
})

describe('checkArgs', () => {
  const S: ArgSpec = { kind: 'string', optional: false, nullable: false }
  const N: ArgSpec = { kind: 'number', optional: false, nullable: false }
  const O: ArgSpec = { kind: 'object', optional: false, nullable: false }

  it('accepts a call that matches', () => {
    expect(checkArgs([S], ['abc'])).toBeNull()
    expect(checkArgs([S, N], ['abc', 3])).toBeNull()
  })

  it('rejects the exact shape that reached SQLite: a missing id', () => {
    expect(checkArgs([S], [])).toEqual({ index: 0, expected: 'string', got: 'nothing' })
    expect(checkArgs([S], [undefined])).toEqual({ index: 0, expected: 'string', got: 'nothing' })
  })

  it('rejects the wrong primitive type', () => {
    expect(checkArgs([S], [42])?.got).toBe('number')
    expect(checkArgs([N], ['42'])?.got).toBe('string')
  })

  it('honours optional and nullable exactly as declared', () => {
    const opt: ArgSpec = { kind: 'string', optional: true, nullable: false }
    const nul: ArgSpec = { kind: 'string', optional: false, nullable: true }
    expect(checkArgs([opt], [])).toBeNull()
    expect(checkArgs([opt], [undefined])).toBeNull()
    expect(checkArgs([nul], [null])).toBeNull()
    expect(checkArgs([{ kind: 'string', optional: false, nullable: false }], [null])?.got).toBe('null')
  })

  it('treats an array as not-an-object, since no handler declares one', () => {
    expect(checkArgs([O], [{}])).toBeNull()
    expect(checkArgs([O], [[1, 2]])?.got).toBe('an array')
    expect(checkArgs([O], ['nope'])?.got).toBe('string')
  })

  it('lets anything through where the type could not be resolved', () => {
    const any: ArgSpec = { kind: 'any', optional: false, nullable: false }
    expect(checkArgs([any], ['x'])).toBeNull()
    expect(checkArgs([any], [{ a: 1 }])).toBeNull()
    // Still requires SOMETHING — a declared non-optional argument must be passed.
    expect(checkArgs([any], [])?.got).toBe('nothing')
  })

  it('still bounds and sanitises structurally unsafe values for any signatures', () => {
    const any: ArgSpec = { kind: 'any', optional: false, nullable: false }
    expect(checkArgs([any], [Number.POSITIVE_INFINITY])?.got).toBe('a non-finite number')
    expect(checkArgs([any], ['x'.repeat(8 * 1024 * 1024 + 1)])?.got).toBe('an oversized string')
    expect(checkArgs([any], [{ prototype: 'pollute' }])?.got).toContain('forbidden')
    expect(checkArgs([any], [new Uint8Array(16 * 1024 * 1024 + 1)])?.got).toBe('oversized binary data')
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(checkArgs([any], [cyclic])?.got).toBe('cyclic data')
  })

  it('explains the refusal without naming anything internal', () => {
    const msg = violationMessage('workItems:get', { index: 0, expected: 'string', got: 'nothing' })
    expect(msg).toContain('workItems:get')
    expect(msg).toContain('parameter 1')
    expect(msg).toContain('should be a string')
    expect(msg).not.toMatch(/\/Users\/|SQLITE|at .*\(/)
  })
})
