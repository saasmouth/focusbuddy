// Saved snippets: reusable pieces of work a user can drop into anything.
//
// A snippet is one saved component — a formatted table, a signature block, a
// pricing grid, a KPI widget, a diagram legend — that the user keeps and
// re-inserts wherever it is relevant. Two things make it more than copy-paste:
//
// LINK MODE. Inserting a snippet is either a DUPLICATE or a LIVE instance.
// A duplicate is an ordinary editable copy: it stops tracking the saved
// original the moment it lands, which is what you want for a starting point.
// A live instance stores only the snippet's id and resolves its body at render
// time, so editing the master updates every place it appears — the same
// mechanism the document editor already uses for embedded widgets, and for the
// same reason: the host never carries a stale copy.
//
// SCOPE. A snippet is personal or organisational. Personal snippets are the
// user's own reusable assets. Organisational ones belong to the workspace, so
// everyone in that org can find and use them — which is how a team keeps one
// real pricing table instead of nine drifting ones. There is no separate
// permission system for this: org snippets live under the org's `orgId`, and a
// user only has an org they were invited into and switched to, so being able to
// see an org's library IS the invitation. The reserved 'personal' org has no
// one else in it, so everything there is personal by definition.
//
// WHERE THEY GO. Snippets are typed by what they hold, and each surface
// declares which kinds it accepts (see SnippetTarget). A document accepts a doc
// fragment; a desk accepts a widget; a sheet accepts a cell range. This is a
// registry rather than a list of special cases, so a new surface opts in by
// registering, without this module knowing it exists.

/**
 * What a snippet holds. The kind decides which surfaces can take it, and how
 * its body is read — each kind has its own body shape below.
 */
export type SnippetKind = 'doc' | 'widget' | 'sheet' | 'slide' | 'design' | 'diagram' | 'draw'

/** Personal to the author, or shared with everyone in the org. */
export type SnippetScope = 'personal' | 'org'

/**
 * How an inserted instance relates to the saved snippet.
 *
 * 'duplicate' — an independent copy. Later edits to the master never reach it.
 * 'live'      — a reference. The host stores the id; the body is resolved when
 *               it renders, so a master edit shows up everywhere at once.
 */
export type SnippetLink = 'duplicate' | 'live'

/** A document fragment: the top-level nodes of a ProseMirror/TipTap document. */
export interface DocSnippetBody {
  kind: 'doc'
  /** TipTap JSON nodes, as they appear in a document's `content` array. */
  content: unknown[]
  /** Plain text, for search and for an honest preview before anything renders. */
  text: string
}

/** A desk widget, in the same shape the desk template store already uses. */
export interface WidgetSnippetBody {
  kind: 'widget'
  widgetKind: string
  title: string
  content: string
  width: number
  height: number
  color: string | null
}

/** A rectangular block of cells, values and formats together. */
export interface SheetSnippetBody {
  kind: 'sheet'
  /** Row-major values. Ragged rows are padded on insert, never on save. */
  rows: string[][]
  /** Per-cell formats keyed "r,c" relative to the block's top-left. */
  formats?: Record<string, unknown>
}

/** One or more slide elements, positioned relative to the block's top-left. */
export interface SlideSnippetBody {
  kind: 'slide'
  elements: unknown[]
}

/** PlexiiDesign canvas elements, positioned relative to the block's top-left. */
export interface DesignSnippetBody {
  kind: 'design'
  elements: unknown[]
}

/** A diagram fragment: nodes plus the edges between them. */
export interface DiagramSnippetBody {
  kind: 'diagram'
  nodes: unknown[]
  edges: unknown[]
}

/**
 * PlexiiDraw objects (shared/draw.ts DrawObject), positioned relative to the
 * block's top-left. Its own kind, not 'design': Draw's objects and Design's
 * elements are different models, and the kind/body agreement check exists so a
 * surface is never handed an object another app wrote.
 */
export interface DrawSnippetBody {
  kind: 'draw'
  objects: unknown[]
}

export type SnippetBody =
  | DocSnippetBody
  | WidgetSnippetBody
  | SheetSnippetBody
  | SlideSnippetBody
  | DesignSnippetBody
  | DiagramSnippetBody
  | DrawSnippetBody

