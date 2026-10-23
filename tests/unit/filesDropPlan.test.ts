import { describe, it, expect } from 'vitest'
import {
  PLACEMENT,
  REASON_FOLDER_INTO_ITSELF,
  REASON_NOT_PLACEABLE,
  SHARE_UNAVAILABLE,
  COPY_INSTEAD,
  COPY_LIVE_SHARED,
  COPY_FOLDER,
  SINGLE_FILE_SHARE_AVAILABLE,
  acceptShareDecision,
  deskIsShared,
  galleryChoiceNeeded,
  galleryContent,
  personalRefsForSharedDesk,
  planFilesPlacement,
  placementHint,
  shareChoiceFor,
  splitForGallery,
  syncWarning,
  type PlacementTarget
} from '../../src/shared/filesDropPlan'
import { sourceKindOf, type FileDragRef, type FileSourceKind } from '../../src/shared/filesDragPayload'

// One representative ref per source kind of the plan's §4.2 rows.
const SAMPLE: Record<FileSourceKind, FileDragRef> = {
  image: { entryId: 'img', kind: 'file', name: 'photo.jpg', mimeType: 'image/jpeg', ext: 'jpg', sizeBytes: 2000 },
  svg: { entryId: 'svg', kind: 'file', name: 'logo.svg', mimeType: 'image/svg+xml', ext: 'svg', sizeBytes: 900 },
  pdf: { entryId: 'pdf', kind: 'file', name: 'brief.pdf', mimeType: 'application/pdf', ext: 'pdf', sizeBytes: 9000 },
  'office-doc': { entryId: 'e-doc', kind: 'doc', name: 'Plan', docId: 'doc-1', docType: 'sheet' },
  widget: { entryId: 'e-wf', kind: 'doc', name: 'Budget', docId: 'wf-1', docType: 'widget', widgetKind: 'table' },
  video: { entryId: 'vid', kind: 'file', name: 'demo.mp4', mimeType: 'video/mp4', ext: 'mp4', sizeBytes: 9000 },
  audio: { entryId: 'aud', kind: 'file', name: 'memo.m4a', mimeType: 'audio/mp4', ext: 'm4a', sizeBytes: 9000 },
  text: { entryId: 'csv', kind: 'file', name: 'rows.csv', mimeType: 'text/csv', ext: 'csv', sizeBytes: 20 },
  generic: { entryId: 'zip', kind: 'file', name: 'bundle.zip', mimeType: 'application/zip', ext: 'zip', sizeBytes: 9000 },
  folder: { entryId: 'dir', kind: 'folder', name: 'Plans' }
}

// The §4.2 table, written out by hand: the test is the spec, the module is the code.
const EXPECTED: Record<PlacementTarget, Record<FileSourceKind, { route: string; widgetKind?: string }>> = {
  desk: {
    image: { route: 'file-widget', widgetKind: 'file' },
    svg: { route: 'file-widget', widgetKind: 'file' },
    pdf: { route: 'file-widget', widgetKind: 'file' },
    'office-doc': { route: 'office-widget', widgetKind: 'sheet' },
    widget: { route: 'linked-instance' },
    video: { route: 'file-widget', widgetKind: 'file' },
    audio: { route: 'file-widget', widgetKind: 'file' },
    text: { route: 'file-widget', widgetKind: 'file' },
    generic: { route: 'file-widget', widgetKind: 'file' },
    folder: { route: 'drive-widget', widgetKind: 'drive' }
  },
  workcentre: {} as never,
  folder: {} as never,
  drive: {} as never
}
EXPECTED.workcentre = EXPECTED.desk
EXPECTED.folder = Object.fromEntries(Object.keys(SAMPLE).map((k) => [k, { route: 'move' }])) as never
EXPECTED.drive = EXPECTED.folder

