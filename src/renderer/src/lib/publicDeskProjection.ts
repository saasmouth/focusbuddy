import type { Widget, WidgetKind } from '@shared/types'
import {
  PUBLIC_DESK_SCHEMA,
  PUBLIC_DESK_VERSION,
  PUBLIC_RENDER_POLICY,
  placeholderReasonFor,
  isPubliclyRenderable,
  mayCapture,
  type PublicDeskProjectionV1,
  type PublicLink,
  type PublicRender,
  type PublicWidget,
  type PublicAssetRef,
  type PublicRect
} from '@shared/publicDesk'

// Builds the public desk projection: the sanitized, versioned representation
// the desktop publishes for a live web view.
//
// This is deliberately NOT `serializeWidget` from shareSnapshot.ts. That
// function copies `widget.content` verbatim, which for a webhook is a secret
// URL, for an agent is its instructions, for a launcher is a local binary path,
// and for a connected-app webview is the identity of the owner's session. Those
// are acceptable in a snapshot the owner hands to a named person; they are not
// acceptable on a public page.
//
// The rule here is fail-closed. A widget kind is projected only if the shared
// PUBLIC_RENDER_POLICY has an entry for it, and every projector below reads
// named fields rather than passing content through. A kind nobody has written a
// projector for becomes a placeholder, so adding a widget to the desktop can
// never silently start publishing its internals.

/**
 * Resolvers let the pure builder stay free of IPC. The async wrapper supplies
 * real implementations; fixtures supply canned ones, which is what makes it
 * possible to assert the disclosure surface of all 46 widget kinds.
 */
export interface ProjectionResolvers {
  table(id: string): { columns: { id: string; name: string; kind: string }[]; rows: { id: string; cells: (string | number | boolean | null)[] }[]; truncated: boolean } | null
  document(id: string): { html: string; pageCount: number } | null
  slides(id: string): { slides: { id: string; html: string }[] } | null
  diagram(id: string): { nodes: { id: string; label: string; x: number; y: number }[]; edges: { id: string; from: string; to: string; label: string | null }[] } | null
  /** Asset id of the captured markup for a kind with no projector. */
  capture(widgetId: string): string | null
  /** Returns an asset reference if the owner published the bytes, else null. */
  asset(id: string): { assetId: string; mime: string; bytes: number; width: number | null; height: number | null } | null
  file(id: string): { name: string; mime: string | null } | null
}

export const NULL_RESOLVERS: ProjectionResolvers = {
  capture: () => null,
  table: () => null,
  document: () => null,
  slides: () => null,
  diagram: () => null,
  asset: () => null,
  file: () => null
}

/** Rows beyond this are dropped; a public page is not a data export. */
export const MAX_PUBLIC_TABLE_ROWS = 500
/** Characters of text past which a note is truncated. */
export const MAX_PUBLIC_TEXT_CHARS = 20_000

/**
 * Strip credentials and non-http schemes. Returns null when the URL cannot be
 * published at all, which makes the widget fall back to a placeholder rather
 * than shipping something the server would reject anyway.
 */
export function normalisePublicUrl(raw: string): { url: string; display: string } | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // Credentials in a URL are the owner's, not the public's.
  u.username = ''
  u.password = ''
  // Query strings routinely carry tokens on sharing links. The public page
  // needs the destination, not the owner's capability to reach it.
  for (const key of Array.from(u.searchParams.keys())) {
    if (/token|key|secret|signature|sig|auth|password|session/i.test(key)) {
      u.searchParams.delete(key)
    }
  }
  return { url: u.toString(), display: u.host + (u.pathname === '/' ? '' : u.pathname) }
}

/**
 * Accept only recognisable CSS colour values. Anything else is not a colour and
 * therefore not publishable as one.
 */
export function safeColour(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v
  if (/^rgba?\(\s*[\d.\s,%/]+\)$/i.test(v)) return v
  if (/^hsla?\(\s*[\d.\s,%/deg]+\)$/i.test(v)) return v
  if (/^[a-z]{3,20}$/i.test(v)) return v.toLowerCase()
  return null
}

function textOf(w: Widget, format: 'plain' | 'markdown'): PublicRender {
  return { type: 'text', body: (w.content || '').slice(0, MAX_PUBLIC_TEXT_CHARS), format }
}

function placeholder(kind: string): PublicRender {
  return { type: 'placeholder', reason: placeholderReasonFor(kind) }
}