export interface Snippet {
  id: string
  kind: SnippetKind
  name: string
  description: string
  body: SnippetBody
  tags: string[]
  scope: SnippetScope
  /** The tenancy this snippet belongs to. PERSONAL_ORG_ID for the private workspace. */
  orgId: string
  /**
   * Who saved it: the signed-in account's email, which is the only stable
   * identifier the main process has locally (there is no account id in
   * PublicAccountState). Null when the workspace is anonymous, which is the
   * normal local-first case. Only meaningful for scope 'personal' inside a real
   * org, where it separates "mine" from a colleague's.
   */
  authorId: string | null
  /**
   * Bumped on every change to the body. A live instance renders whatever
   * revision is current; this exists so a host can tell that what it last drew
   * is out of date without diffing bodies.
   */
  revision: number
  /** How many times it has been inserted. Counted on insert, never estimated. */
  usageCount: number
  createdAt: number
  updatedAt: number
}

/** The fields a caller supplies when saving something as a snippet. */
export interface SnippetDraft {
  kind: SnippetKind
  name: string
  description?: string
  body: SnippetBody
  tags?: string[]
  scope?: SnippetScope
}

/** The fields that can change afterwards. Omitting one leaves it alone. */
export interface SnippetPatch {
  name?: string
  description?: string
  body?: SnippetBody
  tags?: string[]
  scope?: SnippetScope
}

export interface SnippetQuery {
  /** Restrict to these kinds. Omitted means every kind. */
  kinds?: SnippetKind[]
  scope?: SnippetScope
  /** Case-insensitive match against name, description, tags and body text. */
  search?: string
}

// ── Insertion surfaces ───────────────────────────────────────────────────────

/**
 * A place a snippet can be inserted. A surface registers one of these when it
 * mounts and withdraws it when it unmounts, so the picker offers exactly the
 * targets that are really on screen and able to accept something right now.
 *
 * `accepts` is the honest list of kinds this surface can take. A target that
 * cannot do live instances says so, and the picker then offers only Duplicate
 * rather than showing a choice that would silently degrade.
 */
export interface SnippetTarget {
  /** Stable id for the surface instance, e.g. `doc:<documentId>`. */
  id: string
  /** What the user calls this place: "This document", "Marketing desk". */
  label: string
  accepts: SnippetKind[]
  /** Link modes this surface genuinely supports. Must be non-empty. */
  supports: SnippetLink[]
  /**
   * Insert the snippet. Resolves false when the surface declined — a sheet with
   * no selection, a document that is read-only — so the caller can say why
   * instead of reporting a success that did not happen.
   */
  insert: (snippet: Snippet, link: SnippetLink) => Promise<boolean> | boolean
}

/** Which link modes are possible for this snippet in this target. */
export function linkModesFor(target: SnippetTarget, kind: SnippetKind): SnippetLink[] {
  if (!target.accepts.includes(kind)) return []
  return target.supports
}

/** Can this target take this snippet at all? */
export function targetAccepts(target: SnippetTarget, snippet: Snippet): boolean {
  return linkModesFor(target, snippet.kind).length > 0
}

// ── Pure helpers, shared by main and renderer ────────────────────────────────

/**
 * Whether an org-scoped snippet actually reaches teammates yet.
 *
 * It does NOT, as of 4.3.41, and the UI must say so rather than imply sharing.
 * Workspace sync carries a closed set of item types — the client's union in
 * main/db/workspaceSync.ts and, decisively, the SERVER's WORKSPACE_ITEM_TYPES
 * whitelist, which rejects anything else with "Invalid itemType". `snippet` is
 * not in it, so an org snippet saved here stays on this computer until that
 * list grows, which needs a server change and a deploy.
 *
 * Marking a snippet as organisation-wide is still worth doing: it records the
 * user's intent, it is what the org library filters on, and it is what will
 * travel unchanged once sync carries snippets. What must not happen is the UI
 * claiming teammates can see it. Flip this to true in the same change that
 * adds 'snippet' to both whitelists.
 *
 * The precedent is in the server's own comment next to that list: a sync that
 * accepted only what it knew "had faithfully carried everything it was willing
 * to accept" while reporting success throughout, and an image arrived as a
 * blank widget. Silent partial sync reads as success, which is why this is a
 * constant and not a comment.
 */
export const ORG_SNIPPETS_SYNC = false

/** What to tell the user about an org snippet's reach, given the above. */
export const ORG_SNIPPET_REACH_NOTE = ORG_SNIPPETS_SYNC
  ? 'Everyone in this organisation can use it.'
  : 'Saved on this computer. Sharing with your organisation arrives with sync.'