describe('§4.2 placement matrix, cell by cell', () => {
  for (const target of ['desk', 'workcentre', 'folder', 'drive'] as const) {
    for (const kind of Object.keys(SAMPLE) as FileSourceKind[]) {
      it(`${kind} → ${target}`, () => {
        const ref = SAMPLE[kind]
        expect(sourceKindOf(ref)).toBe(kind)
        const plan = planFilesPlacement(ref, target, { folderId: 'elsewhere', folderAncestry: ['elsewhere', null] })
        expect(plan.route).toBe(EXPECTED[target][kind].route)
        expect(PLACEMENT[target][kind]).toBe(EXPECTED[target][kind].route)
        if (EXPECTED[target][kind].widgetKind) expect(plan.widgetKind).toBe(EXPECTED[target][kind].widgetKind)
        // The Workcentre adds a tile at the drop cell; nothing else does.
        expect(!!plan.tile).toBe(target === 'workcentre')
        expect(plan.warnings).toEqual([])
      })
    }
  }

  it('every desk and Workcentre route is a REFERENCE (never a copy, never re-ingested)', () => {
    for (const t of ['desk', 'workcentre'] as const)
      for (const r of Object.values(PLACEMENT[t])) expect(['file-widget', 'office-widget', 'linked-instance', 'drive-widget']).toContain(r)
  })
})

describe('refusals and warnings', () => {
  it('a folder cannot go inside itself or a descendant', () => {
    const f = SAMPLE.folder
    expect(planFilesPlacement(f, 'folder', { folderId: 'dir', folderAncestry: ['dir', null] })).toMatchObject({ route: 'refuse', notice: REASON_FOLDER_INTO_ITSELF })
    expect(planFilesPlacement(f, 'drive', { folderId: 'child', folderAncestry: ['child', 'dir', null] })).toMatchObject({ route: 'refuse', notice: REASON_FOLDER_INTO_ITSELF })
    expect(planFilesPlacement(f, 'folder', { folderId: 'sibling', folderAncestry: ['sibling', null] }).route).toBe('move')
  })
  it('already in that folder: nothing to do', () => {
    expect(planFilesPlacement(SAMPLE.image, 'folder', { folderId: 'a', currentParentId: 'a' }).route).toBe('noop')
  })
  it('over 50 MB places, then warns', () => {
    const big = { ...SAMPLE.video, sizeBytes: 51 * 1024 * 1024 }
    const plan = planFilesPlacement(big, 'desk')
    expect(plan.route).toBe('file-widget')
    expect(plan.warnings).toEqual([syncWarning()])
    expect(syncWarning()).toBe('This file is over 50 MB, so it stays on this device. Your other devices will show it as unavailable.')
    expect(planFilesPlacement({ ...big, sizeBytes: 50 * 1024 * 1024 }, 'desk').warnings).toEqual([])
  })
  it('a document type the desk cannot hold, or a pointer with no document, is refused plainly', () => {
    expect(planFilesPlacement({ ...SAMPLE['office-doc'], docType: undefined }, 'desk')).toMatchObject({ route: 'refuse', notice: REASON_NOT_PLACEABLE })
    expect(planFilesPlacement({ ...SAMPLE.widget, docId: undefined }, 'desk').route).toBe('refuse')
  })
  it('the hint never offers a key that does nothing', () => {
    expect(placementHint(['text'], 'desk')).toBe('Drop to place it on this desk')
    expect(placementHint(['text'], 'desk')).not.toMatch(/⌥/)
    expect(placementHint(['folder'], 'desk')).toMatch(/Drive work widget/)
    expect(placementHint(['image'], 'workcentre')).toMatch(/tile/)
    expect(placementHint(['image'], 'folder')).toBe('Drop to move here')
  })
})

