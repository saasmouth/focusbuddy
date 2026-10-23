// Where a thing dragged out of Files can go, AS DATA (pure).
//
// This is the placement half of the plan's drop matrix (§4.2): the desk
// canvas, the Workcentre, a Files folder (the panel, the full view, a
// breadcrumb) and a Drive work widget. Every cell is a row of PLACEMENT below,
// and tests/unit/filesDropPlan.test.ts walks every one of them, so the matrix
// and the code cannot drift apart.
//
// Content targets (the six office apps and the text work widgets, Phase 3)
// slot in beside these as further targets whose route is `forms`: the ref is
// read into 2e's FormsRead and handed to the target's own paste or dropForms.
//
// The two owner rulings that ASK rather than decide live here too, so the
// dialogs only render what this module says:
//   Q2  a Personal-drive file onto a shared desk: Share (view / edit), Give
//       them a copy, or Cancel, with each option honestly enabled or not;
//   Q3  several pictures onto a desk at once: individual pictures, or one
//       gallery work widget.

import type { WidgetKind } from './types'
import { exceedsSyncLimit, syncLimitLabel } from './fileSyncLimits'
import { sourceKindOf, type FileDragRef, type FileSourceKind } from './filesDragPayload'

export type PlacementTarget = 'desk' | 'workcentre' | 'folder' | 'drive'

export type PlacementRoute =
  /** A `file` work widget whose content is the SAME fb_files id. Never re-ingested. */
  | 'file-widget'
  /** An office work widget pointing at the same document. */
  | 'office-widget'
  /** A linked instance of the same work widget file. */
  | 'linked-instance'
  /** A Drive work widget bound to the folder. */
  | 'drive-widget'
  /** Moved into the folder (shared Files operation, one undo). */
  | 'move'
  /** Already there: nothing to do, nothing to say. */
  | 'noop'
  | 'refuse'

export interface PlacementPlan {
  route: PlacementRoute
  /** The work widget kind a desk route creates. */
  widgetKind?: WidgetKind
  /** Workcentre only: the new widget also gets a tile at the drop cell. */
  tile?: boolean
  /** Refusal reason, shown verbatim. */
  notice?: string
  /** Lines to show AFTER placing (the place still happens). */
  warnings: string[]
}

export interface PlacementContext {
  /** ⌥ held at drop. */
  alt?: boolean
  /** Folder targets: the folder dropped into (null = the Files root). */
  folderId?: string | null
  /** Folder targets: that folder and every ancestor of it, nearest first. */
  folderAncestry?: Array<string | null>
  /** Folder targets: where the dragged entry sits now (null = root), when known. */
  currentParentId?: string | null
}

export const REASON_FOLDER_INTO_ITSELF = 'A folder cannot go inside itself.'
export const REASON_NOT_PLACEABLE = 'This kind of document cannot be placed on a desk.'
export function syncWarning(): string {
  return `This file is over ${syncLimitLabel()}, so it stays on this device. Your other devices will show it as unavailable.`
}

/** The cells of §4.2 for one source kind on the desk (the Workcentre adds a tile). */
const DESK_ROUTE: Record<FileSourceKind, { route: PlacementRoute; widgetKind?: WidgetKind }> = {
  image: { route: 'file-widget', widgetKind: 'file' },
  svg: { route: 'file-widget', widgetKind: 'file' },
  pdf: { route: 'file-widget', widgetKind: 'file' },
  'office-doc': { route: 'office-widget' },
  widget: { route: 'linked-instance' },
  video: { route: 'file-widget', widgetKind: 'file' },
  audio: { route: 'file-widget', widgetKind: 'file' },
  text: { route: 'file-widget', widgetKind: 'file' },
  generic: { route: 'file-widget', widgetKind: 'file' },
  folder: { route: 'drive-widget', widgetKind: 'drive' }
}

