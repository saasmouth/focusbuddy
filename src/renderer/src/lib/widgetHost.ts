// Whether this renderer is the widget host: ONE Plexii widget or Office
// document, from a `.plexii-*` file, shown inside PlexiiLite (src/web/widgetHost,
// F2 of plexii-lite docs/plans/widget-files.md).
//
// The host is not a desk and is not signed in. So anything that offers a desk
// action (move, pin, link, open on a desk) or Plexii's AI (set up with AI,
// expand with AI, ask the assistant) has nothing behind it there, and d0's rule
// is to hide it, never to leave a dead button or anything that implies a Plexii
// feature works when it doesn't. Components check inWidgetHost() at render
// time, the same way renderWidget checks __PLEXII_WEB__, so code outside React
// (menus, providers) can ask too.
//
// Set once, by the host entry, before anything renders.

export interface WidgetHostMode {
  /** Signed out in PlexiiLite: shown, never edited, never saved. */
  readOnly: boolean
}

const KEY = '__PLEXII_WIDGET_HOST__'

export function widgetHostMode(): WidgetHostMode | null {
  const v = (globalThis as Record<string, unknown>)[KEY] as WidgetHostMode | undefined
  return v && typeof v === 'object' ? v : null
}

export const inWidgetHost = (): boolean => widgetHostMode() !== null

/** Called by the widget host entry only (src/web/widgetHost/main.tsx). */
export function enterWidgetHost(mode: WidgetHostMode): void {
  ;(globalThis as Record<string, unknown>)[KEY] = Object.freeze({ ...mode })
}

/**
 * What the host does not offer because it needs Plexii itself, by command id
 * (the Office registries') or shared menu action. Each control that reaches one
 * of these asks offeredHere() where it is drawn, so in the host it is simply
 * not there -- never a dead button (tests/widget-host proves every control left
 * is served).
 *
 *   Saved snippets: Plexii's library, shared across desks, never in a file.
 *   AI: the host is not signed in and has no assistant.
 *   Document comments: kept by Plexii beside the document, not in its body,
 *   so the file would lose them.
 *   Imports and exports that go through the desktop (a note's HTML and PDF,
 *   a sheet's .xlsx and .csv): the file here is PlexiiLite's, and the desktop
 *   dialogs they need are not in the host. Imports that read a file in the
 *   page itself (a diagram's draw.io and JSON) work and stay.
 */
const NEEDS_PLEXII: ReadonlySet<string> = new Set([
  'insertSnippet', 'saveAsSnippet',
  'doc-insert-snippet', 'doc-save-snippet', 'sheet-insert-snippet', 'sheet-save-snippet',
  'sl-snippet', 'sl-save-snippet', 'ds-insert-snippet', 'ds-save-snippet', 'dg-insert-snippet',
  'edit.insertSnippet', 'edit.saveAsSnippet',
  'askAssist', 'askAssistAboutThis',
  'doc-comments',
  'md-export',
  'sheet-import', 'sheet-export-xlsx', 'sheet-export-csv',
  'doc-ai-draft', 'doc-ai-rewrite', 'sheet-ai-fill', 'sl-ai', 'dg-ai-diagram', 'ai.applyPaint', 'ai.applyScene'
])

/** False for a command or menu action the widget host does not offer; true everywhere else. */
export function offeredHere(idOrAction: string): boolean {
  return !(inWidgetHost() && NEEDS_PLEXII.has(idOrAction))
}
