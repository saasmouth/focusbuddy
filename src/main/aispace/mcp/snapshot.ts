// MCP tools as Plexii operations, with versioned snapshots and review
// (SPEC-CONNECTIONS.md §4 Tool discovery, §5 operation definitions).
//
// Rules this file enforces:
//  - Discovery never classifies. An MCP server's readOnlyHint is advisory (the
//    spec says so), so every discovered tool is 'unknown' with retry 'never'
//    until a person classifies it. `suggestedClass` only pre-fills their choice.
//  - A new tool, or one whose schema or endpoint changed, needs review before
//    an existing grant lets it run, even if it was approved before.
//  - Names, titles and descriptions are untrusted server text: kept as data,
//    cleaned and capped for display, and hashed raw so any change is noticed.

import { createHash } from 'node:crypto'
import type { JsonSchema, OperationClass, OperationDef, RetryRule } from '@shared/aispace/connections'
import { canonicalResource } from './egress'

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

// A tool as the server listed it (shape-checked, otherwise untouched).
export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: Record<string, unknown>
}

export type SuggestedClass = 'read' | 'write' | null

export interface McpOperation extends OperationDef {
  origin: 'mcp'
  connectionId: string
  toolName: string
  // The exact endpoint the snapshot was taken from; a change means review.
  endpoint: string
  // A hint for the person's choice. Never used as the classification.
  suggestedClass: SuggestedClass
  // The server's own hints, for display. Advisory only.
  annotations: McpToolAnnotations | null
}

export const MCP_OPERATION_DEFAULTS = { rateLimitPerMinute: 30, timeoutMs: 60_000 } as const

// Letters, digits, _ - . / — and never ':' so 'mcp:<connection>:<tool>' stays
// unambiguous. (The 2025-11-25 spec narrows names to much the same set.)
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/

const TITLE_CAP = 200
const DESCRIPTION_CAP = 4_000

// Sorted keys at every depth, so the same tool always hashes the same however
// the server ordered its JSON.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v)
    return s === undefined ? 'null' : s
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

// Covers everything a person reviews or a model reads: name, title,
// description, both schemas and the annotations. A change to any is material.
export function toolSchemaHash(t: McpTool): string {
  const material = {
    name: t.name,
    title: t.title ?? null,
    description: t.description ?? null,
    inputSchema: t.inputSchema ?? null,
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations ?? null
  }
  return createHash('sha256').update(canonicalJson(material)).digest('hex')
}

export function suggestedClassOf(annotations: Record<string, unknown> | null | undefined): SuggestedClass {
  if (!annotations) return null
  if (annotations.readOnlyHint === true) return 'read'
  if (annotations.destructiveHint === true || annotations.readOnlyHint === false) return 'write'
  return null
}

export function retryRuleFor(classification: OperationClass): RetryRule {
  // Only a person-classified read is safe to retry; an unknown tool may write.
  return classification === 'read' ? 'safe_read' : 'never'
}

function cleanText(s: unknown, cap: number): string {
  if (typeof s !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  return t.length > cap ? `${t.slice(0, cap)}…` : t
}

function annotationsOf(raw: Record<string, unknown> | undefined): McpToolAnnotations | null {
  if (!raw) return null
  const a: McpToolAnnotations = {}
  if (typeof raw.title === 'string') a.title = cleanText(raw.title, TITLE_CAP)
  for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof raw[k] === 'boolean') a[k] = raw[k] as boolean
  }
  return a
}

export interface SkippedTool {
  name: string
  reason: string
}