/** The PLACEMENT matrix as data: target → source kind → route. Exported for the table-driven test. */
export const PLACEMENT: Record<PlacementTarget, Record<FileSourceKind, PlacementRoute>> = {
  desk: Object.fromEntries(Object.entries(DESK_ROUTE).map(([k, v]) => [k, v.route])) as Record<FileSourceKind, PlacementRoute>,
  workcentre: Object.fromEntries(Object.entries(DESK_ROUTE).map(([k, v]) => [k, v.route])) as Record<FileSourceKind, PlacementRoute>,
  folder: Object.fromEntries(Object.keys(DESK_ROUTE).map((k) => [k, 'move'])) as Record<FileSourceKind, PlacementRoute>,
  drive: Object.fromEntries(Object.keys(DESK_ROUTE).map((k) => [k, 'move'])) as Record<FileSourceKind, PlacementRoute>
}

const PLACEABLE_DOC = new Set(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])

export function planFilesPlacement(ref: FileDragRef, target: PlacementTarget, ctx: PlacementContext = {}): PlacementPlan {
  const kind = sourceKindOf(ref)
  const warnings: string[] = []
  if (target === 'folder' || target === 'drive') {
    const dest = ctx.folderId ?? null
    if (kind === 'folder') {
      const chain = ctx.folderAncestry ?? [dest]
      if (dest === ref.entryId || chain.includes(ref.entryId)) {
        return { route: 'refuse', notice: REASON_FOLDER_INTO_ITSELF, warnings }
      }
    }
    if (ctx.currentParentId !== undefined && ctx.currentParentId === dest) return { route: 'noop', warnings }
    return { route: 'move', warnings }
  }
  // desk / workcentre
  const cell = DESK_ROUTE[kind]
  if (kind === 'office-doc' && !(ref.docType && PLACEABLE_DOC.has(ref.docType))) {
    return { route: 'refuse', notice: REASON_NOT_PLACEABLE, warnings }
  }
  if ((kind === 'office-doc' || kind === 'widget') && !ref.docId) {
    return { route: 'refuse', notice: REASON_NOT_PLACEABLE, warnings }
  }
  if (ref.kind === 'file' && exceedsSyncLimit(ref.sizeBytes)) warnings.push(syncWarning())
  return {
    route: cell.route,
    widgetKind: kind === 'office-doc' ? (ref.docType as WidgetKind) : cell.widgetKind,
    tile: target === 'workcentre' ? true : undefined,
    warnings
  }
}

/**
 * The one-line hint shown while over a placement target. ⌥ (insert a copy of
 * a text file's content as the work widget that holds it) needs the any-to-any
 * desk acceptors, which are not merged yet, so the hint says so rather than
 * offering a key that does nothing.
 */
export function placementHint(kinds: FileSourceKind[], target: PlacementTarget): string {
  if (target === 'folder' || target === 'drive') return 'Drop to move here'
  if (kinds.length === 1 && kinds[0] === 'folder') return 'Drop to place a Drive work widget for this folder'
  return target === 'workcentre' ? 'Drop to place it here as a tile' : 'Drop to place it on this desk'
}

// ── Q2: a Personal-drive file onto a shared desk ─────────────────────────────

export const PERSONAL_ORG = 'personal'

export interface DeskSharing {
  /** The org the desk lives in (the active org while it is on screen). */
  deskOrgId: string
  /** A live-shared desk (shared by you, or shared with you). */
  liveShared: boolean
}

/** True when other people can see this desk. */
export function deskIsShared(d: DeskSharing): boolean {
  return d.liveShared || d.deskOrgId !== PERSONAL_ORG
}

/** The refs whose files the people on a shared desk could not open. */
export function personalRefsForSharedDesk(refs: FileDragRef[], d: DeskSharing): FileDragRef[] {
  if (!deskIsShared(d)) return []
  return refs.filter((r) => (r.kind === 'file' || r.kind === 'folder') && (r.orgId ?? PERSONAL_ORG) === PERSONAL_ORG)
}

/**
 * Whether the server can share ONE Personal-drive file into another workspace
 * with view or edit access, leaving it in Personal. Not today:
 *  - every fb_files row belongs to exactly one org (src/main/db/files.ts
 *    insertFileRow); the only "share with team" re-scopes the row OUT of
 *    Personal (moveFileToOrg), with no view/edit choice;
 *  - a live-shared desk carries nodes, widgets and tables only, never files
 *    (workspaceSync SHARED_COL_TABLES);
 *  - the server's resource ACL (acls.ts, view/comment/edit/manage) is applied
 *    to live documents and desks, never to files.
 * Flip this only when a real per-file share endpoint exists.
 */
