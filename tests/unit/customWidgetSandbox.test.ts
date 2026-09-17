/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  composeCustomWidgetDocument,
  parseBridgeMessage,
  cspFor,
  sandboxAttrIsSafe,
  SANDBOX_ATTR
} from '../../src/shared/customWidgetSandbox'

// The Custom widget runs code nobody reviewed -- the model wrote it seconds ago
// from a sentence the user typed. The feature is only defensible because the
// execution context is genuinely contained, so these tests are about the
// containment, not about the UI around it.

describe('the iframe sandbox cannot be widened by accident', () => {
  it('grants scripts but never same-origin', () => {
    expect(SANDBOX_ATTR).toContain('allow-scripts')
    expect(SANDBOX_ATTR).not.toContain('allow-same-origin')
  })

  it('rejects the one combination that collapses the whole boundary', () => {
    // allow-scripts + allow-same-origin together put generated code on the app's
    // OWN origin, where it could read localStorage, reach the preload bridge and
    // walk the parent DOM. This is the single mistake worth a test of its own.
    expect(sandboxAttrIsSafe('allow-scripts')).toBe(true)
    expect(sandboxAttrIsSafe('allow-scripts allow-forms')).toBe(true)
    expect(sandboxAttrIsSafe('allow-scripts allow-same-origin')).toBe(false)
    expect(sandboxAttrIsSafe('allow-same-origin')).toBe(false)
    // An empty sandbox is not "safe" for our purposes -- it cannot run anything.
    expect(sandboxAttrIsSafe('')).toBe(false)
  })
})

describe('the content security policy', () => {
  it('denies all network egress when the widget is offline (the default)', () => {
    const csp = cspFor(false)
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('connect-src https:')
  })

  it('permits https only once the user has opted in', () => {
    const csp = cspFor(true)
    expect(csp).toContain('connect-src https:')
  })

  it('never allows the frame to nest, embed plugins or retarget forms', () => {
    for (const net of [false, true]) {
      const csp = cspFor(net)
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("base-uri 'none'")
      expect(csp).toContain("form-action 'none'")
    }
  })
})

describe('document composition', () => {
  it('puts the security preamble before anything the model wrote', () => {
    const doc = composeCustomWidgetDocument({ code: '<div id="x">hi</div>' })
    const csp = doc.indexOf('Content-Security-Policy')
    const body = doc.indexOf('<div id="x">')
    expect(csp).toBeGreaterThan(-1)
    expect(csp).toBeLessThan(body)
  })

  it('injects the bridge for a bare fragment', () => {
    const doc = composeCustomWidgetDocument({ code: '<p>hello</p>' })
    expect(doc).toContain('window.plexi')
    expect(doc).toContain('<!doctype html>')
    expect(doc).toContain('<p>hello</p>')
  })

  it('splices into an existing <head> when the model wrote a whole document', () => {
    const code = '<!doctype html><html><head><title>T</title></head><body><b>B</b></body></html>'
    const doc = composeCustomWidgetDocument({ code })
    expect(doc).toContain('window.plexi')
    expect(doc).toContain('<b>B</b>')
    // Our CSP must land ahead of the model's own head content, so that when two
    // policies are present the browser's intersection cannot be widened by the
    // one the model supplied.
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<title>T</title>'))
  })

  it('creates a head when the model wrote <html> without one', () => {
    const doc = composeCustomWidgetDocument({ code: '<html><body>x</body></html>' })
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain('window.plexi')
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<body>x</body>'))
  })

  it('inlines saved state so the widget renders it on the first frame', () => {
    const doc = composeCustomWidgetDocument({ code: '<p>x</p>', state: { count: 7 } })
    expect(doc).toContain('"count":7')
  })

  it('escapes state that would otherwise close the script element it sits in', () => {
    // A widget that saved the literal text "</script>" must not be able to break
    // out of the bridge's own <script> block and inject markup into the document.
    const doc = composeCustomWidgetDocument({
      code: '<p>x</p>',
      state: { note: '</script><img src=x onerror=alert(1)>' }
    })
    const bridgeStart = doc.indexOf('var state =')
    const bridgeEnd = doc.indexOf('window.plexi')
    const inlined = doc.slice(bridgeStart, bridgeEnd)
    expect(inlined).not.toContain('</script>')
    expect(inlined).toContain('\\u003c/script')
  })

  it('survives state that cannot be serialised rather than emitting broken script', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const doc = composeCustomWidgetDocument({ code: '<p>x</p>', state: cyclic })
    expect(doc).toContain('var state = {}')
  })

  it('carries the CSP matching the widget\'s own network setting', () => {
    expect(composeCustomWidgetDocument({ code: '<p>x</p>', net: false })).toContain("connect-src 'none'")
    expect(composeCustomWidgetDocument({ code: '<p>x</p>', net: true })).toContain('connect-src https:')
  })
})

