// GENERATED FILE -- DO NOT EDIT.
// Vendored from projects/haptyx-shared/src by scripts/sync-contract.mjs.
// Edit the canonical copy there, then run: npm run sync:contract
// The public desk projection: the single wire contract shared by the desktop
// (which builds it), Signal (which stores and serves it) and the public viewer
// (which renders it).
//
// This file is the privacy boundary. A desk widget's database row carries
// content the public must never see -- file paths, connected-app identity,
// webhook secrets, agent instructions, session partitions. The projection is an
// allowlist: the builder must translate each widget into one of the render
// payloads below, and anything it does not understand becomes a placeholder
// rather than leaking `content` verbatim.
//
// Deliberately dependency-free so desktop, server and browser can all import it.

export const PUBLIC_DESK_SCHEMA = 'plexi.public-desk'
export const PUBLIC_DESK_VERSION = 1

/** Geometry in desk-space. The viewer applies its own camera on top. */
export interface PublicRect {
  x: number
  y: number
  width: number
  height: number
}

/** A wire between two widgets, kept so the public desk matches the private one. */
export interface PublicLink {
  id: string
  fromWidgetId: string
  toWidgetId: string
  label: string | null
}

/**
 * Bytes are never inlined into the projection. The builder uploads them
 * separately and references them by id; the viewer resolves them through a
 * token-scoped URL so revocation kills asset access too.
 */
export interface PublicAssetRef {
  id: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
}

// --- Render payloads -------------------------------------------------------
//
// One per widget family rather than one per widget kind: 46 kinds collapse into
// 16 shapes the browser knows how to draw. `kind` is retained on the widget for
// labelling, but the viewer switches on `render.type`.

/** Notes, stickies, markdown, scratchpads, cards. Plain text, never HTML. */
export interface PublicRenderText {
  type: 'text'
  /** Plain text or markdown source. The viewer sanitises before rendering. */
  body: string
  format: 'plain' | 'markdown'
}

/** Structured documents: pages, office docs, living docs. */
export interface PublicRenderDoc {
  type: 'doc'
  /** Pre-sanitised HTML. The builder strips scripts, handlers and remote refs. */
  html: string
  pageCount: number
}

/** Tables and spreadsheets. */
export interface PublicRenderTable {
  type: 'table'
  columns: { id: string; name: string; kind: string }[]
  rows: { id: string; cells: (string | number | boolean | null)[] }[]
  truncated: boolean
}

/** Slide decks. Each slide is pre-sanitised HTML. */
export interface PublicRenderSlides {
  type: 'slides'
  slides: { id: string; html: string }[]
}

export interface PublicRenderImage {
  type: 'image'
  assetId: string | null
  alt: string
}

export interface PublicRenderMedia {
  type: 'media'
  assetId: string | null
  media: 'video' | 'audio'
  /** Seconds, when known. Display only. */
  duration: number | null
}

export interface PublicRenderPdf {
  type: 'pdf'
  assetId: string | null
  pageCount: number | null
}

/**
 * Browser widgets and external documents. The public page must never inherit
 * the owner's logged-in session, so this carries URL chrome plus an optional
 * captured preview -- not a live authenticated webview.
 */
export interface PublicRenderLink {
  type: 'link'
  /** Normalised, credential-stripped, http(s) only. */
  url: string
  displayUrl: string
  previewAssetId: string | null
  /** Whether the destination permits framing; the viewer only iframes if true. */
  framable: boolean
}

/** Section containers. Children reference the section by parentSectionId. */
export interface PublicRenderSection {
  type: 'section'
  layout: string | null
}

/** Display-only clock derived from published state. No start/stop/reset. */
export interface PublicRenderTimer {
  type: 'timer'
  /** Milliseconds remaining/elapsed at publishedAt. The viewer may tick locally. */
  valueMs: number
  running: boolean
  mode: 'countdown' | 'stopwatch'
}

export interface PublicRenderChart {
  type: 'chart'
  chart: string
  series: { name: string; points: { label: string; value: number }[] }[]
}

