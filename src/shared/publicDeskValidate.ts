// GENERATED FILE -- DO NOT EDIT.
// Vendored from projects/haptyx-shared/src by scripts/sync-contract.mjs.
// Edit the canonical copy there, then run: npm run sync:contract
// Strict validation for the public desk projection.
//
// Signal runs this on every publish. The desktop is the only intended producer,
// but a share token plus a stolen session must not be able to store arbitrary
// JSON that the public viewer will later render, so the server validates rather
// than trusting the client. Unknown fields are rejected outright: silently
// dropping them would let a future desktop believe it published something the
// server actually discarded, and accepting them would let a malicious client
// smuggle payloads past the disclosure allowlist.

import {
  PUBLIC_DESK_SCHEMA,
  PUBLIC_DESK_VERSION,
  isPubliclyRenderable,
  mayCapture,
  type PublicDeskProjectionV1
} from './publicDesk'

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

const RECT_KEYS = ['x', 'y', 'width', 'height']

/** Field allowlist per render type. Anything else is a rejection, not a warning. */
const RENDER_FIELDS: Record<string, string[]> = {
  text: ['type', 'body', 'format'],
  doc: ['type', 'html', 'pageCount'],
  table: ['type', 'columns', 'rows', 'truncated'],
  slides: ['type', 'slides'],
  image: ['type', 'assetId', 'alt'],
  media: ['type', 'assetId', 'media', 'duration'],
  pdf: ['type', 'assetId', 'pageCount'],
  link: ['type', 'url', 'displayUrl', 'previewAssetId', 'framable'],
  section: ['type', 'layout'],
  timer: ['type', 'valueMs', 'running', 'mode'],
  chart: ['type', 'chart', 'series'],
  diagram: ['type', 'nodes', 'edges'],
  color: ['type', 'value'],
  field: ['type', 'label', 'value', 'field'],
  'task-link': ['type', 'title', 'status', 'publicToken'],
  file: ['type', 'name', 'mime', 'assetId'],
  placeholder: ['type', 'reason'],
  capture: ['type', 'assetId', 'kind']
}

const WIDGET_FIELDS = [
  'id',
  'kind',
  'title',
  'rect',
  'zIndex',
  'color',
  'parentSectionId',
  'render',
  'captureAssetId'
]

const ROOT_FIELDS = [
  'schema',
  'version',
  'deskId',
  'title',
  'publishedAt',
  'revision',
  'bounds',
  'widgets',
  'links',
  'assets'
]

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k))
}

function checkRect(v: unknown, where: string, errors: string[]): void {
  if (!isObject(v)) {
    errors.push(`${where}: expected an object`)
    return
  }
  for (const k of RECT_KEYS) {
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k] as number)) {
      errors.push(`${where}.${k}: expected a finite number`)
    }
  }
  for (const k of unknownKeys(v, RECT_KEYS)) errors.push(`${where}.${k}: unknown field`)
}

/**
 * A URL is publishable only if it is http(s) and carries no embedded
 * credentials. `javascript:`, `file:`, `data:` and `fb-file://` must never
 * reach a public page.
 */
export function isSafePublicUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw === '') return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username !== '' || u.password !== '') return false
  return true
}

