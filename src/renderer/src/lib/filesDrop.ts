// Dropping things from Files onto a desk, the Workcentre, a folder or a Drive
// work widget. The decisions are @shared/filesDropPlan's (pure, tested cell by
// cell); this module carries them out against the stores and says what
// happened in ONE notice line per drop.
//
// Desk drops place REFERENCES: a `file` work widget whose content is the same
// fb_files id (never re-ingested), an office work widget on the same document,
// a linked instance of the same work widget file, a Drive work widget bound to
// the folder, or a gallery work widget holding the same picture ids. One drop
// is one undo step, however many things it placed.

import type { Widget, WidgetKind } from '@shared/types'
import type { FileDragRef } from '@shared/filesDragPayload'
import {
  acceptShareDecision,
  galleryChoiceNeeded,
  galleryContent,
  isPicture,
  personalRefsForSharedDesk,
  planFilesPlacement,
  shareChoiceFor,
  splitForGallery,
  type DeskSharing,
  type GalleryDecision,
  type PlacementTarget,
  type ShareChoice,
  type ShareDecision
} from '@shared/filesDropPlan'
import { catalogFor } from './widgetCatalog'
import { ensureCanAdd } from './addWidget'
import { promptChoice } from '../components/plexi/PromptDialog'
import { useWidgetStore } from '../stores/widgets'
import { useWidgetFilesStore } from '../stores/widgetFiles'
import { useActionHistory } from '../stores/actionHistory'
import { useNoticeStore } from '../stores/notice'
import { useNodeStore } from '../stores/nodes'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import { useFileManagerStore } from '../stores/fileManager'
import { nudgeSync } from './syncNudge'

/** Cascade for several things placed by one drop (as the Finder drop does). */
export const CASCADE_PX = 24

export interface DeskDropOptions {
  taskId: string
  /** Canvas coordinates of the drop point. */
  at: { x: number; y: number }
  target?: Extract<PlacementTarget, 'desk' | 'workcentre'>
  /** ⌥ at drop. */
  alt?: boolean
}

export interface DeskDropResult {
  /** The widgets this drop created, in order. */
  created: Widget[]
  /** The line shown to the person (null when nothing needed saying). */
  notice: string | null
  cancelled: boolean
}

/** The desk's sharing, as the drop sees it. */
export function deskSharingFor(taskId: string): DeskSharing {
  const node = useNodeStore.getState().nodes.find((n) => n.id === taskId) as
    | { sharedRootId?: string | null; sharedFromHandle?: string | null }
    | undefined
  return {
    deskOrgId: useOrgStore.getState().activeOrgId ?? PERSONAL_ORG_ID,
    liveShared: !!(node?.sharedRootId || node?.sharedFromHandle)
  }
}

// ── The two questions (owner rulings Q2 and Q3) ──────────────────────────────

/** Q2. Resolves to the person's decision; a disabled option can never come back. */
export async function askShareChoice(choice: ShareChoice): Promise<ShareDecision> {
  const value = await promptChoice({
    title: choice.title,
    body: choice.body,
    choices: [
      {
        label: 'Share: they can view it',
        value: 'share-view',
        disabled: !choice.share.enabled,
        hint: choice.share.enabled ? 'It stays in your Personal drive.' : choice.share.reason
      },
      {
        label: 'Share: they can edit it',
        value: 'share-edit',
        disabled: !choice.share.enabled,
        hint: choice.share.enabled ? 'It stays in your Personal drive.' : choice.share.reason
      },
      {
        label: 'Give them a copy',
        value: 'copy',
        disabled: !choice.copy.enabled,
        hint: choice.copy.enabled ? "A copy goes into this desk's workspace drive and is placed here." : choice.copy.reason
      },
      {
        label: 'Place it for me only',
        value: 'place',
        hint: 'Only you will be able to open it.'
      }
    ]
  })
  const decision: ShareDecision =
    value === 'share-view'
      ? { kind: 'share', access: 'view' }
      : value === 'share-edit'
        ? { kind: 'share', access: 'edit' }
        : value === 'copy'
          ? { kind: 'copy' }
          : value === 'place'
            ? { kind: 'place' }
            : { kind: 'cancel' }
  return acceptShareDecision(choice, decision)
}

/** Q3. Several pictures at once: individual pictures, or one gallery work widget. */
export async function askGalleryChoice(count: number): Promise<GalleryDecision> {
  const value = await promptChoice({
    title: `Add ${count} pictures`,
    body: 'Place them as separate pictures, or together as one gallery?',
    choices: [
      { label: 'Individual images', value: 'individual', hint: `${count} picture work widgets, one for each.` },
      { label: 'One gallery', value: 'gallery', hint: 'One gallery work widget holding all of them.' }
    ]
  })
  return value === 'individual' || value === 'gallery' ? value : 'cancel'
}