export function toolsToOperations(input: { connectionId: string; endpoint: string; tools: readonly McpTool[] }): {
  operations: McpOperation[]
  skipped: SkippedTool[]
} {
  const endpoint = canonicalResource(input.endpoint)
  const destination = new URL(endpoint).host
  const operations: McpOperation[] = []
  const skipped: SkippedTool[] = []
  const seen = new Set<string>()
  for (const t of input.tools) {
    const name = typeof t.name === 'string' ? t.name : ''
    if (!TOOL_NAME.test(name)) {
      skipped.push({ name: cleanText(name, 128), reason: 'Tool name uses characters Plexii can’t namespace safely.' })
      continue
    }
    if (seen.has(name)) {
      // Two tools with one name would let the second impersonate the first.
      skipped.push({ name, reason: 'The server listed this tool name more than once.' })
      continue
    }
    seen.add(name)
    const annotations = annotationsOf(t.annotations)
    operations.push({
      id: `mcp:${input.connectionId}:${name}`,
      connectionId: input.connectionId,
      adapter: 'mcp',
      title: cleanText(t.title, TITLE_CAP) || annotations?.title || name,
      description: cleanText(t.description, DESCRIPTION_CAP),
      classification: 'unknown',
      scope: null,
      destination,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
      schemaVersion: 1,
      schemaHash: toolSchemaHash(t),
      rateLimitPerMinute: MCP_OPERATION_DEFAULTS.rateLimitPerMinute,
      timeoutMs: MCP_OPERATION_DEFAULTS.timeoutMs,
      retry: 'never',
      reviewState: 'needs_review',
      origin: 'mcp',
      toolName: name,
      endpoint,
      suggestedClass: suggestedClassOf(t.annotations),
      annotations
    })
  }
  return { operations, skipped }
}

export type ChangeKind = 'schema' | 'endpoint'

export interface SnapshotDiff {
  added: McpOperation[]
  removed: McpOperation[]
  changed: Array<{ before: McpOperation; after: McpOperation; what: ChangeKind[] }>
  unchanged: McpOperation[]
  // The next snapshot with review state carried over or reset: what to store.
  operations: McpOperation[]
}

// Compare a stored snapshot with a fresh listing (from toolsToOperations).
export function diffSnapshots(prev: readonly McpOperation[] | null, next: readonly McpOperation[]): SnapshotDiff {
  const before = new Map((prev ?? []).map((op) => [op.id, op]))
  const diff: SnapshotDiff = { added: [], removed: [], changed: [], unchanged: [], operations: [] }
  for (const fresh of next) {
    const old = before.get(fresh.id)
    before.delete(fresh.id)
    if (!old) {
      const op: McpOperation = { ...fresh, classification: 'unknown', retry: 'never', reviewState: 'needs_review', schemaVersion: 1 }
      diff.added.push(op)
      diff.operations.push(op)
      continue
    }
    const what: ChangeKind[] = []
    if (old.schemaHash !== fresh.schemaHash) what.push('schema')
    if (canonicalResource(old.endpoint) !== canonicalResource(fresh.endpoint)) what.push('endpoint')
    // Settings a person tuned survive either way; they don't depend on the schema.
    const kept = { rateLimitPerMinute: old.rateLimitPerMinute, timeoutMs: old.timeoutMs }
    if (what.length) {
      // Material change: back to review, whatever it was before. The old
      // classification stays visible in `before` for the reviewer.
      const op: McpOperation = {
        ...fresh,
        ...kept,
        classification: 'unknown',
        retry: 'never',
        reviewState: 'needs_review',
        schemaVersion: old.schemaVersion + (what.includes('schema') ? 1 : 0)
      }
      diff.changed.push({ before: old, after: op, what })
      diff.operations.push(op)
    } else {
      const op: McpOperation = {
        ...fresh,
        ...kept,
        classification: old.classification,
        retry: old.retry,
        reviewState: old.reviewState,
        schemaVersion: old.schemaVersion
      }
      diff.unchanged.push(op)
      diff.operations.push(op)
    }
  }
  diff.removed.push(...before.values())
  return diff
}

// A person reviewed the tool and said what it does. Only then can it be
// approved, and only a read may be retried.
export function approveOperation(op: McpOperation, classification: 'read' | 'write'): McpOperation {
  if (classification !== 'read' && classification !== 'write') {
    throw new Error('A tool is approved as read or write; unknown cannot be approved.')
  }
  return { ...op, classification, retry: retryRuleFor(classification), reviewState: 'approved' }
}
