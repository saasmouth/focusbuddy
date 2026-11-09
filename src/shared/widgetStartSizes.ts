// Where everything on a desk starts: the owner's "Plexii starting sizes"
// standard (2026-11-09). One table, read by the widget catalog in the renderer
// and by createWidget in main, so a widget made by a drag, the palette, an
// agent or MCP starts the same.
//
// Every number is a multiple of the canvas's 20 px step, so a size lands on the
// grid and on the Workcentre's columns without a gap to fix by hand. Each is
// only where a widget STARTS: nothing here touches a widget already on a desk.
//
// Not listed, because they cannot be placed on a desk: PlexiiVault, PlexiiCall
// and PlexiiSign (the standard gives them 620 x 420, 420 x 300 and 960 x 660
// for when they can be).

export interface StartSize {
  width: number
  height: number
}

const s = (width: number, height: number): StartSize => ({ width, height })

export const WIDGET_START_SIZES: Readonly<Record<string, StartSize>> = {
  // PlexiiApps: landscape, so a laptop does not shrink them and lose the width.
  doc: s(960, 660),
  sheet: s(960, 620),
  slides: s(960, 620),
  draw: s(960, 620),
  map: s(840, 600),
  design: s(740, 560),

  // Tools.
  webview: s(1060, 600),
  inbox: s(420, 420),
  calendar: s(420, 380),
  'chat-thread': s(300, 620),
  drive: s(300, 340),

  // The eight in the side menu by default.
  sticky: s(200, 200),
  note: s(420, 420),
  'task-list': s(420, 380),
  table: s(740, 440),
  page: s(520, 380),
  mindmap: s(740, 520),
  chart: s(620, 380),
  timer: s(200, 300),

  // Other work widgets.
  attention: s(420, 480),
  agent: s(300, 480),
  contacts: s(300, 300),
  metrics: s(420, 240),
  'stat-card': s(300, 160),
  streamdeck: s(740, 260),
  markdown: s(520, 420),
  'living-doc': s(520, 420),
  custom: s(520, 420),
  gallery: s(520, 340),
  scratchpad: s(620, 420),
  'image-gen': s(420, 480),
  'location-map': s(420, 340),
  'custom-block': s(420, 340),
  portal: s(420, 300),
  card: s(300, 200),
  'voice-recorder': s(300, 240),
  file: s(300, 240),
  webhook: s(300, 200),
  'inbound-hook': s(300, 160),
  field: s(300, 120),
  'task-link': s(300, 120),
  calculator: s(200, 300),
  color: s(200, 240),
  shape: s(200, 160),
  'local-app-launcher': s(200, 120),
  section: s(740, 340),

  // Older kinds that still open.
  'mail-thread': s(420, 460),
  pdf: s(620, 660),
  gdoc: s(620, 500),
  gsheet: s(620, 480),
  gslide: s(620, 420),
  email: s(620, 500),
  image: s(420, 300),
  video: s(520, 300),
  diagram: s(740, 520),

  // Not in the owner's standard: placed by the meeting wrap-up, where it has
  // always stood at this size beside the transcript.
  'meeting-record': s(420, 440),

  // Pinned chrome.
  minimap: s(220, 160)
}

/** Where a work widget of this kind starts, or null for a kind the standard does not cover. */
export function startSizeFor(kind: string): StartSize | null {
  return WIDGET_START_SIZES[kind] ?? null
}

// What each kind started at before the standard. A widget still exactly at one
// of these was never sized by anybody, so when it moves it takes the standard;
// any other size is somebody's choice and moves with the widget.
const PREVIOUS_START_SIZES: Readonly<Record<string, StartSize>> = {
  doc: s(860, 760),
  sheet: s(880, 580),
  slides: s(900, 600),
  draw: s(780, 560),
  map: s(720, 520),
  design: s(720, 540),
  webview: s(1920, 1080),
  inbox: s(380, 360),
  calendar: s(360, 400),
  'chat-thread': s(340, 460),
  drive: s(300, 260),
  sticky: s(240, 200),
  note: s(400, 320),
  'task-list': s(360, 320),
  table: s(680, 440),
  page: s(480, 400),
  mindmap: s(720, 480),
  chart: s(520, 380),
  timer: s(224, 224),
  attention: s(380, 340),
  agent: s(320, 300),
  contacts: s(340, 300),
  metrics: s(420, 280),
  'stat-card': s(340, 240),
  streamdeck: s(760, 260),
  markdown: s(460, 360),
  'living-doc': s(500, 400),
  custom: s(460, 400),
  gallery: s(460, 340),
  scratchpad: s(560, 420),
  'image-gen': s(420, 460),
  'custom-block': s(440, 380),
  portal: s(300, 240),
  card: s(280, 200),
  'voice-recorder': s(320, 240),
  file: s(320, 240),
  webhook: s(320, 180),
  'inbound-hook': s(340, 200),
  field: s(240, 100),
  'task-link': s(280, 110),
  calculator: s(208, 300),
  color: s(220, 200),
  section: s(480, 360),
  'mail-thread': s(380, 420),
  pdf: s(560, 640),
  gdoc: s(600, 500),
  gsheet: s(640, 480),
  gslide: s(640, 420),
  email: s(600, 500),
  image: s(360, 280),
  video: s(480, 320),
  diagram: s(760, 520)
}

/**
 * The size a widget has after moving to another desk. A widget nobody has sized
 * (still at its old starting size) takes the standard; one somebody sized keeps
 * that size, because the standard is only ever where a widget starts.
 */
export function sizeWhenMoved(kind: string, width: number, height: number): StartSize {
  const before = PREVIOUS_START_SIZES[kind]
  const now = WIDGET_START_SIZES[kind]
  if (before && now && before.width === width && before.height === height) return now
  return { width, height }
}