/** Maps, mindmaps and diagrams: nodes and edges, already laid out. */
export interface PublicRenderDiagram {
  type: 'diagram'
  nodes: { id: string; label: string; x: number; y: number }[]
  edges: { id: string; from: string; to: string; label: string | null }[]
}

export interface PublicRenderColor {
  type: 'color'
  value: string
}

export interface PublicRenderField {
  type: 'field'
  label: string
  value: string
  field: string
}

export interface PublicRenderTaskLink {
  type: 'task-link'
  title: string
  status: string | null
  /** Present only when the referenced desk is itself published. */
  publicToken: string | null
}

/** A file reference. `assetId` is null when the owner did not publish bytes. */
export interface PublicRenderFile {
  type: 'file'
  name: string
  mime: string | null
  assetId: string | null
}

/**
 * A picture of a widget the projection has no structural renderer for: its own
 * rendered markup, sanitised and style-inlined at publish time.
 *
 * This is deliberately narrow. Capturing markup is a denylist -- you ship
 * everything and strip what should not be there -- which is the opposite of how
 * the rest of this contract works, so it is permitted only for the kinds named
 * in PUBLIC_CAPTURE_ALLOWED, never as a general fallback. A widget that renders
 * an agent's instructions, a webhook's URL or somebody's mail is not eligible,
 * whatever it looks like on screen.
 */
export interface PublicRenderCapture {
  type: 'capture'
  /**
   * The markup, stored as a token-scoped asset rather than inline.
   *
   * Inline it dominated the payload -- on one desk 74% of 168KB -- and was
   * resent on every revision even when nothing about the widget had changed.
   * As an asset it is fetched once, cached, and dies with the share like every
   * other published byte.
   */
  assetId: string
  /** The originating kind, so the viewer can still label the frame. */
  kind: string
}

/**
 * Everything the projection cannot safely represent: agents, webhooks, inbound
 * hooks, connected mail, chat threads. The public sees that something is there
 * and what it is called -- never its configuration.
 */
export interface PublicRenderPlaceholder {
  type: 'placeholder'
  /** Short human explanation, e.g. "Automation - not available publicly". */
  reason: string
}

export type PublicRender =
  | PublicRenderText
  | PublicRenderDoc
  | PublicRenderTable
  | PublicRenderSlides
  | PublicRenderImage
  | PublicRenderMedia
  | PublicRenderPdf
  | PublicRenderLink
  | PublicRenderSection
  | PublicRenderTimer
  | PublicRenderChart
  | PublicRenderDiagram
  | PublicRenderColor
  | PublicRenderField
  | PublicRenderTaskLink
  | PublicRenderFile
  | PublicRenderPlaceholder
  | PublicRenderCapture

export type PublicRenderType = PublicRender['type']

export interface PublicWidget {
  id: string
  /**
   * The widget's own rendered markup, as a token-scoped asset.
   *
   * Present in ADDITION to `render`, never instead of it. The canvas shows this
   * when it exists, because a hand-written renderer of somebody else's widget
   * is always a worse likeness than the widget itself -- a shared desk that
   * does not look like the desk is not worth sharing. The structural `render`
   * stays because it is what the list view reads, what a screen reader gets,
   * and what remains when a capture could not be taken.
   */
  captureAssetId?: string | null
  /** The originating widget kind, for labelling only. */
  kind: string
  title: string
  rect: PublicRect
  zIndex: number
  color: string | null
  parentSectionId: string | null
  render: PublicRender
}

export interface PublicDeskProjectionV1 {
  schema: typeof PUBLIC_DESK_SCHEMA
  version: 1
  deskId: string
  title: string
  publishedAt: number
  revision: number
  bounds: PublicRect
  widgets: PublicWidget[]
  links: PublicLink[]
  assets: PublicAssetRef[]
}

// --- Disclosure policy -----------------------------------------------------

/**
 * Which render family each widget kind projects into. A kind absent from this
 * map is unsupported and MUST become a placeholder -- that is the fail-closed
 * default, so a new widget kind added to the desktop cannot silently start
 * disclosing its content publicly before anyone writes a projector for it.
 */
