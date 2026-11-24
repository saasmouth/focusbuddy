// @vitest-environment node
// The widget host's message contract (protocol 1), as PlexiiLite reads it.
//
// PlexiiLite shows one Plexii widget or Office document per tile by loading the
// widget host page in a <webview> and relaying messages through its preload
// (window 'message' events, both ways). Each direction has its own types, so a
// top-level page that receives its own posts ignores them. These tests pin the
// shapes PlexiiLite depends on: a version in `ready`, a code and a sentence it
// can show as is in `error`, and a `load` that is either well formed or ignored.
import { describe, it, expect } from 'vitest'
import {
  WIDGET_HOST_PROTOCOL, HOST_TYPES, EMBEDDER_TYPES, readEmbedderMessage, hostMessage, hostError
} from '../../src/web/widgetHost/protocol'

describe('widget host protocol 1', () => {
  it('ready carries the protocol version, so an embedder can refuse a host it does not understand', () => {
    expect(WIDGET_HOST_PROTOCOL).toBe(1)
    expect(hostMessage({ type: HOST_TYPES.ready })).toEqual({ type: 'plexii-widget-host:ready', protocol: 1 })
  })

  it('every host message is stamped with the protocol', () => {
    expect(hostMessage({ type: HOST_TYPES.save, text: '{}' })).toEqual({ type: 'plexii-widget-host:save', protocol: 1, text: '{}' })
    expect(hostMessage({ type: HOST_TYPES.flushed })).toEqual({ type: 'plexii-widget-host:flushed', protocol: 1 })
    expect(hostMessage({ type: HOST_TYPES.loaded, family: 'widget', kind: 'sticky', title: 'Shopping', readOnly: true }))
      .toEqual({ type: 'plexii-widget-host:loaded', protocol: 1, family: 'widget', kind: 'sticky', title: 'Shopping', readOnly: true })
  })

  it('an error is a code plus a sentence to show as is', () => {
    const e = hostError('needs-plexii', { label: 'Voice note' })
    expect(e).toEqual({ type: 'plexii-widget-host:error', protocol: 1, code: 'needs-plexii', message: 'A Voice note works only in Plexii.' })
    expect(hostError('needs-plexii', { label: 'AI image' }).message).toBe('An AI image works only in Plexii.')
    expect(hostError('newer-than-host').message).toBe('This file was made by a newer version of Plexii. Update PlexiiLite to open it.')
    expect(hostError('not-a-plexii-file').message).toBe("This file isn't a Plexii widget or document, or it's damaged.")
    expect(hostError('import-failed', { detail: 'no such table' }).message).toBe("Plexii couldn't open this file: no such table.")
    expect(hostError('save-failed', { detail: 'disk full.' }).message).toBe("Plexii couldn't save the last change: disk full.")
    expect(hostError('render-failed', { detail: 'boom' }).message).toBe('This widget hit a problem while drawing: boom.')
    // Every code has a sentence: none falls through to an empty or technical message.
    for (const code of ['not-a-plexii-file', 'newer-than-host', 'needs-plexii', 'import-failed', 'save-failed', 'render-failed', 'database-unavailable', 'already-loaded', 'cannot-create'] as const) {
      const m = hostError(code, { label: 'Widget', detail: 'x' }).message
      expect(m).toMatch(/^[A-Z].*\.$/)
      expect(m).not.toMatch(/undefined|null|\[object/)
    }
  })

  it('load: the file text, read-only false unless it says true', () => {
    expect(readEmbedderMessage({ type: EMBEDDER_TYPES.load, text: '{"a":1}' })).toEqual({ type: 'plexii-widget-host:load', text: '{"a":1}', readOnly: false })
    expect(readEmbedderMessage({ type: EMBEDDER_TYPES.load, text: 'x', readOnly: true })).toEqual({ type: 'plexii-widget-host:load', text: 'x', readOnly: true })
    expect(readEmbedderMessage({ type: EMBEDDER_TYPES.flush })).toEqual({ type: 'plexii-widget-host:flush' })
  })

  it('create: a kind to make a new file of (PlexiiLite\'s New > Plexii widget / document)', () => {
    expect(readEmbedderMessage({ type: EMBEDDER_TYPES.create, kind: 'sticky' })).toEqual({ type: 'plexii-widget-host:create', kind: 'sticky' })
    for (const bad of [{ type: EMBEDDER_TYPES.create }, { type: EMBEDDER_TYPES.create, kind: '' }, { type: EMBEDDER_TYPES.create, kind: 3 }, { type: EMBEDDER_TYPES.create, kind: 'x'.repeat(65) }]) {
      expect(readEmbedderMessage(bad)).toBeNull()
    }
    expect(hostError('cannot-create', { label: 'Inbox' }).message).toBe("Plexii can't make an Inbox here.")
    expect(hostError('cannot-create', { label: 'Voice note' }).message).toBe("Plexii can't make a Voice note here.")
  })

  it('anything else is ignored, including the host\'s own posts seen by a top-level page', () => {
    for (const junk of [
      null, undefined, 'plexii-widget-host:load', 42, {}, { type: 'other:load', text: 'x' },
      { type: EMBEDDER_TYPES.load }, { type: EMBEDDER_TYPES.load, text: 7 }, { type: EMBEDDER_TYPES.load, text: 'x', readOnly: 'yes' },
      { type: HOST_TYPES.ready, protocol: 1 }, { type: HOST_TYPES.save, protocol: 1, text: 'x' }
    ]) expect(readEmbedderMessage(junk)).toBeNull()
  })
})