export const SNIPPET_KINDS: SnippetKind[] = ['doc', 'widget', 'sheet', 'slide', 'design', 'diagram', 'draw']

const KIND_LABEL: Record<SnippetKind, string> = {
  doc: 'Document block',
  widget: 'Work widget',
  sheet: 'Cells block',
  slide: 'Slide elements',
  design: 'Design elements',
  diagram: 'Diagram fragment',
  draw: 'Drawing'
}

export function snippetKindLabel(kind: SnippetKind): string {
  return KIND_LABEL[kind] ?? kind
}

const KIND_ICON: Record<SnippetKind, string> = {
  doc: 'notes',
  widget: 'widgets',
  sheet: 'table_chart',
  slide: 'slideshow',
  design: 'palette',
  diagram: 'account_tree',
  draw: 'draw'
}

export function snippetKindIcon(kind: SnippetKind): string {
  return KIND_ICON[kind] ?? 'bookmark'
}

export function isSnippetKind(v: unknown): v is SnippetKind {
  return typeof v === 'string' && (SNIPPET_KINDS as string[]).includes(v)
}

export function isSnippetLink(v: unknown): v is SnippetLink {
  return v === 'duplicate' || v === 'live'
}

export function isSnippetScope(v: unknown): v is SnippetScope {
  return v === 'personal' || v === 'org'
}

/**
 * The text a snippet is searched by. Body text is included so "the one with the
 * payment terms in it" finds the right snippet without the user having tagged
 * it that way.
 */
export function snippetSearchText(s: Snippet): string {
  const body = s.body.kind === 'doc' ? s.body.text : ''
  return [s.name, s.description, s.tags.join(' '), body].join(' ').toLowerCase()
}

/** Does this snippet match the query? Pure, so the same rule runs either side. */
export function snippetMatches(s: Snippet, q: SnippetQuery): boolean {
  if (q.kinds?.length && !q.kinds.includes(s.kind)) return false
  if (q.scope && s.scope !== q.scope) return false
  const needle = q.search?.trim().toLowerCase()
  if (needle && !snippetSearchText(s).includes(needle)) return false
  return true
}

/**
 * A short, honest preview line for the library. It describes what is actually
 * in the body rather than guessing — an empty snippet says it is empty instead
 * of showing a plausible-looking summary.
 */
export function snippetSummary(s: Snippet): string {
  const b = s.body
  switch (b.kind) {
    case 'doc': {
      const text = b.text.trim().replace(/\s+/g, ' ')
      if (!text) return b.content.length ? `${b.content.length} block(s), no text` : 'Empty'
      return text.length > 120 ? `${text.slice(0, 117)}…` : text
    }
    case 'widget':
      return `${b.title || 'Untitled widget'} · ${b.widgetKind}`
    case 'sheet': {
      const rows = b.rows.length
      const cols = rows ? Math.max(...b.rows.map((r) => r.length)) : 0
      return rows ? `${rows} × ${cols} cells` : 'Empty'
    }
    case 'slide':
      return b.elements.length ? `${b.elements.length} element(s)` : 'Empty'
    case 'design':
      return b.elements.length ? `${b.elements.length} element(s)` : 'Empty'
    case 'diagram': {
      if (!b.nodes.length && !b.edges.length) return 'Empty'
      return `${b.nodes.length} shape(s), ${b.edges.length} connector(s)`
    }
    case 'draw':
      return b.objects.length ? `${b.objects.length} object(s)` : 'Empty'
  }
}

/**
 * Is there anything in this body worth saving? Guards the save path so the
 * library never fills with empty entries the user cannot tell apart.
 */
export function snippetBodyIsEmpty(b: SnippetBody): boolean {
  switch (b.kind) {
    case 'doc':
      return b.content.length === 0
    case 'widget':
      return !b.widgetKind
    case 'sheet':
      return b.rows.length === 0 || b.rows.every((r) => r.every((c) => !c.trim()))
    case 'slide':
    case 'design':
      return b.elements.length === 0
    case 'diagram':
      return b.nodes.length === 0 && b.edges.length === 0
    case 'draw':
      return b.objects.length === 0
  }
}

/** Does the body's own discriminator agree with the snippet's kind? */
export function snippetBodyMatchesKind(kind: SnippetKind, b: SnippetBody): boolean {
  return b.kind === kind
}
