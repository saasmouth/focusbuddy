import type { SheetBodyV1, SlidesBody, Widget } from '@shared/types'
import { mayCapture } from '@shared/publicDesk'

// Fetching the bodies a public desk projection needs.
//
// Kept apart from the publisher hook so that converting a document to HTML --
// which needs the editor's whole extension tree to guarantee a round trip the
// editor can represent -- is loaded only when a desk actually contains one.

/**
 * Resolve the bodies a projection needs.
 *
 * The projection builder is pure and synchronous -- that is what makes the
 * disclosure rules testable -- so anything that requires IPC is fetched first
 * and read from a cache during the build. A widget whose body has not resolved
 * yet publishes as a placeholder rather than as empty content pretending to be
 * the real thing, and the next build after the warm pass carries it.
 */
export async function docHtmlFrom(
  body: unknown
): Promise<{ html: string; pageCount: number } | null> {
  try {
    // Loaded on demand: docToHtml drags in every editor extension, and a desk
    // of stickies should not pay for that.
    const [{ docToHtml }, { sanitizeHtml }] = await Promise.all([
      import('./docHtml'),
      import('./htmlSanitize')
    ])
    // Sanitised on the way out: this HTML is about to be public, and it is the
    // same sanitiser the editor trusts on the way in.
    // Stored as { doc: <ProseMirror JSON> }; docToHtml wants the document
    // itself, and handed the wrapper it produced nothing.
    const inner = (body as { doc?: unknown } | null)?.doc ?? body
    const html = sanitizeHtml(docToHtml(inner as never))
    return html ? { html, pageCount: 1 } : null
  } catch {
    return null
  }
}


/** Mime types the public viewer will render; the server refuses anything else. */
const PUBLISHABLE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4'
])
/** Matches the server's per-asset ceiling; oversized files stay placeholders. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024

/** "audio/webm;codecs=opus" is an audio/webm. Parameters are not the type. */
function bareMime(raw: string): string {
  return (raw || '').split(';')[0].trim().toLowerCase()
}

/** A stable id for an asset, so republishing does not re-upload the same bytes. */
function assetIdFor(source: string): string {
  let h = 0
  for (let i = 0; i < source.length; i++) h = (Math.imul(h, 31) + source.charCodeAt(i)) | 0
  return `a${(h >>> 0).toString(36)}${source.length.toString(36)}`
}

/**
 * The bytes behind a widget's content, whatever form it takes: a local file
 * reference, a data URL, or a remote address. Returns null when there is
 * nothing publishable, which leaves the widget as an honest placeholder rather
 * than a broken image.
 */
async function assetBytes(content: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!content) return null
  // A recorder or player stores { fileId: ... } rather than a bare reference.
  const wrapped = (() => {
    try {
      const o = JSON.parse(content) as { fileId?: string; id?: string }
      return typeof o?.fileId === 'string' ? o.fileId : typeof o?.id === 'string' ? o.id : null
    } catch {
      return null
    }
  })()
  const local = content.match(/^fb-file:\/\/([\w-]+)/)
  const fileId = wrapped ?? (local ? local[1] : /^[0-9a-fA-F-]{8,}$/.test(content) ? content : null)
  if (fileId) {
    const r = await window.api.files.read(fileId)
    return r ? { mime: bareMime(r.mimeType), bytes: new Uint8Array(r.buffer) } : null
  }
  if (content.startsWith('data:')) {
    const m = content.match(/^data:([^;,]+)[^,]*,(.*)$/)
    if (!m) return null
    const bin = atob(m[2])
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { mime: bareMime(m[1]), bytes }
  }
  if (/^https?:\/\//.test(content)) {
    // A remote image still has to be copied: the public page cannot be made to
    // depend on a URL only this machine can reach.
    const res = await fetch(content)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    return { mime: bareMime(res.headers.get('content-type') ?? ''), bytes: buf }
  }
  return null
}

