// Every widget kind has an AI, and what that AI is FOR differs by kind.
//
// 56 kinds, so this is organised by family rather than 56 hand-written
// vocabularies. A family says what the AI changes and in what terms; a kind can
// still override its wording where the family's phrasing would be vague.
//
// The families are not a tidy-up — they are the honest answer to "what can AI
// do to this widget?", and they differ in kind, not degree:
//
//   text          it writes the words            a sticky, a note, a card
//   structured    it emits a typed payload       a mindmap's nodes and edges
//   target        it resolves WHAT to point at   a browser's URL, a portal's desk
//   instruction   it writes a rule you could     an inbox filter, an agent's
//                 have written yourself          standing instruction, a brief
//   config        it chooses the settings        a chart's table, shape and fields
//   document      it defers to the editor's      a doc, a sheet, a deck — these
//                 own AI, which is richer        have real authoring AI already
//   naming        there is nothing to configure  a calculator, a colour picker
//
// `naming` is deliberately not dressed up. A calculator has no configuration,
// and an AI button promising to "set up your calculator" would be a lie. What
// it can honestly do is name the widget for the desk it sits on.

export type WidgetAiFamily =
  | 'text'
  | 'structured'
  | 'target'
  | 'instruction'
  | 'config'
  | 'document'
  | 'naming'

export interface FamilyShape {
  /** The verb pair: [empty, has content]. */
  verbs: readonly [string, string]
  /** Why this family exists, for the registry's own readers. */
  note: string
}

export const FAMILIES: Readonly<Record<WidgetAiFamily, FamilyShape>> = {
  text: { verbs: ['Write with AI', 'Rewrite with AI'], note: 'AI produces the words' },
  structured: { verbs: ['Build with AI', 'Rebuild with AI'], note: 'AI emits a typed payload' },
  target: { verbs: ['Find with AI', 'Change with AI'], note: 'AI resolves what to point at' },
  instruction: { verbs: ['Describe with AI', 'Refine with AI'], note: 'AI writes the rule' },
  config: { verbs: ['Set up with AI', 'Reconfigure with AI'], note: 'AI chooses the settings' },
  document: { verbs: ['Open the editor AI', 'Open the editor AI'], note: 'defer to the editor' },
  naming: { verbs: ['Name with AI', 'Rename with AI'], note: 'nothing else to configure' }
}

/**
 * Every kind, with its family and what its AI actually does.
 *
 * The purpose line is what the button promises, so it is written per kind: "set
 * up this widget" tells someone nothing about what they are about to get, and
 * that vagueness was half the original complaint.
 */
export const WIDGET_AI: Readonly<
  Record<string, { family: WidgetAiFamily; purpose: string }>
