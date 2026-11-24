// A minimal JSON-schema validator for direct app-API operations
// (SPEC-CONNECTIONS.md §5: "Define allowable parameters ... before exposing any
// operation to agents").
//
// It covers only the subset the catalogue adapters use, and it FAILS CLOSED on
// everything else: `assertSupportedSchema` refuses a schema that uses a keyword
// this file does not enforce, so an adapter can never declare a rule (say a
// `format` or a `oneOf`) that looks enforced and silently is not.
//
// Supported: type (object | string | number | integer | boolean | array),
// nullable (OpenAPI style, because JsonSchema.type is a single string),
// properties, required, additionalProperties (false or a schema), enum,
// minLength, maxLength, pattern, minimum, maximum, items, maxItems, plus the
// annotations description, title and default (not enforced, never applied).
//
// Error messages name the path and the rule, never the rejected value: tool
// input can be long, or carry something that should not be echoed into a log.

import type { JsonSchema } from '@shared/aispace/connections'

export interface SchemaError {
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: SchemaError[]
}

const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array'])
const KEYWORDS = new Set([
  'type',
  'nullable',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'items',
  'maxItems',
  'description',
  'title',
  'default'
])

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : Number.isFinite(v) ? 'number' : 'non-finite number'
  return typeof v
}

const quote = (s: string): string => `“${s}”`

// Throws if the schema uses anything this validator does not enforce, or is
// malformed. Called once per operation when an adapter is defined.
export function assertSupportedSchema(schema: JsonSchema, path = 'schema'): void {
  if (!isPlainObject(schema)) throw new Error(`${path}: a schema must be an object.`)
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k)) throw new Error(`${path}: keyword ${quote(k)} is not supported by the app-API validator.`)
  }
  if (schema.type === undefined) throw new Error(`${path}: every schema needs a type.`)
  if (!TYPES.has(schema.type)) throw new Error(`${path}: type ${quote(String(schema.type))} is not supported.`)
  if (schema.nullable !== undefined && typeof schema.nullable !== 'boolean') throw new Error(`${path}: nullable must be true or false.`)
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new Error(`${path}: pattern must be a string.`)
    new RegExp(schema.pattern) // throws on a bad pattern
  }
  for (const n of ['minLength', 'maxLength', 'maxItems'] as const) {
    const v = schema[n]
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) throw new Error(`${path}: ${n} must be a whole number.`)
  }
  for (const n of ['minimum', 'maximum'] as const) {
    if (schema[n] !== undefined && !Number.isFinite(schema[n])) throw new Error(`${path}: ${n} must be a number.`)
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`${path}: enum must be a list.`)
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) throw new Error(`${path}: properties must be an object.`)
    for (const [k, sub] of Object.entries(schema.properties)) assertSupportedSchema(sub, `${path}.properties.${k}`)
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== 'string')) throw new Error(`${path}: required must list property names.`)
    for (const r of schema.required) {
      if (!schema.properties || !hasOwn(schema.properties, r)) throw new Error(`${path}: required property ${quote(r)} is not declared.`)
    }
  }
  if (isPlainObject(schema.additionalProperties)) assertSupportedSchema(schema.additionalProperties as JsonSchema, `${path}.additionalProperties`)
  else if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`${path}: additionalProperties must be true, false or a schema.`)
  }
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${path}.items`)
}

function check(schema: JsonSchema, value: unknown, path: string, errors: SchemaError[]): void {
  const add = (message: string): void => {
    errors.push({ path, message })
  }

  if (value === null && schema.nullable === true) return
  if (value === undefined) {
    add('a value is required here.')
    return
  }

  const got = typeOf(value)
  const want = schema.type
  // A whole number is also a number (and 1.0 is a whole number to JSON).
  const typeOk = want === undefined || got === want || (want === 'number' && got === 'integer')
  if (!typeOk) {
    add(`expected ${want === 'integer' ? 'a whole number' : want === 'object' ? 'an object' : want === 'array' ? 'a list' : `a ${want}`}, got ${got}.`)
    return
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    add(`must be one of ${schema.enum.map((e) => quote(String(e))).join(', ')}.`)
  }

  if (typeof value === 'string') {
    // Length in code points, so an emoji counts once.
    const len = [...value].length
    if (typeof schema.minLength === 'number' && len < schema.minLength) add(`must be at least ${schema.minLength} characters (got ${len}).`)
    if (schema.maxLength !== undefined && len > schema.maxLength) add(`must be at most ${schema.maxLength} characters (got ${len}).`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) add('is not in the expected format.')
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add(`must be at least ${schema.minimum} (got ${value}).`)
    if (schema.maximum !== undefined && value > schema.maximum) add(`must be at most ${schema.maximum} (got ${value}).`)
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) add(`must have at most ${schema.maxItems} items (got ${value.length}).`)
    if (schema.items) value.forEach((v, i) => check(schema.items as JsonSchema, v, `${path}[${i}]`, errors))
  }

  if (isPlainObject(value)) {
    const props = schema.properties ?? {}
    for (const r of schema.required ?? []) {
      if (!hasOwn(value, r) || value[r] === undefined) errors.push({ path, message: `missing required property ${quote(r)}.` })
    }
    const extra = Object.keys(value).filter((k) => !hasOwn(props, k))
    if (schema.additionalProperties === false && extra.length) {
      const allowed = Object.keys(props)
      add(
        `unknown ${extra.length === 1 ? 'property' : 'properties'} ${extra.map(quote).join(', ')}` +
          (allowed.length ? ` (allowed: ${allowed.join(', ')}).` : ' (no properties are allowed).')
      )
    }
    for (const [k, sub] of Object.entries(props)) {
      if (hasOwn(value, k) && value[k] !== undefined) check(sub, value[k], `${path}.${k}`, errors)
    }
    if (isPlainObject(schema.additionalProperties)) {
      for (const k of extra) check(schema.additionalProperties as JsonSchema, value[k], `${path}.${k}`, errors)
    }
  }
}

export function validateJson(schema: JsonSchema, value: unknown, root = 'input'): ValidationResult {
  const errors: SchemaError[] = []
  check(schema, value, root, errors)
  return { ok: errors.length === 0, errors }
}

// One line a person or a model can act on: "input.pageId: is not in the expected format."
export function describeErrors(errors: SchemaError[], max = 5): string {
  const lines = errors.slice(0, max).map((e) => `${e.path}: ${e.message}`)
  if (errors.length > max) lines.push(`…and ${errors.length - max} more.`)
  return lines.join(' ')
}