export function validatePublicDeskProjection(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!isObject(input)) return { ok: false, errors: ['projection: expected an object'] }

  if (input.schema !== PUBLIC_DESK_SCHEMA) {
    errors.push(`schema: expected "${PUBLIC_DESK_SCHEMA}"`)
  }
  if (input.version !== PUBLIC_DESK_VERSION) {
    errors.push(`version: expected ${PUBLIC_DESK_VERSION}`)
  }
  for (const k of ['deskId', 'title'] as const) {
    if (typeof input[k] !== 'string') errors.push(`${k}: expected a string`)
  }
  for (const k of ['publishedAt', 'revision'] as const) {
    if (typeof input[k] !== 'number' || !Number.isFinite(input[k] as number)) {
      errors.push(`${k}: expected a finite number`)
    }
  }
  checkRect(input.bounds, 'bounds', errors)
  for (const k of unknownKeys(input, ROOT_FIELDS)) errors.push(`${k}: unknown field`)

  // Widgets
  const ids = new Set<string>()
  if (!Array.isArray(input.widgets)) {
    errors.push('widgets: expected an array')
  } else {
    input.widgets.forEach((w, i) => {
      const at = `widgets[${i}]`
      if (!isObject(w)) {
        errors.push(`${at}: expected an object`)
        return
      }
      if (typeof w.id !== 'string' || w.id === '') errors.push(`${at}.id: expected a non-empty string`)
      else if (ids.has(w.id)) errors.push(`${at}.id: duplicate widget id`)
      else ids.add(w.id)

      if (typeof w.kind !== 'string') errors.push(`${at}.kind: expected a string`)
      if (typeof w.title !== 'string') errors.push(`${at}.title: expected a string`)
      if (typeof w.zIndex !== 'number') errors.push(`${at}.zIndex: expected a number`)
      if (w.color !== null && typeof w.color !== 'string') {
        errors.push(`${at}.color: expected a string or null`)
      }
      if (w.parentSectionId !== null && typeof w.parentSectionId !== 'string') {
        errors.push(`${at}.parentSectionId: expected a string or null`)
      }
      checkRect(w.rect, `${at}.rect`, errors)
      // A capture may only exist for a kind allowed to publish its markup, and
      // the server does not take the desktop's word for which those are.
      if (w.captureAssetId != null) {
        if (typeof w.captureAssetId !== 'string' || w.captureAssetId === '') {
          errors.push(`${at}.captureAssetId: expected a non-empty asset id`)
        } else if (typeof w.kind === 'string' && !mayCapture(w.kind)) {
          errors.push(`${at}.captureAssetId: kind "${w.kind}" may not publish its markup`)
        }
      }
      for (const k of unknownKeys(w, WIDGET_FIELDS)) errors.push(`${at}.${k}: unknown field`)

      // Render payload
      const r = w.render
      if (!isObject(r)) {
        errors.push(`${at}.render: expected an object`)
        return
      }
      const type = r.type
      if (typeof type !== 'string' || !RENDER_FIELDS[type]) {
        errors.push(`${at}.render.type: unknown render type ${JSON.stringify(type)}`)
        return
      }
      for (const k of unknownKeys(r, RENDER_FIELDS[type])) {
        errors.push(`${at}.render.${k}: unknown field for render type "${type}"`)
      }
      // The disclosure allowlist: a kind with no projector may only ever appear
      // as a placeholder. This is the check that makes the policy enforceable
      // rather than advisory.
      if (typeof w.kind === 'string' && !isPubliclyRenderable(w.kind)) {
        // A kind with no projector may be a placeholder, or -- only if it is on
        // the capture allowlist -- its own sanitised markup. Anything else is a
        // kind trying to publish content nobody signed off on.
        const allowed = type === 'placeholder' || (type === 'capture' && mayCapture(w.kind))
        if (!allowed) {
          errors.push(
            `${at}: kind "${w.kind}" has no public projector; expected a placeholder${
              mayCapture(w.kind) ? ' or a capture' : ''
            }, got "${type}"`
          )
        }
      }
      // The markup itself is checked when the asset is uploaded, which is the
      // only place the server sees it; here we only require the reference.
      if (type === 'capture' && (typeof r.assetId !== 'string' || r.assetId === '')) {
        errors.push(`${at}.render.assetId: expected a non-empty asset id`)
      }
      if (type === 'link' && !isSafePublicUrl(r.url)) {
        errors.push(`${at}.render.url: unsafe or malformed public URL`)
      }
      if (type === 'text' && r.format !== 'plain' && r.format !== 'markdown') {
        errors.push(`${at}.render.format: expected "plain" or "markdown"`)
      }
    })
  }

  // Links must connect widgets that exist, or the viewer draws wires into space.
  if (!Array.isArray(input.links)) {
    errors.push('links: expected an array')
  } else {
    input.links.forEach((l, i) => {
      const at = `links[${i}]`
      if (!isObject(l)) {
        errors.push(`${at}: expected an object`)
        return
      }
      for (const k of unknownKeys(l, ['id', 'fromWidgetId', 'toWidgetId', 'label'])) {
        errors.push(`${at}.${k}: unknown field`)
      }
      for (const k of ['fromWidgetId', 'toWidgetId'] as const) {
        if (typeof l[k] !== 'string') errors.push(`${at}.${k}: expected a string`)
        else if (ids.size && !ids.has(l[k] as string)) {
          errors.push(`${at}.${k}: references unknown widget "${l[k]}"`)
        }
      }
    })
  }

  if (!Array.isArray(input.assets)) {
    errors.push('assets: expected an array')
  } else {
    input.assets.forEach((a, i) => {
      const at = `assets[${i}]`
      if (!isObject(a)) {
        errors.push(`${at}: expected an object`)
        return
      }
      for (const k of unknownKeys(a, ['id', 'mime', 'bytes', 'width', 'height'])) {
        errors.push(`${at}.${k}: unknown field`)
      }
      if (typeof a.id !== 'string' || a.id === '') errors.push(`${at}.id: expected a non-empty string`)
      if (typeof a.mime !== 'string') errors.push(`${at}.mime: expected a string`)
      if (typeof a.bytes !== 'number') errors.push(`${at}.bytes: expected a number`)
    })
  }

  return { ok: errors.length === 0, errors }
}

/** Narrowing helper for callers that have already validated. */
export function asProjection(input: unknown): PublicDeskProjectionV1 {
  return input as PublicDeskProjectionV1
}