/**
 * "Give them a copy": the bytes, read now, ingested into the workspace that is
 * active (the desk's own: desks on screen are always the active workspace's).
 * Returns the copy's ref, or null when the bytes are not on this device.
 */
export async function copyIntoDeskWorkspace(ref: FileDragRef): Promise<FileDragRef | null> {
  const read = await window.api.files.read(ref.entryId).catch(() => null)
  if (!read) return null
  const created = await window.api.files.ingestBuffer({
    buffer: read.buffer as ArrayBuffer,
    originalName: ref.name,
    mimeType: read.mimeType || ref.mimeType || 'application/octet-stream',
    parentId: null
  })
  nudgeSync()
  return {
    ...ref,
    entryId: created.id,
    mimeType: created.mimeType ?? ref.mimeType,
    sizeBytes: created.sizeBytes ?? ref.sizeBytes,
    orgId: useOrgStore.getState().activeOrgId ?? undefined
  }
}

// ── Placing ───────────────────────────────────────────────────────────────────

/** Compose the one line a drop says: what landed, then what could not, then warnings. */
export function composeDropNotice(placed: number, refused: Array<{ name: string; reason: string }>, warnings: string[]): string | null {
  const parts: string[] = []
  if (refused.length) {
    const reasons = Array.from(new Set(refused.map((r) => r.reason)))
    if (placed > 0) parts.push(`${placed} added. ${refused.length} could not go in: ${reasons.join(' ')}`)
    else parts.push(reasons.join(' '))
  }
  for (const w of Array.from(new Set(warnings))) parts.push(w)
  return parts.length ? parts.join(' ') : null
}

async function placeOne(
  ref: FileDragRef,
  opts: DeskDropOptions,
  at: { x: number; y: number }
): Promise<{ widget: Widget | null; refused?: string; warnings: string[] }> {
  const plan = planFilesPlacement(ref, opts.target ?? 'desk', { alt: opts.alt })
  if (plan.route === 'refuse') return { widget: null, refused: plan.notice, warnings: [] }
  const create = useWidgetStore.getState().create
  const sizeOf = (kind: WidgetKind, fw: number, fh: number): { width: number; height: number } => {
    const e = catalogFor(kind)
    return { width: e?.defaultWidth ?? fw, height: e?.defaultHeight ?? fh }
  }
  const origin = (w: number): { x: number; y: number } => ({ x: Math.round(at.x - w / 2), y: Math.round(at.y - 20) })
  switch (plan.route) {
    case 'file-widget': {
      const s = sizeOf('file', 360, 280)
      const w = await create({ taskId: opts.taskId, kind: 'file', title: ref.name, content: ref.entryId, ...origin(s.width), ...s, color: null })
      return { widget: w, warnings: plan.warnings }
    }
    case 'drive-widget': {
      if (!ensureCanAdd('drive')) return { widget: null, warnings: [] }
      const s = sizeOf('drive', 300, 260)
      const w = await create({ taskId: opts.taskId, kind: 'drive', title: ref.name, content: ref.entryId, ...origin(s.width), ...s, color: null })
      return { widget: w, warnings: plan.warnings }
    }
    case 'office-widget': {
      const kind = plan.widgetKind as WidgetKind
      if (!ensureCanAdd(kind)) return { widget: null, warnings: [] }
      const s = sizeOf(kind, 520, 400)
      const w = await create({ taskId: opts.taskId, kind, title: ref.name, content: ref.docId!, ...origin(s.width), ...s, color: null })
      return { widget: w, warnings: plan.warnings }
    }
    case 'linked-instance': {
      const store = useWidgetFilesStore.getState()
      const file = await store.load(ref.docId!)
      if (!file) return { widget: null, refused: 'That work widget file no longer exists.', warnings: [] }
      const entry = catalogFor(file.kind)
      const w = await store.place(ref.docId!, opts.taskId, origin(entry?.defaultWidth ?? 320))
      if (w) {
        // place() is not on the desk's undo stack by itself; this drop's batch is.
        useActionHistory.getState().record({
          label: 'Place a work widget',
          undo: async () => {
            await window.api.widgets.delete(w.id)
            useWidgetStore.setState({ widgets: useWidgetStore.getState().widgets.filter((x) => x.id !== w.id) })
          },
          redo: async () => {
            await useWidgetFilesStore.getState().place(ref.docId!, opts.taskId, { x: w.x, y: w.y })
          }
        })
      }
      return { widget: w, warnings: plan.warnings }
    }
    default:
      return { widget: null, warnings: [] }
  }
}

export async function placeGallery(refs: FileDragRef[], opts: DeskDropOptions, at: { x: number; y: number }): Promise<Widget | null> {
  if (!ensureCanAdd('gallery')) return null
  const e = catalogFor('gallery')
  const width = e?.defaultWidth ?? 460
  const height = e?.defaultHeight ?? 340
  return useWidgetStore.getState().create({
    taskId: opts.taskId,
    kind: 'gallery',
    title: `${refs.length} pictures`,
    content: galleryContent(refs),
    x: Math.round(at.x - width / 2),
    y: Math.round(at.y - 20),
    width,
    height,
    color: null
  })
}

