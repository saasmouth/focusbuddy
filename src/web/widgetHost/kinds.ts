// Which kinds the widget host shows, and how each one's code is loaded.
//
// renderWidget (components/widgets/renderWidget.tsx) imports every widget
// statically, so a page that used it shipped one 4.6 MB chunk to draw a
// sticky (F2 item 4). Here each kind is its own dynamic import, so a page
// loads the code for the one kind it shows. The components are the SAME ones
// renderWidget uses -- tests/unit/widgetHostKinds.test.ts fails if the two ever
// map a kind to different components, so the host can never drift into a
// fork of the desk.
//
// The kinds are the plan's "New > Plexii widget" list (plexii-lite
// docs/plans/widget-files.md): kinds that work from their own content, with no
// desk, task, server or Electron behind them. Every other widget file is shown
// as an honest "works only in Plexii", never as a broken widget.
import type { ComponentType } from 'react'
import type { Widget } from '@shared/types'

type Loader = () => Promise<{ default: ComponentType<{ widget: Widget }> }>

export const HOST_WIDGET_LOADERS = {
  sticky: () => import('@renderer/components/widgets/StickyWidget'),
  note: () => import('@renderer/components/widgets/NoteWidget'),
  markdown: () => import('@renderer/components/widgets/MarkdownWidget'),
  page: () => import('@renderer/components/widgets/PageWidget'),
  card: () => import('@renderer/components/widgets/CardWidget'),
  scratchpad: () => import('@renderer/components/widgets/ScratchpadWidget'),
  calculator: () => import('@renderer/components/widgets/CalculatorWidget'),
  color: () => import('@renderer/components/widgets/ColorWidget'),
  timer: () => import('@renderer/components/widgets/TimerWidget'),
  shape: () => import('@renderer/components/widgets/ShapeWidget'),
  field: () => import('@renderer/components/widgets/FieldWidget'),
  'task-list': () => import('@renderer/components/widgets/TaskListWidget'),
  metrics: () => import('@renderer/components/widgets/MetricsWidget'),
  'stat-card': () => import('@renderer/components/widgets/StatCardWidget'),
  mindmap: () => import('@renderer/components/widgets/MindMapWidget'),
  'custom-block': () => import('@renderer/components/widgets/CustomBlockWidget'),
  table: () => import('@renderer/components/widgets/TableWidget'),
  chart: () => import('@renderer/components/widgets/ChartWidget'),
  'location-map': () => import('@renderer/components/widgets/LocationMapWidget')
} satisfies Record<string, Loader>

/** The six Office document types; each is shown by the desk's Office widget. */
export const HOST_DOCUMENT_TYPES = ['doc', 'sheet', 'slides', 'map', 'design', 'draw'] as const
export type HostDocumentType = (typeof HOST_DOCUMENT_TYPES)[number]
const officeWidget: Loader = () => import('@renderer/components/widgets/OfficeDocWidget')

export type HostWidgetKind = keyof typeof HOST_WIDGET_LOADERS

export const isHostWidgetKind = (k: string): k is HostWidgetKind => Object.prototype.hasOwnProperty.call(HOST_WIDGET_LOADERS, k)
export const isHostDocumentType = (t: string): t is HostDocumentType => (HOST_DOCUMENT_TYPES as readonly string[]).includes(t)

/** The loader for a kind or document type the host shows; null for anything else. */
export function loaderFor(kind: string): Loader | null {
  if (isHostWidgetKind(kind)) return HOST_WIDGET_LOADERS[kind] as Loader
  if (isHostDocumentType(kind)) return officeWidget
  return null
}
