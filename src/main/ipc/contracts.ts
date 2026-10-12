// Argument contracts for the IPC boundary.
//
// The renderer is the least trusted part of an Electron app, and until now
// nothing checked what it sent. Measured against a booted build, 151 of 429
// handlers could be driven into the database or the filesystem with garbage —
// an id that was undefined, a number where a string was expected — and only
// failed once SQLite refused the bind. The error boundary stopped that leaking
// detail back to the caller; it did not stop the handler ACTING on it.
//
// Two deliberate choices:
//
//   1. Contracts are DERIVED from the handler signatures, not hand-written. A
//      hand-kept second copy of 151 argument lists is the same trap the work-item
//      column manifest documents, and it would rot the first time a signature
//      changed. `tests/unit/ipcContracts.test.ts` re-derives from source and
//      fails if the registry and the handlers disagree.
//
//   2. It is PERMISSIVE by default. Only argument types the deriver actually
//      understands (string, number, boolean, and their nullable forms) are
//      enforced, and only when the parameter is not optional. Anything else is
//      accepted. A validator that guesses is a validator that rejects legitimate
//      calls, and a broken feature is worse than an unvalidated one.

export type ArgKind = 'string' | 'number' | 'boolean' | 'object' | 'any'

export interface ArgSpec {
  kind: ArgKind
  optional: boolean
  nullable: boolean
}

/** Why an argument was refused — user-facing, no internals. */
export interface ContractViolation {
  index: number
  expected: string
  got: string
}

const MAX_STRING_BYTES = 8 * 1024 * 1024
const MAX_BINARY_BYTES = 16 * 1024 * 1024
const MAX_DEPTH = 32
const MAX_VALUES = 100_000
const MAX_COLLECTION_ITEMS = 50_000
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

interface PayloadBudget {
  values: number
  seen: WeakSet<object>
}

/**
 * Validate the parts that a generated TypeScript contract cannot express:
 * bounded size/depth, finite numbers, plain structured-clone data and no
 * prototype-pollution keys. This also covers arguments whose derived kind is
 * `any`, so a permissive signature is not an unlimited IPC payload.
 */
function payloadIssue(value: unknown, depth: number, budget: PayloadBudget): string | null {
  budget.values += 1
  if (budget.values > MAX_VALUES) return `more than ${MAX_VALUES.toLocaleString()} values`
  if (depth > MAX_DEPTH) return `data nested more than ${MAX_DEPTH} levels deep`
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES ? 'an oversized string' : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'a non-finite number'
  if (typeof value !== 'object') return `an unsupported ${typeof value}`

  if (value instanceof ArrayBuffer) {
    return value.byteLength > MAX_BINARY_BYTES ? 'oversized binary data' : null
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength > MAX_BINARY_BYTES ? 'oversized binary data' : null
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? null : 'an invalid date'

  if (budget.seen.has(value)) return 'cyclic data'
  budget.seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) return 'an oversized array'
    for (const item of value) {
      const issue = payloadIssue(item, depth + 1, budget)
      if (issue) return issue
    }
    return null
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return 'a non-plain object'
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_COLLECTION_ITEMS) return 'an object with too many fields'
  for (const [key, item] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return `a forbidden “${key}” field`
    const issue = payloadIssue(item, depth + 1, budget)
    if (issue) return issue
  }
  return null
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'nothing'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/** Check one call's arguments against a spec. Returns null when acceptable. */
export function checkArgs(spec: readonly ArgSpec[], args: readonly unknown[]): ContractViolation | null {
  const budget: PayloadBudget = { values: 0, seen: new WeakSet() }
  for (let i = 0; i < args.length; i++) {
    const issue = payloadIssue(args[i], 0, budget)
    if (issue) return { index: i, expected: 'safe structured value', got: issue }
  }
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i]
    const v = args[i]
    if (v === undefined) {
      if (s.optional) continue
      return { index: i, expected: s.kind, got: 'nothing' }
    }
    if (v === null) {
      if (s.nullable || s.optional) continue
      return { index: i, expected: s.kind, got: 'null' }
    }
    if (s.kind === 'any') continue
    if (s.kind === 'object') {
      // An array is not the object shape any of these handlers declare, and
      // passing one through is how a draft reaches the database as nonsense.
      if (typeof v !== 'object' || Array.isArray(v)) return { index: i, expected: 'object', got: describe(v) }
      continue
    }
    // eslint-disable-next-line valid-typeof
    if (typeof v !== s.kind) return { index: i, expected: s.kind, got: describe(v) }
  }
  return null
}

/** A message safe to show a user: says what was wrong, names nothing internal. */
export function violationMessage(channel: string, v: ContractViolation): string {
  return (
    `"${channel}" was called with the wrong arguments: parameter ${v.index + 1} ` +
    `should be ${v.expected === 'any' ? 'provided' : `a ${v.expected}`}, but got ${v.got}.`
  )
}