/**
 * Place a Files drag on a desk (canvas or Workcentre). Asks the Q3 question
 * when several pictures land together and the Q2 question when Personal-drive
 * files land on a shared desk, then places everything as ONE undo step.
 */
export async function placeFilesOnDesk(refs: FileDragRef[], opts: DeskDropOptions): Promise<DeskDropResult> {
  if (!refs.length) return { created: [], notice: null, cancelled: false }
  const target = opts.target ?? 'desk'

  // Q2 first: it can turn refs into copies.
  let working = refs
  const sharing = deskSharingFor(opts.taskId)
  const personal = personalRefsForSharedDesk(working, sharing)
  const choice = shareChoiceFor(personal, sharing)
  if (choice) {
    const decision = await askShareChoice(choice)
    if (decision.kind === 'cancel') return { created: [], notice: null, cancelled: true }
    if (decision.kind === 'copy') {
      const copies = new Map<string, FileDragRef | null>()
      for (const r of personal) copies.set(r.entryId, await copyIntoDeskWorkspace(r))
      const missing = [...copies.values()].filter((c) => !c).length
      working = working
        .map((r) => (copies.has(r.entryId) ? copies.get(r.entryId) ?? null : r))
        .filter((r): r is FileDragRef => !!r)
      void useFileManagerStore.getState().refresh()
      if (missing) {
        useNoticeStore.getState().show({
          text: "This file's contents are not on this device yet, so it could not be copied.",
          icon: 'error'
        })
        if (!working.length) return { created: [], notice: null, cancelled: false }
      }
    }
    // 'share' never comes back while SINGLE_FILE_SHARE_AVAILABLE is false
    // (acceptShareDecision); 'place' places the references as they are.
  }

  // Q3: several pictures at once.
  let gallery: FileDragRef[] = []
  let each = working
  if (galleryChoiceNeeded(working, target)) {
    const decision = await askGalleryChoice(working.filter(isPicture).length)
    if (decision === 'cancel') return { created: [], notice: null, cancelled: true }
    ;({ gallery, each } = splitForGallery(working, decision))
  }

  const created: Widget[] = []
  const refused: Array<{ name: string; reason: string }> = []
  const warnings: string[] = []
  const hist = useActionHistory.getState()
  hist.beginBatch()
  let offset = 0
  try {
    if (gallery.length) {
      const g = await placeGallery(gallery, opts, { x: opts.at.x + offset, y: opts.at.y + offset })
      if (g) created.push(g)
      offset += CASCADE_PX
    }
    for (const ref of each) {
      const r = await placeOne(ref, opts, { x: opts.at.x + offset, y: opts.at.y + offset })
      if (r.refused) refused.push({ name: ref.name, reason: r.refused })
      warnings.push(...r.warnings)
      if (r.widget) {
        created.push(r.widget)
        offset += CASCADE_PX
      }
    }
  } finally {
    const n = created.length
    hist.endBatch(n === 1 ? 'Add from Files' : `Add ${n} items from Files`)
  }
  const notice = composeDropNotice(created.length, refused, warnings)
  if (notice) useNoticeStore.getState().show({ text: notice, icon: refused.length ? 'info' : 'cloud_off' })
  return { created, notice, cancelled: false }
}

// ── Folders (Files folders and Drive work widgets) ───────────────────────────

/** Ancestry of a folder, nearest first, ending with the root (null). */
export async function folderAncestry(folderId: string | null): Promise<Array<string | null>> {
  if (folderId === null) return [null]
  const path = await window.api.fileManager.path(folderId).catch(() => [] as Array<{ id: string; name: string }>)
  return [...path.map((p) => p.id).reverse(), null]
}

/**
 * Move a Files drag into a folder (one undo step). Refusals (a folder into
 * itself or a descendant) are said in one line; items already there are left.
 */
export async function moveFilesInto(refs: FileDragRef[], folderId: string | null): Promise<{ moved: number; notice: string | null }> {
  const ancestry = await folderAncestry(folderId)
  const ids: string[] = []
  const refused: Array<{ name: string; reason: string }> = []
  for (const ref of refs) {
    const plan = planFilesPlacement(ref, 'folder', { folderId, folderAncestry: ancestry })
    if (plan.route === 'move') ids.push(ref.entryId)
    else if (plan.route === 'refuse') refused.push({ name: ref.name, reason: plan.notice ?? '' })
  }
  const moved = ids.length ? await useFileManagerStore.getState().moveMany(ids, folderId) : 0
  const notice = composeDropNotice(moved, refused, [])
  if (notice) useNoticeStore.getState().show({ text: notice, icon: 'info' })
  return { moved, notice }
}
