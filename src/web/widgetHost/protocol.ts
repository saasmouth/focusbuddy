// The widget host's message contract, protocol 1.
//
// The widget host is a second entry of the browser build: a page that shows ONE
// Plexii widget or Office document from a `.plexii-*` file, for PlexiiLite
// (plexii-lite docs/plans/widget-files.md, F2). PlexiiLite owns the file on
// disk; this page never touches a disk. It is handed the file's text, shows it,
// and hands the text back when the person changes something.
//
// How the two sides talk: the page posts to window.parent and accepts messages
// only from window.parent. In an <iframe> that is the embedding page. In
// PlexiiLite's <webview> the page is top-level, so window.parent is the page
// itself: PlexiiLite's preload (isolated world) listens for 'message' on the
// window, forwards host->embedder types with ipcRenderer.sendToHost, and
// delivers embedder->host messages with window.postMessage(msg, '*'). Each
// direction has its own types, so a top-level page that receives its own posts
// ignores them (readEmbedderMessage returns null for them).
//
// Host -> embedder (every one carries `protocol`):
//   ready    the page is listening; send `load`. Sent once.
//   loaded   the file is shown: family ('widget' | 'document'), kind, title, readOnly.
//   save     the file's new text. Only when it differs from the last text the
//            embedder has, only after the person did something, never read-only.
//   error    { code, message }: the message is a sentence to show as is.
//   flushed  the answer to `flush`, after any pending save was posted.
//   open-link { url }: open this http(s) or mailto address in the person's
//            browser. Links never navigate the page (links.ts).
// Embedder -> host:
//   load     { text, readOnly? }. One per page; open a new page for another file.
//   create   { kind }: make a new file of this kind with Plexii's own code and
//            answer with `save` (PlexiiLite's New > Plexii widget / document).
//   flush    post any pending save now, then `flushed` (before a tile closes).

export const WIDGET_HOST_PROTOCOL = 1 as const

const P = 'plexii-widget-host:'
export const HOST_TYPES = {
  ready: `${P}ready`,
  loaded: `${P}loaded`,
  save: `${P}save`,
  error: `${P}error`,
  flushed: `${P}flushed`,
  openLink: `${P}open-link`
} as const
export const EMBEDDER_TYPES = { load: `${P}load`, create: `${P}create`, flush: `${P}flush` } as const

export type HostErrorCode =
  | 'not-a-plexii-file'
  | 'newer-than-host'
  | 'needs-plexii'
  | 'import-failed'
  | 'save-failed'
  | 'render-failed'
  | 'database-unavailable'
  | 'already-loaded'
  | 'cannot-create'

type Body =
  | { type: typeof HOST_TYPES.ready }
  | { type: typeof HOST_TYPES.loaded; family: 'widget' | 'document'; kind: string; title: string; readOnly: boolean }
  | { type: typeof HOST_TYPES.save; text: string }
  | { type: typeof HOST_TYPES.error; code: HostErrorCode; message: string }
  | { type: typeof HOST_TYPES.flushed }
  | { type: typeof HOST_TYPES.openLink; url: string }

export type HostMessage = Body & { protocol: typeof WIDGET_HOST_PROTOCOL }

export type EmbedderMessage =
  | { type: typeof EMBEDDER_TYPES.load; text: string; readOnly: boolean }
  | { type: typeof EMBEDDER_TYPES.create; kind: string }
  | { type: typeof EMBEDDER_TYPES.flush }

/** A host->embedder message, stamped with the protocol. */
export function hostMessage<B extends Body>(body: B): B & { protocol: typeof WIDGET_HOST_PROTOCOL } {
  return { ...body, protocol: WIDGET_HOST_PROTOCOL }
}

/** Strip a trailing full stop so a detail never ends a sentence with "..". */
const clause = (s: string | undefined): string => String(s ?? '').trim().replace(/[.\s]+$/, '') || 'no reason was given'

/**
 * An error the embedder can show as is: a stable code for its logic and one
 * plain sentence for the person. A file the host cannot show gets an honest
 * state in its tile, never a blank one.
 */
export function hostError(code: HostErrorCode, info: { label?: string; detail?: string } = {}): HostMessage {
  const label = info.label?.trim() || 'widget like this'
  const article = /^[aeiou]/i.test(label) ? 'An' : 'A'
  const message: Record<HostErrorCode, string> = {
    'not-a-plexii-file': "This file isn't a Plexii widget or document, or it's damaged.",
    'newer-than-host': 'This file was made by a newer version of Plexii. Update PlexiiLite to open it.',
    'needs-plexii': `${article} ${label} works only in Plexii.`,
    'import-failed': `Plexii couldn't open this file: ${clause(info.detail)}.`,
    'save-failed': `Plexii couldn't save the last change: ${clause(info.detail)}.`,
    'render-failed': `This widget hit a problem while drawing: ${clause(info.detail)}.`,
    'database-unavailable': `This widget couldn't start: ${clause(info.detail)}.`,
    'already-loaded': 'This page already shows a file. Open a new page for another one.',
    'cannot-create': `Plexii can't make ${article.toLowerCase()} ${label} here${info.detail ? `: ${clause(info.detail)}` : ''}.`
  }
  return hostMessage({ type: HOST_TYPES.error, code, message: message[code] })
}

/**
 * Read a message from the embedder. Anything that is not a well-formed `load`
 * or `flush` is null and is ignored -- including this page's own posts, which a
 * top-level page receives too.
 */
export function readEmbedderMessage(data: unknown): EmbedderMessage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type === EMBEDDER_TYPES.flush) return { type: EMBEDDER_TYPES.flush }
  if (d.type === EMBEDDER_TYPES.create) {
    return typeof d.kind === 'string' && d.kind.length > 0 && d.kind.length <= 64 ? { type: EMBEDDER_TYPES.create, kind: d.kind } : null
  }
  if (d.type !== EMBEDDER_TYPES.load) return null
  if (typeof d.text !== 'string') return null
  if (d.readOnly !== undefined && typeof d.readOnly !== 'boolean') return null
  return { type: EMBEDDER_TYPES.load, text: d.text, readOnly: d.readOnly === true }
}
