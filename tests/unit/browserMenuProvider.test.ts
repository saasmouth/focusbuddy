import { describe, it, expect } from 'vitest'
// Importing the providers module registers the real core providers, including
// the browser-target one we are testing.
import '../../src/renderer/src/lib/contextMenu/providers'
import { resolveMenu } from '../../src/renderer/src/lib/contextMenu/resolve'
import type { MenuContext } from '../../src/renderer/src/lib/contextMenu/types'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import type { Widget } from '../../src/shared/types'

function webviewWidget(): Widget {
  return {
    id: 'w-webview',
    taskId: 't-1',
    kind: 'webview',
    title: '',
    content: 'https://example.org',
    x: 0,
    y: 0,
    width: 600,
    height: 400,
    zIndex: 1,
    color: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    sourceAppId: null,
    mode: null,
    livingQuery: null,
    livingGeneratedAt: null,
    livingPaused: false,
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    syncGroupId: null
  }
}

function browserCtx(payload: Record<string, unknown>, selectionText?: string): MenuContext {
  const w = webviewWidget()
  return {
    object: { type: 'widget', widget: w },
    sub: { granularity: 'browser-target', payload },
    selection: selectionText ? { text: selectionText, sourceWidgetId: w.id, sourceKind: 'webview' } : undefined,
    taskId: 't-1',
    canvasPoint: { x: 0, y: 0 },
    clientPoint: { x: 10, y: 10 }
  }
}

function allLabels(items: CtxMenuItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    if (it.label) out.push(it.label)
    if (it.children) out.push(...allLabels(it.children))
  }
  return out
}

describe('browser-target provider — actions per right-click target', () => {
  it('offers open-link and copy-link for a link target', () => {
    const labels = allLabels(resolveMenu(browserCtx({ linkURL: 'https://news.example.com' })))
    expect(labels).toContain('Open link in new browser')
    expect(labels).toContain('Copy link')
  })

  it('offers add-image for an image target', () => {
    const labels = allLabels(
      resolveMenu(browserCtx({ srcURL: 'https://img.example.com/a.png', mediaType: 'image' }))
    )
    expect(labels).toContain('Add image to this desk')
  })

  it('offers add-video for a video target', () => {
    const labels = allLabels(
      resolveMenu(browserCtx({ srcURL: 'https://v.example.com/a.mp4', mediaType: 'video' }))
    )
    expect(labels).toContain('Add video to this desk')
  })

  it('offers AI Assist and Create seeded from a text selection in the page', () => {
    const labels = allLabels(resolveMenu(browserCtx({}, 'some selected page text')))
    expect(labels).toContain('AI Assist')
    expect(labels).toContain('Create & link')
  })

  it('shows no target-specific rows when right-clicking empty page space', () => {
    const labels = allLabels(resolveMenu(browserCtx({})))
    expect(labels).not.toContain('Open link in new browser')
    expect(labels).not.toContain('Add image to this desk')
    // Still a usable menu (Create at least).
    expect(labels).toContain('Create & link')
  })
})