describe('messages arriving from the sandboxed frame are untrusted', () => {
  it('ignores anything without the bridge marker', () => {
    expect(parseBridgeMessage({ type: 'state', payload: {} })).toBeNull()
    expect(parseBridgeMessage(null)).toBeNull()
    expect(parseBridgeMessage('state')).toBeNull()
    expect(parseBridgeMessage(42)).toBeNull()
  })

  it('ignores message types the bridge does not define', () => {
    expect(parseBridgeMessage({ __plexi: 1, type: 'eval', payload: 'rm -rf /' })).toBeNull()
    expect(parseBridgeMessage({ __plexi: 1, type: 'ipc', payload: {} })).toBeNull()
  })

  it('accepts a well-formed state write', () => {
    const m = parseBridgeMessage({ __plexi: 1, type: 'state', payload: { a: 1 } })
    expect(m).toEqual({ type: 'state', payload: { a: 1 } })
  })

  it('refuses a state that is not a plain object', () => {
    // An array would pass a naive typeof check and then be written into the
    // widget's content where an object is expected.
    expect(parseBridgeMessage({ __plexi: 1, type: 'state', payload: [1, 2] })).toBeNull()
    expect(parseBridgeMessage({ __plexi: 1, type: 'state', payload: 'text' })).toBeNull()
    expect(parseBridgeMessage({ __plexi: 1, type: 'state', payload: null })).toBeNull()
  })

  it('bounds a title rather than letting the frame set an essay', () => {
    const m = parseBridgeMessage({ __plexi: 1, type: 'title', payload: 'x'.repeat(500) })
    expect(m?.type).toBe('title')
    expect((m as { payload: string }).payload.length).toBe(120)
    expect(parseBridgeMessage({ __plexi: 1, type: 'title', payload: '   ' })).toBeNull()
  })

  it('bounds a requested height and refuses nonsense', () => {
    expect(parseBridgeMessage({ __plexi: 1, type: 'height', payload: 999999 })).toEqual({
      type: 'height',
      payload: 4000
    })
    expect(parseBridgeMessage({ __plexi: 1, type: 'height', payload: -5 })).toBeNull()
    expect(parseBridgeMessage({ __plexi: 1, type: 'height', payload: 'tall' })).toBeNull()
    expect(parseBridgeMessage({ __plexi: 1, type: 'height', payload: NaN })).toBeNull()
  })

  it('bounds an error string', () => {
    const m = parseBridgeMessage({ __plexi: 1, type: 'error', payload: 'e'.repeat(900) })
    expect((m as { payload: string }).payload.length).toBe(500)
  })
})

// ── Inputs and actions (the widened bridge) ──────────────────────────────────
// ADR-0009's boundary is unchanged: same origin rules, same sandbox attribute,
// same CSP. What widened is the postMessage channel the host already owned, so
// everything new here is something the HOST decides and the frame only asks for.
describe('the act message', () => {
  it('is accepted with an id, because the answer has to reach the caller', () => {
    const m = parseBridgeMessage({
      __plexi: 1,
      type: 'act',
      payload: { id: 'a1', action: { kind: 'open-url', url: 'https://x.test' } }
    })
    expect(m).not.toBeNull()
    expect(m?.type).toBe('act')
  })

  it('is dropped without a usable id', () => {
    for (const id of [undefined, '', 7, null, 'x'.repeat(200)]) {
      expect(
        parseBridgeMessage({ __plexi: 1, type: 'act', payload: { id, action: {} } })
      ).toBeNull()
    }
  })

  it('is dropped when the payload is not an object', () => {
    for (const payload of [null, 'act', 7, []]) {
      expect(parseBridgeMessage({ __plexi: 1, type: 'act', payload })).toBeNull()
    }
  })

  it('does not vet the action itself — that is the policy’s job', () => {
    // Shape here, judgement in customWidgetActions. Keeping them apart means the
    // parser cannot accidentally become the thing that decides what is allowed.
    const m = parseBridgeMessage({
      __plexi: 1,
      type: 'act',
      payload: { id: 'a1', action: { kind: 'delete-everything' } }
    })
    expect(m).not.toBeNull()
  })

  it('still refuses a message that is not from the bridge at all', () => {
    expect(parseBridgeMessage({ type: 'act', payload: { id: 'a1' } })).toBeNull()
  })
})

describe('inputs inlined at compose time', () => {
  const input = {
    id: 'w1',
    kind: 'table',
    title: 'Invoices',
    text: 'Invoices',
    table: {
      id: 'tbl-1',
      columns: [{ id: 'c1', label: 'Client', type: 'text-short' }],
      rows: [{ id: 'r1', cells: { c1: 'Acme' } }]
    }
  }

  it('reaches the document so a widget renders real data on its first frame', () => {
    const html = composeCustomWidgetDocument({ code: '<div></div>', inputs: [input] })
    expect(html).toContain('tbl-1')
    expect(html).toContain('Acme')
  })

  it('defaults to an empty list, never undefined', () => {
    const html = composeCustomWidgetDocument({ code: '<div></div>' })
    expect(html).toContain('var inputs = []')
  })

  it('cannot close the script element it is inlined into', () => {
    // The same escaping state gets. A title containing a closing tag would
    // otherwise end the bridge script and run as markup.
    const html = composeCustomWidgetDocument({
      code: '<div></div>',
      inputs: [{ ...input, title: '</script><img src=x onerror=alert(1)>' }]
    })
    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script')
  })

  it('survives input that will not serialise', () => {
    const circular: Record<string, unknown> = { id: 'w', kind: 'note', title: 't', text: 'x' }
    circular.self = circular
    const html = composeCustomWidgetDocument({
      code: '<div></div>',
      inputs: [circular as never]
    })
    expect(html).toContain('var inputs = []')
  })
})

describe('the boundary ADR-0009 set is unchanged', () => {
  it('still never grants same-origin', () => {
    expect(SANDBOX_ATTR).toBe('allow-scripts')
    expect(sandboxAttrIsSafe('allow-scripts allow-same-origin')).toBe(false)
  })

  it('still blocks the network by default, inputs or not', () => {
    expect(cspFor(false)).toContain("connect-src 'none'")
    const html = composeCustomWidgetDocument({ code: '<div></div>', inputs: [] })
    expect(html).toContain("connect-src 'none'")
  })
})