export const SINGLE_FILE_SHARE_AVAILABLE = false

export interface ChoiceOption {
  enabled: boolean
  /** Why it is disabled (shown under the option). */
  reason?: string
}

export interface ShareChoice {
  title: string
  body: string
  share: ChoiceOption
  copy: ChoiceOption
  /** Place the reference anyway: only you can open it. Always available. */
  placeAnyway: ChoiceOption
}

export const SHARE_UNAVAILABLE = "Sharing a file from your Personal drive isn't available yet."
export const COPY_INSTEAD = 'You can give them a copy.'
export const COPY_LIVE_SHARED =
  "A live-shared desk doesn't carry files yet, so a copy would only be on this device."
export const COPY_FOLDER = 'A folder cannot be copied this way yet.'

export function shareChoiceFor(personal: FileDragRef[], d: DeskSharing): ShareChoice | null {
  if (!personal.length || !deskIsShared(d)) return null
  const copyBlocked = d.liveShared ? COPY_LIVE_SHARED : personal.some((r) => r.kind === 'folder') ? COPY_FOLDER : null
  const copy: ChoiceOption = copyBlocked ? { enabled: false, reason: copyBlocked } : { enabled: true }
  const share: ChoiceOption = SINGLE_FILE_SHARE_AVAILABLE
    ? { enabled: true }
    : { enabled: false, reason: copy.enabled ? `${SHARE_UNAVAILABLE} ${COPY_INSTEAD}` : SHARE_UNAVAILABLE }
  const what = personal.length === 1 ? `“${personal[0]!.name}” is` : `${personal.length} of these are`
  return {
    title: personal.length === 1 ? 'Share this file with the desk?' : 'Share these files with the desk?',
    body: `${what} in your Personal drive, so people on this shared desk cannot open ${personal.length === 1 ? 'it' : 'them'}.`,
    share,
    copy,
    placeAnyway: { enabled: true }
  }
}

export type ShareDecision =
  | { kind: 'share'; access: 'view' | 'edit' }
  | { kind: 'copy' }
  | { kind: 'place' }
  | { kind: 'cancel' }

/** A decision the dialog may return, checked against what was offered (a disabled option never runs). */
export function acceptShareDecision(choice: ShareChoice, decision: ShareDecision): ShareDecision {
  if (decision.kind === 'share' && !choice.share.enabled) return { kind: 'cancel' }
  if (decision.kind === 'copy' && !choice.copy.enabled) return { kind: 'cancel' }
  return decision
}

// ── Q3: several pictures at once ─────────────────────────────────────────────

export function isPicture(ref: FileDragRef): boolean {
  const k = sourceKindOf(ref)
  return k === 'image' || k === 'svg'
}

/** Ask "individual pictures or one gallery?" only when two or more pictures land together on a desk. */
export function galleryChoiceNeeded(refs: FileDragRef[], target: PlacementTarget): boolean {
  if (target !== 'desk' && target !== 'workcentre') return false
  return refs.filter(isPicture).length >= 2
}

export type GalleryDecision = 'individual' | 'gallery' | 'cancel'

/** Split a drop by the Q3 answer: the pictures for one gallery, and everything placed one by one. */
export function splitForGallery(refs: FileDragRef[], decision: GalleryDecision): { gallery: FileDragRef[]; each: FileDragRef[] } {
  if (decision === 'cancel') return { gallery: [], each: [] }
  if (decision === 'individual') return { gallery: [], each: refs }
  return { gallery: refs.filter(isPicture), each: refs.filter((r) => !isPicture(r)) }
}

/** The gallery work widget's content: the SAME fb_files ids, never copies. */
export function galleryContent(refs: FileDragRef[]): string {
  return JSON.stringify({ fileIds: refs.map((r) => r.entryId) })
}
