// @vitest-environment node
// What the widget host makes of a file's text before importing anything, so a
// file it cannot show gets an honest state in PlexiiLite's tile (1a's ask):
// the kinds the host shows; a real Plexii kind that needs Plexii (an inbox, a
// voice note) named as such; a file from a newer Plexii; and anything else.
import { describe, it, expect } from 'vitest'
import { classifyFileText } from '../../src/web/widgetHost/classify'
import { HOST_WIDGET_LOADERS, HOST_DOCUMENT_TYPES } from '../../src/web/widgetHost/kinds'

const w = (o: Record<string, unknown>): string => JSON.stringify({ version: 1, title: 't', content: '', color: null, exportedAt: '', ...o })

describe('classifying a file for the widget host', () => {
  it('every kind the host shows, by kind or by type id alone', () => {
    for (const kind of Object.keys(HOST_WIDGET_LOADERS)) expect(classifyFileText(w({ kind }))).toEqual({ family: 'widget', kind })
    expect(classifyFileText(w({ type: 'plexii.widget.sticky' }))).toEqual({ family: 'widget', kind: 'sticky' })
    expect(classifyFileText(w({ type: 'plexii.widget.location' }))).toEqual({ family: 'widget', kind: 'location-map' })
  })

  it('every Office document type', () => {
    for (const docType of HOST_DOCUMENT_TYPES) {
      expect(classifyFileText(JSON.stringify({ type: `plexii.document.${docType}`, version: 1, title: 'd', docType, body: {} }))).toEqual({ family: 'document', kind: docType })
    }
    expect(classifyFileText(JSON.stringify({ type: 'plexii.document.sheet', version: 1, title: 'd', body: {} }))).toEqual({ family: 'document', kind: 'sheet' })
  })

  it('a real Plexii widget that needs Plexii is named, with its own label', () => {
    expect(classifyFileText(w({ kind: 'voice-recorder' }))).toEqual({ error: 'needs-plexii', label: 'Voice note' })
    expect(classifyFileText(w({ type: 'plexii.widget.gallery' }))).toEqual({ error: 'needs-plexii', label: 'Gallery' })
    expect(classifyFileText(w({ kind: 'image-gen' }))).toEqual({ error: 'needs-plexii', label: 'AI image' })
  })

  it('a Plexii file of a kind this build does not know came from a newer Plexii', () => {
    expect(classifyFileText(w({ type: 'plexii.widget.hologram', kind: 'hologram' }))).toEqual({ error: 'newer-than-host' })
    expect(classifyFileText(JSON.stringify({ type: 'plexii.document.poem', version: 1, docType: 'poem', body: {} }))).toEqual({ error: 'newer-than-host' })
  })

  it('anything else is not a Plexii file', () => {
    for (const text of ['', 'not json', '[]', '"sticky"', '{}', JSON.stringify({ type: 'com.apple.note', kind: 'whatever' })]) {
      expect(classifyFileText(text)).toEqual({ error: 'not-a-plexii-file' })
    }
  })
})