export const PUBLIC_RENDER_POLICY: Readonly<Record<string, PublicRenderType>> = Object.freeze({
  sticky: 'text',
  note: 'text',
  markdown: 'text',
  scratchpad: 'text',
  card: 'text',
  'custom-block': 'text',

  page: 'doc',
  doc: 'doc',
  'living-doc': 'doc',

  table: 'table',
  sheet: 'table',

  slides: 'slides',
  gslide: 'link',

  image: 'image',
  'image-gen': 'image',
  // A shape carries a fill and a geometry, not a file. Projecting it as an
  // image meant every shape published as "image not published"; its colour is
  // the honest part we can carry, so it goes out as one.
  shape: 'color',

  video: 'media',
  'voice-recorder': 'media',

  pdf: 'pdf',

  webview: 'link',
  portal: 'link',
  gdoc: 'link',
  gsheet: 'link',

  section: 'section',
  timer: 'timer',
  chart: 'chart',

  map: 'diagram',
  mindmap: 'diagram',
  diagram: 'diagram',

  color: 'color',
  field: 'field',
  'task-link': 'task-link',

  file: 'file',
  drive: 'file'

  // Deliberately unmapped -> placeholder:
  //   agent, webhook, inbound-hook  (executable / secret-bearing)
  //   streamdeck, local-app-launcher (executes local software)
  //   calculator                     (stateful control surface)
  //   email, chat-thread             (private correspondence)
  //   meeting-record                 (provenance-tiered private record)
  //   minimap, attention             (viewer-local chrome, not content)
  //   design                         (a freely-placed canvas with no public
  //                                   renderer yet -- it is a document id, not
  //                                   a file, so projecting it as an image
  //                                   published every design as a missing one)
})

/** Human-readable reason shown for each unsupported kind. */
export const PUBLIC_PLACEHOLDER_REASON: Readonly<Record<string, string>> = Object.freeze({
  agent: 'Agent — not available publicly',
  webhook: 'Webhook — not available publicly',
  'inbound-hook': 'Inbound hook — not available publicly',
  streamdeck: 'Stream Deck — not available publicly',
  'local-app-launcher': 'App launcher — not available publicly',
  calculator: 'Calculator — not available publicly',
  email: 'Mail — not available publicly',
  'chat-thread': 'Chat thread — not available publicly',
  'meeting-record': 'Meeting record — not available publicly',
  minimap: 'Minimap — not available publicly',
  design: 'Design — not available publicly',
  attention: 'Attention — not available publicly'
})

/**
 * Kinds whose rendered markup may be published when no structural projector
 * exists. Everything here shows the owner's own content or a control surface;
 * nothing here renders a secret, a credential, an instruction to an agent, or
 * anybody's correspondence.
 *
 * Deliberately NOT here, and why:
 *   agent, webhook, inbound-hook   render instructions, URLs and secrets
 *   email, chat-thread             private correspondence
 *   meeting-record                 provenance-tiered private record
 *   webview, portal, gdoc,         embedded views of somewhere else, rendered
 *   gsheet, gslide                 with the owner's session -- capturing one
 *                                  would publish a page only they can see
 *   minimap, section               viewer-local chrome and containers
 */
export const PUBLIC_CAPTURE_ALLOWED: ReadonlySet<string> = new Set([
  // The owner's own content, rendered by the app that owns it.
  'sticky', 'note', 'markdown', 'card', 'scratchpad', 'custom-block',
  'page', 'doc', 'living-doc', 'table', 'sheet', 'slides',
  'chart', 'field', 'task-link', 'timer', 'color', 'shape',
  'image', 'image-gen', 'video', 'voice-recorder', 'pdf', 'file', 'drive',
  'mindmap', 'diagram', 'map', 'design',
  // Control surfaces: they show what they do, and do nothing once captured.
  'calculator', 'streamdeck', 'local-app-launcher', 'attention'
])

export function mayCapture(kind: string): boolean {
  return PUBLIC_CAPTURE_ALLOWED.has(kind)
}

export function placeholderReasonFor(kind: string): string {
  return PUBLIC_PLACEHOLDER_REASON[kind] ?? 'Not available publicly'
}

/** True when the kind has an explicit projector; false means fail closed. */
export function isPubliclyRenderable(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(PUBLIC_RENDER_POLICY, kind)
}