> = {
  // ── text ────────────────────────────────────────────────────────────────
  sticky: { family: 'text', purpose: 'Draft the to-dos from what this desk is about' },
  note: { family: 'text', purpose: 'Draft the notes from what this desk is about' },
  markdown: { family: 'text', purpose: 'Draft the points from what this desk is about' },
  card: { family: 'text', purpose: 'Write the callout — title and body' },
  page: { family: 'text', purpose: 'Draft the page: headings, then sections under them' },
  scratchpad: { family: 'text', purpose: 'Put the first thoughts on the sketch surface as text' },

  // ── structured ──────────────────────────────────────────────────────────
  mindmap: { family: 'structured', purpose: 'Propose the branches, as real nodes and edges' },
  diagram: { family: 'structured', purpose: 'Propose the shapes and the connections between them' },
  'custom-block': { family: 'structured', purpose: 'Choose the typed fields and lay them out' },
  streamdeck: { family: 'structured', purpose: 'Propose the buttons and group them into folders' },
  shape: { family: 'structured', purpose: 'Pick the shape and its label' },

  // ── target ──────────────────────────────────────────────────────────────
  webview: { family: 'target', purpose: 'Work out which site you meant and open it' },
  pdf: { family: 'target', purpose: 'Find the PDF you meant' },
  image: { family: 'target', purpose: 'Find the image you meant' },
  video: { family: 'target', purpose: 'Find the video you meant' },
  gdoc: { family: 'target', purpose: 'Find the Google Doc you meant' },
  gsheet: { family: 'target', purpose: 'Find the Google Sheet you meant' },
  gslide: { family: 'target', purpose: 'Find the Google Slides deck you meant' },
  file: { family: 'target', purpose: 'Find the file in this workspace you meant' },
  drive: { family: 'target', purpose: 'Find the folder to pin here' },
  'task-link': { family: 'target', purpose: 'Find the desk to reference' },
  portal: { family: 'target', purpose: 'Find the desk to watch' },
  'local-app-launcher': { family: 'target', purpose: 'Work out which app you meant' },
  'location-map': { family: 'target', purpose: 'Turn what you described into a real address' },
  'mail-thread': { family: 'target', purpose: 'Find the email or thread you meant' },
  'chat-thread': { family: 'target', purpose: 'Find the channel to bind to' },
  webhook: { family: 'target', purpose: 'Set the URL this posts to' },

  // ── instruction ─────────────────────────────────────────────────────────
  inbox: { family: 'instruction', purpose: 'Write the rule that narrows the mail to this desk' },
  attention: { family: 'instruction', purpose: 'Write the filter for what should surface here' },
  agent: { family: 'instruction', purpose: 'Write the standing instruction and pick its trigger' },
  'living-doc': { family: 'instruction', purpose: 'Write the brief it keeps the summary against' },
  custom: { family: 'instruction', purpose: 'Describe the tool you need and have it built' },
  'image-gen': { family: 'instruction', purpose: 'Write the prompt for the image' },
  'inbound-hook': { family: 'instruction', purpose: 'Describe what arrives here and what to do with it' },
  'voice-recorder': { family: 'instruction', purpose: 'Say what to do with the recording once it lands' },

  // ── config ──────────────────────────────────────────────────────────────
  chart: { family: 'config', purpose: 'Pick the table, the chart shape and the fields to plot' },
  metrics: { family: 'config', purpose: 'Choose the numbers to read together' },
  'stat-card': { family: 'config', purpose: 'Choose the number to watch and its history' },
  table: { family: 'config', purpose: 'Propose columns, then generate rows to match them' },
  field: { family: 'config', purpose: 'Pick the field type and what it is called' },
  'task-list': { family: 'config', purpose: 'Choose which tasks this shows, and how they are sorted' },
  contacts: { family: 'config', purpose: 'Choose the people this desk is about' },
  calendar: { family: 'config', purpose: 'Choose what the month should mark' },
  gallery: { family: 'config', purpose: 'Choose the pictures to show' },
  email: { family: 'config', purpose: 'Choose the account and the view' },
  timer: { family: 'config', purpose: 'Set the countdown for what you are doing' },
  section: { family: 'config', purpose: 'Name the group and decide what belongs in it' },

  // ── document: their editors already have real authoring AI ──────────────
  doc: { family: 'document', purpose: 'Write in the document, with its own editor AI' },
  sheet: { family: 'document', purpose: 'Build the spreadsheet, with its own editor AI' },
  slides: { family: 'document', purpose: 'Build the deck, with its own editor AI' },
  design: { family: 'document', purpose: 'Lay out the design, with its own editor AI' },
  draw: { family: 'document', purpose: 'Draw, with the artwork editor AI' },
  map: { family: 'document', purpose: 'Diagram, with the diagram editor AI' },

  // ── naming: honestly nothing else to configure ──────────────────────────
  calculator: { family: 'naming', purpose: 'Name it for what you are working out' },
  color: { family: 'naming', purpose: 'Name it for what the colour is for' },
  minimap: { family: 'naming', purpose: 'Name it — the map itself needs no setting' }
}

/** Kinds in the catalogue that this registry does not cover yet. Should be []. */
export function uncoveredKinds(allKinds: readonly string[]): string[] {
  return allKinds.filter((k) => !(k in WIDGET_AI))
}

export function familyOf(kind: string): WidgetAiFamily | null {
  return WIDGET_AI[kind]?.family ?? null
}

/** The verb for a kind, given whether the widget already has something in it. */
export function verbFor(kind: string, empty: boolean): string | null {
  const entry = WIDGET_AI[kind]
  if (!entry) return null
  const [emptyVerb, filledVerb] = FAMILIES[entry.family].verbs
  return empty ? emptyVerb : filledVerb
}