/** Flatten a mind map's tree into the nodes and edges the viewer draws. */
function mindMapGraph(content: string): {
  nodes: { id: string; label: string; x: number; y: number }[]
  edges: { id: string; from: string; to: string; label: string | null }[]
} | null {
  try {
    const root = (JSON.parse(content) as { root?: unknown }).root
    if (!root) return null
    const nodes: { id: string; label: string; x: number; y: number }[] = []
    const edges: { id: string; from: string; to: string; label: string | null }[] = []
    // The desk lays a mind map out itself; the projection carries a simple
    // depth/order grid so the public page draws the same shape without needing
    // the editor's layout engine.
    const rows: number[] = []
    const walk = (n: unknown, depth: number, parent: string | null): void => {
      const node = n as { id?: string; label?: string; children?: unknown[] }
      if (!node?.id) return
      rows[depth] = (rows[depth] ?? 0) + 1
      nodes.push({
        id: node.id,
        label: String(node.label ?? ''),
        x: depth * 180,
        y: (rows[depth] - 1) * 70
      })
      if (parent) edges.push({ id: `${parent}->${node.id}`, from: parent, to: node.id, label: null })
      for (const c of node.children ?? []) walk(c, depth + 1, node.id)
    }
    walk(root, 0, null)
    return nodes.length ? { nodes, edges } : null
  } catch {
    return null
  }
}

/** A flow diagram already carries positions; only the shape needs narrowing. */
function diagramGraph(content: string): {
  nodes: { id: string; label: string; x: number; y: number }[]
  edges: { id: string; from: string; to: string; label: string | null }[]
} | null {
  try {
    const g = JSON.parse(content) as {
      nodes?: { id: string; position?: { x: number; y: number }; data?: { label?: string } }[]
      edges?: { id?: string; source: string; target: string; label?: string }[]
    }
    if (!Array.isArray(g.nodes) || g.nodes.length === 0) return null
    return {
      nodes: g.nodes.map((n) => ({
        id: n.id,
        label: String(n.data?.label ?? ''),
        x: n.position?.x ?? 0,
        y: n.position?.y ?? 0
      })),
      edges: (g.edges ?? []).map((e, i) => ({
        id: e.id ?? `e${i}`,
        from: e.source,
        to: e.target,
        label: e.label ?? null
      }))
    }
  } catch {
    return null
  }
}