/** Parse a widget's JSON content defensively; never throw into a publish. */
function json<T>(content: string): T | null {
  if (!content) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/**
 * Project one widget. Every branch reads named fields; none forwards `content`
 * except the text kinds, where the content IS the user-authored prose.
 */
export function projectWidget(w: Widget, r: ProjectionResolvers = NULL_RESOLVERS): PublicWidget {
  const family = PUBLIC_RENDER_POLICY[w.kind as string]
  let render: PublicRender

  const captureAssetId = mayCapture(w.kind) ? r.capture(w.id) : null

  if (!isPubliclyRenderable(w.kind)) {
    // No structural projector. If this kind is on the capture allowlist and its
    // markup was captured, publish that; otherwise say so plainly. A kind that
    // is not on the allowlist can never reach the capture branch, whatever the
    // resolver returns.
    render = captureAssetId
      ? { type: 'capture', assetId: captureAssetId, kind: w.kind }
      : placeholder(w.kind)
  } else {
    switch (family) {
      case 'text': {
        // Only some of these hold prose. A card and a custom block hold a JSON
        // object, and a scratchpad holds pen strokes -- dumping `content` for
        // those published raw stroke coordinates and object literals as if they
        // were something a person wrote.
        if (w.kind === 'card' || w.kind === 'custom-block') {
          const c = json<{ title?: string; body?: string }>(w.content)
          const body = [c?.title, c?.body].filter((x) => typeof x === 'string' && x.trim()).join('\n\n')
          render = body
            ? { type: 'text', body: body.slice(0, MAX_PUBLIC_TEXT_CHARS), format: 'plain' }
            : placeholder(w.kind)
        } else if (w.kind === 'scratchpad') {
          // A drawing has no text form. The capture carries what it looks like.
          render = placeholder(w.kind)
        } else {
          render = textOf(w, w.kind === 'markdown' ? 'markdown' : 'plain')
        }
        break
      }

      case 'doc': {
        const doc = r.document(w.content)
        render = doc ? { type: 'doc', html: doc.html, pageCount: doc.pageCount } : placeholder(w.kind)
        break
      }

      case 'table': {
        const t = r.table(w.content)
        render = t
          ? {
              type: 'table',
              columns: t.columns,
              rows: t.rows.slice(0, MAX_PUBLIC_TABLE_ROWS),
              truncated: t.truncated || t.rows.length > MAX_PUBLIC_TABLE_ROWS
            }
          : placeholder(w.kind)
        break
      }

      case 'slides': {
        const s = r.slides(w.content)
        render = s ? { type: 'slides', slides: s.slides } : placeholder(w.kind)
        break
      }

      case 'image': {
        const a = r.asset(w.content)
        render = { type: 'image', assetId: a ? a.assetId : null, alt: w.title || '' }
        break
      }

      case 'media': {
        const a = r.asset(w.content)
        render = {
          type: 'media',
          assetId: a ? a.assetId : null,
          media: w.kind === 'voice-recorder' ? 'audio' : 'video',
          duration: null
        }
        break
      }

      case 'pdf': {
        const a = r.asset(w.content)
        render = { type: 'pdf', assetId: a ? a.assetId : null, pageCount: null }
        break
      }

      case 'link': {
        // A public browser widget must never inherit the owner's logged-in
        // session, so this carries URL chrome and an optional captured preview
        // -- never the live authenticated view the desktop shows.
        const parsed = json<{ url?: string }>(w.content)
        const raw = parsed?.url ?? w.content
        const safe = normalisePublicUrl(typeof raw === 'string' ? raw : '')
        render = safe
          ? { type: 'link', url: safe.url, displayUrl: safe.display, previewAssetId: null, framable: false }
          : placeholder(w.kind)
        break
      }

      case 'section':
        render = { type: 'section', layout: w.layout ?? null }
        break

      case 'timer': {
        const t = json<{ remainingMs?: number; elapsedMs?: number; running?: boolean; mode?: string }>(w.content)
        render = {
          type: 'timer',
          valueMs: Math.max(0, Math.floor(t?.remainingMs ?? t?.elapsedMs ?? 0)),
          running: !!t?.running,
          mode: t?.mode === 'stopwatch' ? 'stopwatch' : 'countdown'
        }
        break
      }

      case 'chart': {
        const c = json<{ chart?: string; series?: { name: string; points: { label: string; value: number }[] }[] }>(w.content)
        render = { type: 'chart', chart: c?.chart ?? 'bar', series: Array.isArray(c?.series) ? c!.series! : [] }
        break
      }

      case 'diagram': {
        const d = r.diagram(w.content)
        render = d ? { type: 'diagram', nodes: d.nodes, edges: d.edges } : placeholder(w.kind)
        break
      }

      case 'color':
        // Only an actual colour value may be published. Falling back to raw
        // `content` here would forward whatever string the widget happened to
        // hold -- the fixture for this kind caught exactly that.
        {
          // A shape stores { shape, fill, stroke, ... }; a colour widget stores
          // the value itself. Both end up as one publishable colour.
          const shape = json<{ fill?: string }>(w.content)
          render = {
            type: 'color',
            value:
              safeColour(shape?.fill) ?? safeColour(w.color) ?? safeColour(w.content) ?? '#000000'
          }
        }
        break

      case 'field': {
        const f = json<{ label?: string; value?: unknown; field?: string }>(w.content)
        render = {
          type: 'field',
          label: f?.label ?? w.title ?? '',
          value: f?.value == null ? '' : String(f.value),
          field: f?.field ?? 'text'
        }
        break
      }

      case 'task-link': {
        const t = json<{ title?: string; status?: string }>(w.content)
        render = {
          type: 'task-link',
          title: t?.title ?? w.title ?? '',
          status: t?.status ?? null,
          // Only set when the referenced desk is itself published; the builder
          // never mints a token for a desk the owner has not shared.
          publicToken: null
        }
        break
      }

      case 'file': {
        const meta = r.file(w.content)
        const a = r.asset(w.content)
        render = {
          type: 'file',
          name: meta?.name ?? w.title ?? 'File',
          mime: meta?.mime ?? null,
          assetId: a ? a.assetId : null
        }
        break
      }

      default:
        // Policy names a family with no projector: fail closed rather than
        // guessing at a shape.
        render = placeholder(w.kind)
    }
  }

  return {
    id: w.id,
    kind: w.kind,
    title: w.title || '',
    rect: { x: w.x, y: w.y, width: w.width, height: w.height },
    zIndex: w.zIndex ?? 0,
    color: w.color ?? null,
    parentSectionId: w.parentSectionId ?? null,
    // Carried alongside the structural render, so the canvas can show the
    // widget as the app draws it while the list view keeps real text.
    ...(captureAssetId && render.type !== 'capture' ? { captureAssetId } : {}),
    render
  }
}

function boundsOf(widgets: PublicWidget[]): PublicRect {
  if (widgets.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of widgets) {
    minX = Math.min(minX, w.rect.x)
    minY = Math.min(minY, w.rect.y)
    maxX = Math.max(maxX, w.rect.x + w.rect.width)
    maxY = Math.max(maxY, w.rect.y + w.rect.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export interface BuildProjectionInput {
  deskId: string
  title: string
  revision: number
  widgets: Widget[]
  /** Wires between widgets on this desk. */
  links?: { id: string; fromWidgetId: string; toWidgetId: string; label?: string | null }[]
  assets?: PublicAssetRef[]
  resolvers?: ProjectionResolvers
  now?: number
}

/**
 * The pure builder. Everything that decides what the public can see happens
 * here, which is why the fixtures test this function rather than the async
 * wrapper below.
 */
export function buildProjection(input: BuildProjectionInput): PublicDeskProjectionV1 {
  const resolvers = input.resolvers ?? NULL_RESOLVERS
  const visible = input.widgets.filter((w) => {
    // Archived and hidden widgets are not part of the desk the owner sees, so
    // they are not part of the desk the public sees.
    const anyW = w as Widget & { archived?: boolean; hidden?: boolean }
    if (anyW.archived || anyW.hidden) return false
    // Viewer-local chrome has no meaning on a public page.
    if (w.kind === 'minimap') return false
    return true
  })
  const widgets = visible.map((w) => projectWidget(w, resolvers))
  const ids = new Set(widgets.map((w) => w.id))
  // A wire to a widget that was filtered out would render into empty space,
  // and the server rejects it anyway.
  const links: PublicLink[] = (input.links ?? [])
    .filter((l) => ids.has(l.fromWidgetId) && ids.has(l.toWidgetId))
    .map((l) => ({
      id: l.id,
      fromWidgetId: l.fromWidgetId,
      toWidgetId: l.toWidgetId,
      label: l.label ?? null
    }))

  return {
    schema: PUBLIC_DESK_SCHEMA,
    version: PUBLIC_DESK_VERSION,
    deskId: input.deskId,
    title: input.title,
    publishedAt: input.now ?? Date.now(),
    revision: input.revision,
    bounds: boundsOf(widgets),
    widgets,
    links,
    assets: input.assets ?? []
  }
}

/** Every widget kind the projection knows how to render, for tests and UI. */
export function publiclyRenderableKinds(): WidgetKind[] {
  return Object.keys(PUBLIC_RENDER_POLICY) as WidgetKind[]
}
