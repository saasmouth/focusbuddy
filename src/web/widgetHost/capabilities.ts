// What the widget host can make and show, as PlexiiLite reads it from
// manifest.json (1a's contract, plexii-lite docs/plans/widget-files.md, "The
// widget host contract"). Pure data, so the build config can write the
// manifest from the very lists the page loads (kinds.ts; a test pins the two).
import { WIDGET_HOST_PROTOCOL } from './protocol'

/** The plan's "New > Plexii widget" kinds: they work from their own content. */
export const HOST_WIDGET_KINDS = [
  'sticky', 'note', 'markdown', 'page', 'card', 'scratchpad', 'calculator', 'color', 'timer', 'shape', 'field',
  'task-list', 'metrics', 'stat-card', 'mindmap', 'custom-block', 'table', 'chart', 'location-map'
] as const

/** The Office document types, with the file type F1 gives each (9e) and the name PlexiiLite offers. */
export const HOST_DOCUMENTS = {
  doc: { ext: '.plexii-doc', label: 'Document' },
  sheet: { ext: '.plexii-sheet', label: 'Spreadsheet' },
  slides: { ext: '.plexii-slides', label: 'Slides' },
  map: { ext: '.plexii-map', label: 'Diagram' },
  design: { ext: '.plexii-design', label: 'Design' },
  draw: { ext: '.plexii-draw', label: 'Artwork' }
} as const

export interface HostManifest {
  protocol: typeof WIDGET_HOST_PROTOCOL
  kinds: string[]
  documents: Record<string, { ext: string; label: string }>
}

/** What the build writes as manifest.json; build-widget-host.mjs adds the pin and the file list. */
export function hostManifest(): HostManifest {
  return { protocol: WIDGET_HOST_PROTOCOL, kinds: [...HOST_WIDGET_KINDS], documents: { ...HOST_DOCUMENTS } }
}