/** Content hash, so an unchanged capture keeps the same asset id. */
function hashOf(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const ASSET_KINDS = new Set(['image', 'image-gen', 'video', 'voice-recorder', 'pdf', 'file', 'shape', 'design'])
const DIAGRAM_KINDS = new Set(['map', 'mindmap', 'diagram'])

export async function warmCache(
  deskId: string,
  widgets: Widget[],
  cache: Map<string, unknown>
): Promise<boolean> {
  let learned = false
  const note = (key: string, value: unknown): void => {
    if (value != null && !cache.has(key)) {
      cache.set(key, value)
      learned = true
    }
  }

  for (const w of widgets) {
    const id = w.content
    // Capture first, and for every kind allowed to publish its markup -- not
    // only the ones without a projector. A hand-written renderer of somebody
    // else's widget is a worse likeness than the widget itself, and a desk that
    // does not look like the desk is not worth sharing. Keyed by widget rather
    // than content, since a calculator has no content id.
    if (mayCapture(w.kind) && !cache.has(`c:${w.id}`)) {
      try {
        const { captureWidgetHtml } = await import('./widgetCapture')
        const html = await captureWidgetHtml(w)
        if (html) {
          const assetId = `cap${hashOf(w.id + html)}`
          const up = await window.api.liveDesk.uploadAsset(
            deskId,
            assetId,
            'text/plain',
            new TextEncoder().encode(html)
          )
          if (up.ok) note(`c:${w.id}`, assetId)
        }
      } catch {
        // A widget that will not render off-screen keeps its structural form.
      }
      // Hand the frame back between captures. Publishing runs on the same
      // thread, and a desk's worth of off-screen renders taken back to back
      // starved it completely.
      await new Promise((r) => setTimeout(r, 0))
    }
    if (!id) continue
    try {
      if (w.kind === 'table' && !cache.has(`t:${id}`)) {
        const [tbl, rows] = await Promise.all([
          window.api.tables.get(id),
          window.api.tables.listRows(id)
        ])
        if (tbl) {
          note(`t:${id}`, {
            columns: tbl.schema.columns.map((c) => ({ id: c.id, name: c.label, kind: c.type })),
            rows: rows.map((r) => ({
              id: r.id,
              cells: tbl.schema.columns.map((c) => {
                const v = (r.cells as Record<string, unknown>)[c.id]
                return v == null || typeof v === 'object' ? null : (v as string | number | boolean)
              })
            })),
            truncated: false
          })
        }
      } else if (w.kind === 'page' && !cache.has(`d:${id}`)) {
        // A page widget carries its Tiptap JSON inline rather than a document id.
        note(`d:${id}`, await docHtmlFrom(JSON.parse(id)))
      } else if ((w.kind === 'doc' || w.kind === 'living-doc') && !cache.has(`d:${id}`)) {
        const doc = await window.api.documents.get(id)
        if (doc && !doc.archived) note(`d:${id}`, await docHtmlFrom(doc.body))
      } else if (w.kind === 'sheet' && !cache.has(`t:${id}`)) {
        const doc = await window.api.documents.get(id)
        // Two shapes in the wild: the flat v1 body, and a v2 workbook whose
        // sheets live in an array. Only the first sheet is published, because a
        // dashboard card has one grid to show.
        const raw = doc?.body as
          | (SheetBodyV1 & { version?: number; sheets?: SheetBodyV1[] })
          | undefined
        const body = Array.isArray(raw?.sheets) ? raw.sheets[0] : raw
        if (doc && !doc.archived && Array.isArray(body?.columns)) {
          note(`t:${id}`, {
            columns: body.columns.map((name, i) => ({ id: `c${i}`, name, kind: 'text' })),
            rows: (body.rows ?? []).map((cells, i) => ({ id: `r${i}`, cells })),
            truncated: false
          })
        }
      } else if (ASSET_KINDS.has(w.kind) && !cache.has(`a:${id}`)) {
        const got = await assetBytes(id)
        if (got && PUBLISHABLE_MIME.has(got.mime) && got.bytes.byteLength <= MAX_ASSET_BYTES) {
          const assetId = assetIdFor(id)
          const up = await window.api.liveDesk.uploadAsset(deskId, assetId, got.mime, got.bytes)
          if (up.ok) {
            note(`a:${id}`, {
              assetId,
              mime: got.mime,
              bytes: got.bytes.byteLength,
              width: null,
              height: null
            })
          }
        }
        if (w.kind === 'file' && !cache.has(`f:${id}`)) {
          const meta = await window.api.files.get(id)
          if (meta) note(`f:${id}`, { name: meta.originalName ?? 'File', mime: meta.mimeType ?? null })
        }
      } else if (DIAGRAM_KINDS.has(w.kind) && !cache.has(`g:${id}`)) {
        // 'map' is a document; mindmap and diagram carry their graph inline.
        if (w.kind === 'map') {
          const doc = await window.api.documents.get(id)
          const body = doc?.body as { nodes?: unknown[]; edges?: unknown[] } | undefined
          if (doc && !doc.archived && Array.isArray(body?.nodes)) {
            note(`g:${id}`, diagramGraph(JSON.stringify(body)))
          }
        } else {
          note(`g:${id}`, w.kind === 'mindmap' ? mindMapGraph(id) : diagramGraph(id))
        }
      } else if (w.kind === 'slides' && !cache.has(`s:${id}`)) {
        const doc = await window.api.documents.get(id)
        const body = doc?.body as SlidesBody | undefined
        if (doc && !doc.archived && Array.isArray(body?.slides)) {
          note(`s:${id}`, {
            slides: body.slides.map((sl, i) => ({
              id: (sl as { id?: string }).id ?? `s${i}`,
              html: String((sl as { html?: string }).html ?? '')
            }))
          })
        }
      }
    } catch {
      // A body that will not load stays a placeholder. Never publish a guess.
    }
  }
  return learned
}

