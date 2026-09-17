// The canonical "render a widget as an inline focus-mode body" switch. Extracted
// verbatim from WidgetFocusMode.renderInline so BOTH the classic single-card path
// and the split-view panes render widgets identically (spec §5). Any widget kind
// added here shows up in single AND split with no further wiring.

import type { Widget } from '@shared/types'
import StickyWidget from '../components/widgets/StickyWidget'
import NoteWidget from '../components/widgets/NoteWidget'
import MarkdownWidget from '../components/widgets/MarkdownWidget'
import TaskLinkWidget from '../components/widgets/TaskLinkWidget'
import LocalAppLauncherWidget from '../components/widgets/LocalAppLauncherWidget'
import FileWidget from '../components/widgets/FileWidget'
import FieldWidget from '../components/widgets/FieldWidget'
import PageWidget from '../components/widgets/PageWidget'
import LivingDocWidget from '../components/widgets/LivingDocWidget'
import TableWidget from '../components/widgets/TableWidget'
import ChartWidget from '../components/widgets/ChartWidget'
import CalculatorWidget from '../components/widgets/CalculatorWidget'
import ColorWidget from '../components/widgets/ColorWidget'
import WebViewWidget from '../components/widgets/WebViewWidget'
import ImageWidget from '../components/widgets/ImageWidget'
import VideoWidget from '../components/widgets/VideoWidget'
import TimerWidget from '../components/widgets/TimerWidget'
import VoiceRecorderWidget from '../components/widgets/VoiceRecorderWidget'
import MindMapWidget from '../components/widgets/MindMapWidget'
import ShapeWidget from '../components/widgets/ShapeWidget'
import CardWidget from '../components/widgets/CardWidget'
import CustomBlockWidget from '../components/widgets/CustomBlockWidget'
import OfficeDocWidget from '../components/widgets/OfficeDocWidget'
import DiagramWidget from '../components/widgets/DiagramWidget'
import StreamDeckWidget from '../components/widgets/StreamDeckWidget'
import AgentWidget from '../components/widgets/AgentWidget'
import WebhookWidget from '../components/widgets/WebhookWidget'
import InboundHookWidget from '../components/widgets/InboundHookWidget'
import PortalWidget from '../components/widgets/PortalWidget'
import ScratchpadWidget from '../components/widgets/ScratchpadWidget'
import ChatThreadWidget from '../components/widgets/ChatThreadWidget'

export function renderWidgetInline(w: Widget): JSX.Element | null {
  switch (w.kind) {
    case 'sticky':
      return <StickyWidget widget={w} inline />
    case 'note':
      return <NoteWidget widget={w} inline />
    case 'markdown':
      return <MarkdownWidget widget={w} inline />
    case 'task-link':
      return <TaskLinkWidget widget={w} inline />
    case 'local-app-launcher':
      return <LocalAppLauncherWidget widget={w} inline />
    case 'file':
      return <FileWidget widget={w} inline />
    case 'field':
      return <FieldWidget widget={w} inline />
    case 'page':
      return <PageWidget widget={w} inline />
    case 'living-doc':
      return <LivingDocWidget widget={w} inline />
    case 'table':
      return <TableWidget widget={w} inline />
    case 'chart':
      return <ChartWidget widget={w} inline />
    case 'calculator':
      return <CalculatorWidget widget={w} inline />
    case 'color':
      return <ColorWidget widget={w} inline />
    case 'image':
      return <ImageWidget widget={w} inline />
    case 'video':
      return <VideoWidget widget={w} inline />
    case 'timer':
      return <TimerWidget widget={w} inline />
    case 'minimap':
      // Deprecated widget kind — the minimap is the canvas FAB now, never a
      // placeable/embeddable widget. Legacy instances render nothing.
      return null
    case 'voice-recorder':
      return <VoiceRecorderWidget widget={w} inline />
    case 'mindmap':
      return <MindMapWidget widget={w} inline />
    case 'shape':
      return <ShapeWidget widget={w} inline />
    case 'card':
      return <CardWidget widget={w} inline />
    case 'custom-block':
      return <CustomBlockWidget widget={w} inline />
    // Office documents, PlexiDiagrams and PlexiDraw — full editors, backed by
    // fb_documents.
    case 'doc':
    case 'sheet':
    case 'slides':
    case 'map':
    case 'design':
    case 'draw':
      return <OfficeDocWidget widget={w} inline />
    case 'diagram':
      return <DiagramWidget widget={w} inline />
    case 'streamdeck':
      return <StreamDeckWidget widget={w} inline />
    case 'scratchpad':
      return <ScratchpadWidget widget={w} inline />
    case 'agent':
      return <AgentWidget widget={w} inline />
    case 'webhook':
      return <WebhookWidget widget={w} inline />
    case 'inbound-hook':
      return <InboundHookWidget widget={w} inline />
    case 'portal':
      return <PortalWidget widget={w} inline />
    case 'chat-thread':
      // ChatThreadWidget renders its own body (no WidgetFrame), so no inline prop.
      return <ChatThreadWidget widget={w} />
    case 'section':
      return null
    case 'webview':
    case 'pdf':
    case 'gdoc':
    case 'gsheet':
    case 'gslide':
    case 'email':
      return <WebViewWidget widget={w} inline />
    default:
      return null
  }
}
