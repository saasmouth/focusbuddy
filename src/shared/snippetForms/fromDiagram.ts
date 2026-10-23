import type { DiagramSnippetBody } from '../snippets'
import type { Form } from '../snippetForms'
import { normalizeBody } from '../diagram/normalize'
import { mapToSvg } from '../mapExport'
import { L } from './lossy'

/** Padding around a fragment's picture: enough for a stroke and a shadow, no more. */
export const DIAGRAM_PICTURE_PADDING = 16

export function formsOfDiagram(body: DiagramSnippetBody): Form[] {
  const forms: Form[] = [{ kind: 'native', value: body, lossy: [] }]
  // The stored body is untrusted: normalised exactly as a loaded diagram is.
  const map = normalizeBody({ nodes: body.nodes, edges: body.edges })
  if (!map.nodes.length) return forms
  const pic = mapToSvg(map, { padding: DIAGRAM_PICTURE_PADDING })
  // Without the page: mapToSvg still writes a full-size rect, filled with
  // nothing, which an importer would turn into an invisible object over the art.
  const bare = mapToSvg(map, { padding: DIAGRAM_PICTURE_PADDING, background: 'none' })
  bare.svg = bare.svg.replace(`<rect x="0" y="0" width="${bare.width}" height="${bare.height}" fill="none" />`, '')
  forms.push({ kind: 'svg', value: { svg: pic.svg, width: pic.width, height: pic.height, vector: true, app: 'PlexiiDiagrams', importSvg: bare.svg }, lossy: [] })
  const labels = map.nodes.map((n) => (typeof n.label === 'string' ? n.label.trim() : '')).filter(Boolean)
  if (labels.length) forms.push({ kind: 'text', value: labels.join('\n'), lossy: [L.labelsOnly] })
  return forms
}
