import type { JSX } from 'react'
import type { Widget } from '@shared/types'
import WidgetErrorBoundary from '../WidgetErrorBoundary'
import StickyWidget from './StickyWidget'
import ImageGenWidget from './ImageGenWidget'
import WebViewWidget from './WebViewWidget'
import EmbeddedSiteWidget from './EmbeddedSiteWidget'
import NoteWidget from './NoteWidget'
import MarkdownWidget from './MarkdownWidget'
import TaskLinkWidget from './TaskLinkWidget'
import LocalAppLauncherWidget from './LocalAppLauncherWidget'
import FileWidget from './FileWidget'
import DriveWidget from './DriveWidget'
import FieldWidget from './FieldWidget'
import PageWidget from './PageWidget'
import LivingDocWidget from './LivingDocWidget'
import ChatThreadWidget from './ChatThreadWidget'
import TableWidget from './TableWidget'
import ChartWidget from './ChartWidget'
import OfficeDocWidget from './OfficeDocWidget'
import CalculatorWidget from './CalculatorWidget'
import ColorWidget from './ColorWidget'
import ImageWidget from './ImageWidget'
import VideoWidget from './VideoWidget'
import TimerWidget from './TimerWidget'
import SectionWidget from './SectionWidget'
import StreamDeckWidget from './StreamDeckWidget'
import { DeskAttentionWidget } from '../views/attentionWidgets'
import VoiceRecorderWidget from './VoiceRecorderWidget'
import MeetingRecordWidget from './MeetingRecordWidget'
import MindMapWidget from './MindMapWidget'
import DiagramWidget from './DiagramWidget'
import ScratchpadWidget from './ScratchpadWidget'
import ShapeWidget from './ShapeWidget'
import CardWidget from './CardWidget'
import CustomBlockWidget from './CustomBlockWidget'
import AgentWidget from './AgentWidget'
import WebhookWidget from './WebhookWidget'
import InboundHookWidget from './InboundHookWidget'
import PortalWidget from './PortalWidget'

// The live widget dispatcher: one widget row in, the real interactive component
// out. It lives here rather than inside Canvas because the canvas is no longer
// the only surface that renders a real, editable widget -- a dashboard can now
// hold one too, and both must get the same component, the same error isolation
// and the same behaviour. Duplicating a 40-branch switch would guarantee the
// two drift.

// Wrap every widget in its own error boundary so one widget throwing during
// render degrades to a small in-place "hit a problem" card instead of unmounting
// the whole canvas. Section children route through renderWidget too (see the
// 'section' case), so they are isolated the same way.
// True in the browser runtime, set by src/web/api/bridge.ts before the renderer
// mounts. Read at render time rather than captured, so it is never stale.
const isWeb = (): boolean => (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ === true

export function renderWidget(w: Widget): JSX.Element | null {
  const inner = renderWidgetInner(w)
  if (inner === null) return null
  return (
    <WidgetErrorBoundary widgetId={w.id} label={w.title || w.kind}>
      {inner}
    </WidgetErrorBoundary>
  )
}

function renderWidgetInner(w: Widget): JSX.Element | null {
  switch (w.kind) {
    case 'sticky':
      return <StickyWidget widget={w} />
    case 'image-gen':
      return <ImageGenWidget widget={w} />
    case 'note':
      return <NoteWidget widget={w} />
    case 'markdown':
      return <MarkdownWidget widget={w} />
    case 'task-link':
      return <TaskLinkWidget widget={w} />
    case 'local-app-launcher':
      return <LocalAppLauncherWidget widget={w} />
    case 'file':
      return <FileWidget widget={w} />
    case 'drive':
      return <DriveWidget widget={w} />
    case 'field':
      return <FieldWidget widget={w} />
    case 'page':
      return <PageWidget widget={w} />
    case 'table':
      return <TableWidget widget={w} />
    case 'chart':
      return <ChartWidget widget={w} />
    case 'doc':
    case 'sheet':
    case 'slides':
    case 'map':
    case 'design':
      return <OfficeDocWidget widget={w} />
    case 'calculator':
      return <CalculatorWidget widget={w} />
    case 'color':
      return <ColorWidget widget={w} />
    case 'image':
      return <ImageWidget widget={w} />
    case 'video':
      return <VideoWidget widget={w} />
    case 'timer':
      return <TimerWidget widget={w} />
    case 'streamdeck':
      return <StreamDeckWidget widget={w} />
    case 'minimap':
      // Deprecated: the minimap is now the always-present corner FAB
      // (CanvasMinimapFAB). A stored legacy minimap widget must NEVER render —
      // it would float mid-canvas at its world position (drifting with pan/zoom)
      // and duplicate the FAB, which is exactly the "minimap in the middle,
      // showing twice" bug. The migration effect below also deletes them from
      // storage; this guarantees they are invisible even before that runs.
      return null
    case 'attention':
      // DEC-045: the desk-scoped command-center face (CR-09 D-B).
      return <DeskAttentionWidget widget={w} />
    case 'voice-recorder':
      return <VoiceRecorderWidget widget={w} />
    case 'meeting-record':
      // C5 — the Record on the meeting's own desk, provenance intact.
      return <MeetingRecordWidget widget={w} />
    case 'mindmap':
      return <MindMapWidget widget={w} />
    case 'diagram':
      return <DiagramWidget widget={w} />
    case 'scratchpad':
      return <ScratchpadWidget widget={w} />
    case 'shape':
      return <ShapeWidget widget={w} />
    case 'card':
      return <CardWidget widget={w} />
    case 'custom-block':
      return <CustomBlockWidget widget={w} />
    case 'agent':
      return <AgentWidget widget={w} />
    case 'webhook':
      return <WebhookWidget widget={w} />
    case 'inbound-hook':
      return <InboundHookWidget widget={w} />
    case 'portal':
      return <PortalWidget widget={w} />
    case 'living-doc':
      return <LivingDocWidget widget={w} />
    case 'section':
      return <SectionWidget widget={w} renderChild={renderWidget} />
    case 'webview':
    case 'pdf':
    case 'gdoc':
    case 'gsheet':
    case 'gslide':
    case 'email':
      // WebViewWidget is an Electron <webview>: a real embedded browser with
      // its own cookie jar and navigation events, none of which exists in a
      // tab. There it renders nothing at all, which is what made every browser
      // widget on a synced desk come up blank in the cloud app.
      return isWeb() ? <EmbeddedSiteWidget widget={w} /> : <WebViewWidget widget={w} />
    case 'chat-thread':
      return <ChatThreadWidget widget={w} />
    default:
      return null
  }
}
