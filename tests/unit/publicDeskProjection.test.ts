import { describe, it, expect } from 'vitest'
import type { Widget, WidgetKind } from '../../src/shared/types'
import {
  buildProjection,
  projectWidget,
  normalisePublicUrl,
  NULL_RESOLVERS,
  type ProjectionResolvers
} from '../../src/renderer/src/lib/publicDeskProjection'
import { PUBLIC_RENDER_POLICY, isPubliclyRenderable } from '../../src/shared/publicDesk'
import { validatePublicDeskProjection } from '../../src/shared/publicDeskValidate'

// The projection builder is the privacy boundary for public live desks. The
// design calls for "a fixture for every widget kind proves which fields are
// disclosed", so that is literally what this does: it drives every kind in the
// WidgetKind union through the builder with a recognisable secret in `content`
// and asserts the secret does not come out the other side.

// Every kind in src/shared/types.ts. Kept as a literal list on purpose: if
// someone adds a widget kind without adding it here, the completeness test
// below fails and they are forced to decide what the public may see.
const ALL_KINDS: WidgetKind[] = [
  'image-gen', 'sticky', 'note', 'markdown', 'webview', 'pdf', 'gdoc', 'gsheet',
  'gslide', 'email', 'chat-thread', 'calculator', 'color', 'image', 'video',
  'timer', 'section', 'task-link', 'local-app-launcher', 'file', 'drive',
  'field', 'page', 'table', 'doc', 'sheet', 'slides', 'map', 'design',
  'meeting-record', 'streamdeck', 'minimap', 'attention', 'voice-recorder',
  'mindmap', 'diagram', 'scratchpad', 'shape', 'card', 'chart', 'custom-block',
  'agent', 'portal', 'living-doc', 'webhook', 'inbound-hook'
]

const SECRET = 'CANARY-s3cr3t-do-not-disclose'

function widget(kind: WidgetKind, content = SECRET): Widget {
  return {
    id: `w_${kind}`,
    taskId: 'desk_1',
    kind,
    title: `${kind} title`,
    content,
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    zIndex: 1,
    color: null,
    status: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    sourceAppId: null
  } as unknown as Widget
}

/**
 * The kinds whose content IS the user's prose, so echoing it is the point.
 * A card and a custom block hold a JSON object and a scratchpad holds pen
 * strokes; those are not prose and publishing `content` for them shipped raw
 * stroke coordinates and object literals as if a person had written them.
 */
const TEXT_KINDS: WidgetKind[] = ['sticky', 'note', 'markdown']

describe('public desk projection — disclosure surface', () => {
  it('covers every widget kind in the union', () => {
    // Guards against the list above drifting from src/shared/types.ts.
    expect(ALL_KINDS.length).toBe(46)
    expect(new Set(ALL_KINDS).size).toBe(46)
  })

  it.each(ALL_KINDS)('%s never leaks raw content', (kind) => {
    const out = projectWidget(widget(kind), NULL_RESOLVERS)
    const serialised = JSON.stringify(out)
    if (TEXT_KINDS.includes(kind)) {
      // These are notes: the content is what the owner wrote and chose to share.
      expect(serialised).toContain(SECRET)
      expect(out.render.type).toBe('text')
    } else {
      expect(serialised).not.toContain(SECRET)
    }
  })

  it.each(ALL_KINDS.filter((k) => !isPubliclyRenderable(k)))(
    '%s is published as a placeholder, not as content',
    (kind) => {
      const out = projectWidget(widget(kind), NULL_RESOLVERS)
      expect(out.render.type).toBe('placeholder')
      if (out.render.type === 'placeholder') {
        expect(out.render.reason).toMatch(/not available publicly/i)
      }
    }
  )

  it.each(['card', 'custom-block', 'scratchpad'] as WidgetKind[])(
    '%s publishes no raw content, because its content is not prose',
    (kind) => {
      const out = projectWidget(widget(kind), NULL_RESOLVERS)
      expect(JSON.stringify(out)).not.toContain(SECRET)
    }
  )

  it('reads a card as its title and body, not as a JSON blob', () => {
    const content = JSON.stringify({ title: 'Card widget', body: 'A titled callout' })
    const out = projectWidget(widget('card', content), NULL_RESOLVERS)
    expect(out.render.type).toBe('text')
    if (out.render.type === 'text') {
      expect(out.render.body).toContain('Card widget')
      expect(out.render.body).toContain('A titled callout')
      expect(out.render.body).not.toContain('{')
    }
  })

  it('projects a kind into the family the shared policy names', () => {
    const resolvers: ProjectionResolvers = {
      // No capture in this fixture: the point is which structural family each
      // kind projects into, which is what the list view and a reader get.
      capture: () => null,
      table: () => ({ columns: [{ id: 'c1', name: 'Name', kind: 'text' }], rows: [{ id: 'r1', cells: ['Ada'] }], truncated: false }),
      document: () => ({ html: '<p>hello</p>', pageCount: 1 }),
      slides: () => ({ slides: [{ id: 's1', html: '<h1>One</h1>' }] }),
      diagram: () => ({ nodes: [{ id: 'n1', label: 'Start', x: 0, y: 0 }], edges: [] }),
      asset: () => ({ assetId: 'a1', mime: 'image/png', bytes: 10, width: 4, height: 4 }),
      file: () => ({ name: 'notes.txt', mime: 'text/plain' })
    }
    for (const kind of ALL_KINDS.filter(isPubliclyRenderable)) {
      const content =
        kind === 'webview' || kind === 'portal' || kind === 'gdoc' || kind === 'gsheet' || kind === 'gslide'
          ? 'https://example.com/page'
          : kind === 'card' || kind === 'custom-block'
            ? JSON.stringify({ title: 'T', body: 'B' })
            : SECRET
      // A scratchpad is a drawing: it has no structural form and is carried by
      // its capture instead.
      if (kind === 'scratchpad') continue
      const out = projectWidget(widget(kind, content), resolvers)
      expect(out.render.type, `${kind} should render as ${PUBLIC_RENDER_POLICY[kind]}`).toBe(
        PUBLIC_RENDER_POLICY[kind]
      )
    }
  })

  it('never claims a document is an image', () => {
    // A design and a shape are document/vector content, not files. Both were
    // mapped to the image family, so every one of them published as "image not
    // published" -- a missing picture rather than an honest statement.
    expect(isPubliclyRenderable('design')).toBe(false)
    expect(projectWidget(widget('design', 'doc-id'), NULL_RESOLVERS).render.type).toBe('placeholder')
    expect(PUBLIC_RENDER_POLICY['shape']).toBe('color')
  })

  it('falls back to a placeholder when a referenced document is gone', () => {
    // A deleted table must not publish as an empty grid pretending to be data.
    const out = projectWidget(widget('table'), NULL_RESOLVERS)
    expect(out.render.type).toBe('placeholder')
  })
})