describe('Q2: a Personal-drive file onto a shared desk', () => {
  const personal = { ...SAMPLE.pdf, orgId: 'personal' }
  const team = { ...SAMPLE.pdf, entryId: 'team-pdf', orgId: 'org-team' }

  it('only shared desks ask; only Personal files and folders are asked about', () => {
    expect(deskIsShared({ deskOrgId: 'personal', liveShared: false })).toBe(false)
    expect(deskIsShared({ deskOrgId: 'org-team', liveShared: false })).toBe(true)
    expect(deskIsShared({ deskOrgId: 'personal', liveShared: true })).toBe(true)
    expect(personalRefsForSharedDesk([personal, team, SAMPLE.widget], { deskOrgId: 'personal', liveShared: false })).toEqual([])
    const p = personalRefsForSharedDesk([personal, team, { ...SAMPLE.widget, orgId: 'personal' }], { deskOrgId: 'personal', liveShared: true })
    expect(p.map((r) => r.entryId)).toEqual(['pdf'])
    expect(shareChoiceFor([], { deskOrgId: 'org-team', liveShared: false })).toBeNull()
  })

  it('the server cannot share one Personal file today, so Share is offered disabled with the plain reason', () => {
    expect(SINGLE_FILE_SHARE_AVAILABLE).toBe(false)
    const c = shareChoiceFor([personal], { deskOrgId: 'org-team', liveShared: false })!
    expect(c.share).toEqual({ enabled: false, reason: `${SHARE_UNAVAILABLE} ${COPY_INSTEAD}` })
    expect(c.share.reason).toBe("Sharing a file from your Personal drive isn't available yet. You can give them a copy.")
    expect(c.copy).toEqual({ enabled: true })
    expect(c.placeAnyway.enabled).toBe(true)
    expect(c.body).toBe('“brief.pdf” is in your Personal drive, so people on this shared desk cannot open it.')
  })

  it('a live-shared desk carries no files, so a copy is not offered as if it could reach them', () => {
    const c = shareChoiceFor([personal], { deskOrgId: 'personal', liveShared: true })!
    expect(c.copy).toEqual({ enabled: false, reason: COPY_LIVE_SHARED })
    // And Share does not point at a copy that is not available.
    expect(c.share.reason).toBe(SHARE_UNAVAILABLE)
  })

  it('a folder cannot be copied this way', () => {
    const c = shareChoiceFor([{ ...SAMPLE.folder, orgId: 'personal' }], { deskOrgId: 'org-team', liveShared: false })!
    expect(c.copy).toEqual({ enabled: false, reason: COPY_FOLDER })
  })

  it('a disabled option can never come back from the dialog', () => {
    const c = shareChoiceFor([personal], { deskOrgId: 'personal', liveShared: true })!
    expect(acceptShareDecision(c, { kind: 'share', access: 'edit' })).toEqual({ kind: 'cancel' })
    expect(acceptShareDecision(c, { kind: 'share', access: 'view' })).toEqual({ kind: 'cancel' })
    expect(acceptShareDecision(c, { kind: 'copy' })).toEqual({ kind: 'cancel' })
    expect(acceptShareDecision(c, { kind: 'place' })).toEqual({ kind: 'place' })
    const t = shareChoiceFor([personal], { deskOrgId: 'org-team', liveShared: false })!
    expect(acceptShareDecision(t, { kind: 'copy' })).toEqual({ kind: 'copy' })
  })

  it('several files: the wording counts them', () => {
    const c = shareChoiceFor([personal, { ...personal, entryId: 'p2' }], { deskOrgId: 'org-team', liveShared: false })!
    expect(c.title).toBe('Share these files with the desk?')
    expect(c.body).toBe('2 of these are in your Personal drive, so people on this shared desk cannot open them.')
  })
})

describe('Q3: several pictures at once', () => {
  const pics = [SAMPLE.image, { ...SAMPLE.image, entryId: 'img2' }, SAMPLE.svg]
  it('asks only for two or more pictures on a desk or the Workcentre', () => {
    expect(galleryChoiceNeeded(pics, 'desk')).toBe(true)
    expect(galleryChoiceNeeded(pics, 'workcentre')).toBe(true)
    expect(galleryChoiceNeeded(pics, 'folder')).toBe(false)
    expect(galleryChoiceNeeded([SAMPLE.image, SAMPLE.pdf], 'desk')).toBe(false)
  })
  it('one gallery holds the pictures; everything else is placed one by one', () => {
    const all = [...pics, SAMPLE.pdf, SAMPLE.folder]
    expect(splitForGallery(all, 'gallery')).toEqual({ gallery: pics, each: [SAMPLE.pdf, SAMPLE.folder] })
    expect(splitForGallery(all, 'individual')).toEqual({ gallery: [], each: all })
    expect(splitForGallery(all, 'cancel')).toEqual({ gallery: [], each: [] })
  })
  it('the gallery holds the SAME file ids (the gallery work widget’s own content shape)', () => {
    expect(JSON.parse(galleryContent(pics))).toEqual({ fileIds: ['img', 'img2', 'svg'] })
  })
})