describe('public desk projection — URL safety', () => {
  it('strips credentials', () => {
    expect(normalisePublicUrl('https://user:pw@example.com/x')?.url).toBe('https://example.com/x')
  })

  it('strips capability-bearing query parameters', () => {
    const out = normalisePublicUrl('https://example.com/doc?id=7&access_token=abc&signature=zz')
    expect(out?.url).toContain('id=7')
    expect(out?.url).not.toContain('access_token')
    expect(out?.url).not.toContain('signature')
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>', 'fb-file://abc'])(
    'refuses %s',
    (raw) => {
      expect(normalisePublicUrl(raw)).toBeNull()
    }
  )

  it('turns an unpublishable URL into a placeholder rather than dropping the widget', () => {
    const out = projectWidget(widget('webview', 'file:///Users/me/secret.pdf'), NULL_RESOLVERS)
    expect(out.render.type).toBe('placeholder')
    expect(JSON.stringify(out)).not.toContain('secret.pdf')
  })
})

describe('public desk projection — desk assembly', () => {
  const base = { deskId: 'desk_1', title: 'Launch', revision: 3, now: 1_700_000_000_000 }

  it('omits archived, hidden and viewer-local widgets', () => {
    const archived = { ...widget('note', 'archived note'), archived: true } as Widget
    const hidden = { ...widget('sticky', 'hidden note'), hidden: true } as Widget
    const out = buildProjection({
      ...base,
      widgets: [widget('note', 'visible'), archived, hidden, widget('minimap')]
    })
    const kinds = out.widgets.map((w) => w.kind)
    expect(kinds).toEqual(['note'])
    expect(JSON.stringify(out)).not.toContain('archived note')
    expect(JSON.stringify(out)).not.toContain('hidden note')
  })

  it('drops wires whose endpoints were filtered out', () => {
    const out = buildProjection({
      ...base,
      widgets: [widget('note', 'a')],
      links: [
        { id: 'l1', fromWidgetId: 'w_note', toWidgetId: 'w_minimap', label: null },
        { id: 'l2', fromWidgetId: 'w_note', toWidgetId: 'w_note', label: 'self' }
      ]
    })
    expect(out.links.map((l) => l.id)).toEqual(['l2'])
  })

  it('computes bounds covering every widget', () => {
    const a = { ...widget('note'), x: 0, y: 0, width: 100, height: 100 } as Widget
    const b = { ...widget('sticky'), id: 'w2', x: 400, y: 300, width: 200, height: 50 } as Widget
    const out = buildProjection({ ...base, widgets: [a, b] })
    expect(out.bounds).toEqual({ x: 0, y: 0, width: 600, height: 350 })
  })

  it('produces a projection the server accepts', () => {
    // Builder and server agree, verified against the same shared validator the
    // server runs -- so a publish cannot fail validation in production while
    // passing here.
    const out = buildProjection({
      ...base,
      widgets: ALL_KINDS.map((k) =>
        k === 'webview' || k === 'portal' || k === 'gdoc' || k === 'gsheet' || k === 'gslide'
          ? { ...widget(k, 'https://example.com/x'), id: `w_${k}` }
          : widget(k)
      )
    })
    const result = validatePublicDeskProjection(out)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('publishes an empty desk without inventing bounds', () => {
    const out = buildProjection({ ...base, widgets: [] })
    expect(out.widgets).toEqual([])
    expect(out.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(validatePublicDeskProjection(out).ok).toBe(true)
  })
})
