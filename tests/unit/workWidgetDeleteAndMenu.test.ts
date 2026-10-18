// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Widget } from '../../src/shared/types'

// Loose ends of "every work widget is a file" (docs/widget-files.md):
//
//   1. Delete / Backspace on a selection asks the × question (when, and for what);
//   2. the assistant's delete-widget says which of its two meanings it is, and
//      "everywhere" goes through the same trash-the-file path the × uses;
//   3. the side menu says which task list a click or a drag makes;
//   4. the Mail tile places Plexii's own mail, not a Gmail web page;
//   5. Files says which desk(s) each work widget file sits on.

// ── stores the delete action reaches (mocked: no Electron, no IPC) ──────────
let storeWidgets: Widget[] = []
const removeSpy = vi.fn().mockResolvedValue(undefined)
const trashManySpy = vi.fn().mockResolvedValue(1)
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: { getState: () => ({ get widgets() { return storeWidgets }, remove: removeSpy }) }
}))
vi.mock('../../src/renderer/src/stores/widgetFiles', () => ({
  useWidgetFilesStore: { getState: () => ({ trashMany: trashManySpy }) }
}))

const { applyDeleteWidget, deleteWidgetVerb } = await import('../../src/renderer/src/lib/deleteWidgetAction')
const { deleteKeyAllowed, isDeleteKey } = await import('../../src/renderer/src/lib/deleteKey')
const { removalPlan, MANY_REMOVE_HINT, MANY_DELETE_HINT } = await import('../../src/renderer/src/lib/widgetRemovalCopy')
const { widgetMenuHint, tileWidgetKind, kindsRepresentedByApps, widgetMenuEntries } = await import('../../src/renderer/src/lib/widgetMenu')
const { SEGMENT_APPS } = await import('../../src/renderer/src/lib/segmentApps')
const { catalogFor } = await import('../../src/renderer/src/lib/widgetCatalog')
const { widgetFileDeskLine } = await import('../../src/renderer/src/lib/fileEntryType')
const { describeAction } = await import('../../src/main/ai/actionLabel')
const { parseChatJson, ACTION_KINDS_CATALOG } = await import('../../src/main/ai/anthropic')

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

function w(id: string, over: Partial<Widget> = {}): Widget {
  return { id, taskId: 'deskA', kind: 'sticky', title: '', content: '', syncGroupId: null, ...over } as Widget
}

// A stand-in for document.activeElement: tag, editability and what is above it.
function el(tagName: string, opts: { editable?: boolean; inside?: boolean } = {}): Element {
  return {
    tagName,
    isContentEditable: !!opts.editable,
    closest: () => (opts.inside ? ({} as Element) : null)
  } as unknown as Element
}

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods
})

const onDesk = {
  activeTaskId: 'deskA',
  selectedIds: ['a', 'b'],
  activeWidgetId: null,
  focusedWidgetId: null,
  focusedElement: el('BODY')
}

describe('Delete / Backspace on a selection', () => {
  it('is Delete or Backspace, without a command modifier, and not a held repeat', () => {
    expect(isDeleteKey(key('Delete'))).toBe(true)
    expect(isDeleteKey(key('Backspace'))).toBe(true)
    expect(isDeleteKey(key('Backspace', { metaKey: true }))).toBe(false) // ⌘⌫ is not this
    expect(isDeleteKey(key('Delete', { ctrlKey: true }))).toBe(false)
    expect(isDeleteKey(key('Delete', { altKey: true }))).toBe(false)
    expect(isDeleteKey(key('Delete', { repeat: true }))).toBe(false)
    expect(isDeleteKey(key('d'))).toBe(false)
  })

  it('reaches the question only on a desk with a selection and focus on the bare canvas', () => {
    expect(deleteKeyAllowed(onDesk)).toBe(true)
    expect(deleteKeyAllowed({ ...onDesk, activeTaskId: null })).toBe(false)
    expect(deleteKeyAllowed({ ...onDesk, selectedIds: [] })).toBe(false)
    expect(deleteKeyAllowed({ ...onDesk, focusedWidgetId: 'a' })).toBe(false) // focus mode
  })

  it('never while typing, in a control, a dialog or a web view', () => {
    expect(deleteKeyAllowed({ ...onDesk, focusedElement: el('INPUT') })).toBe(false)
    expect(deleteKeyAllowed({ ...onDesk, focusedElement: el('TEXTAREA') })).toBe(false)
    expect(deleteKeyAllowed({ ...onDesk, focusedElement: el('WEBVIEW') })).toBe(false)
    expect(deleteKeyAllowed({ ...onDesk, focusedElement: el('DIV', { editable: true }) })).toBe(false)
    expect(deleteKeyAllowed({ ...onDesk, focusedElement: el('SPAN', { inside: true }) })).toBe(false) // inside a dialog / editor
  })

  it('a widget clicked into but NOT selected keeps its own Backspace', () => {
    expect(deleteKeyAllowed({ ...onDesk, activeWidgetId: 'c' })).toBe(false)
    // …while one that is part of the selection does not block it.
    expect(deleteKeyAllowed({ ...onDesk, activeWidgetId: 'a' })).toBe(true)
  })

  it('the canvas wires the key and the selection bar to the same remove-or-delete question', () => {
    const canvas = read('renderer/src/components/Canvas.tsx')
    expect(canvas).toContain('isDeleteKey(e)')
    expect(canvas).toContain('deleteKeyAllowed({')
    expect(canvas).toContain('await removeWorkWidgets(sel)')
    // The old path removed every selected widget with no question at all.
    expect(canvas).not.toContain('ids.map((id) => removeWidget(id))')
    expect(read('renderer/src/components/ShortcutsOverlay.tsx')).toContain("keys: 'Delete / ⌫'")
  })

  it('removing several from the desk is one undo step; deleting them is one Trash notice', () => {
    const src = read('renderer/src/lib/widgetRemoval.ts')
    expect(src).toContain('hist.beginBatch()')
    expect(src).toContain('trashMany(plan.fileIds)')
    expect(read('renderer/src/stores/widgetFiles.ts')).toContain('recordAction({')
    expect(MANY_REMOVE_HINT).toBe('They stay in Files and on any other desk.')
    expect(MANY_DELETE_HINT).toMatch(/every desk and from Files/)
  })

  it('a multi-selection deletes each file once and only removes what has no file', () => {
    const files: Record<string, string | null> = { a: 'f1', b: 'f1', c: 'f2', d: null }
    const plan = removalPlan([w('a'), w('b'), w('c'), w('d')], (x) => files[x.id])
    expect(plan.fileIds).toEqual(['f1', 'f2'])
    expect(plan.deskOnlyIds).toEqual(['d'])
  })
})

describe("the assistant's delete-widget says which it does", () => {
  const api = {
    widgets: { get: vi.fn() },
    widgetFiles: { get: vi.fn() }
  }
  beforeEach(() => {
    vi.clearAllMocks()
    storeWidgets = []
    ;(globalThis as unknown as { window: unknown }).window = { api }
    trashManySpy.mockResolvedValue(1)
  })

  it('parses "everywhere" only when asked, and anything else as remove-from-desk', () => {
    const parse = (scope?: unknown) =>
      parseChatJson(JSON.stringify({ reply: '', actions: [{ kind: 'delete-widget', widgetId: 'w1', label: 'the table', scope }] }))
        .proposals[0] as { scope?: string }
    expect(parse('everywhere').scope).toBe('everywhere')
    expect(parse('desk').scope).toBe('desk')
    expect(parse(undefined).scope).toBe('desk')
    expect(parse('nuke').scope).toBe('desk')
  })

  it('tells the model the difference, and marks which canvas lines are files', () => {
    expect(ACTION_KINDS_CATALOG).toContain('"scope":"desk" (the default) REMOVES it from this desk only')
    expect(ACTION_KINDS_CATALOG).toContain('"scope":"everywhere" DELETES the work widget itself')
    expect(read('main/ai/anthropic.ts')).toContain('` file=${fileId}`')
  })

  it('the card and the trace name the meaning', () => {
    expect(deleteWidgetVerb({ scope: 'desk' })).toBe('Remove from this desk')
    expect(deleteWidgetVerb({})).toBe('Remove from this desk')
    expect(deleteWidgetVerb({ scope: 'everywhere' })).toBe('Delete everywhere')
    expect(describeAction({ kind: 'delete-widget', label: 'the table' })!.label).toBe('Remove from this desk — the table')
    expect(describeAction({ kind: 'delete-widget', label: 'the table', scope: 'everywhere' })!.label).toBe(
      'Delete work widget everywhere — the table'
    )
    expect(read('renderer/src/components/ProposalCards.tsx')).toContain('everywhere (to Trash, with every copy on every desk)')
  })

  it('stays a gated kind: always waits for Apply', () => {
    expect(read('renderer/src/lib/actionExecutor.ts')).toMatch(/GATED_KINDS[\s\S]*'delete-widget'/)
  })

  it("by default removes this desk's copy only; the file stays", async () => {
    api.widgets.get.mockResolvedValue(w('w1', { syncGroupId: 'wf:f1' }))
    api.widgetFiles.get.mockResolvedValue({ id: 'f1', trashed: false })
    const r = await applyDeleteWidget({ id: 'p', kind: 'delete-widget', widgetId: 'w1', label: 'the table' })
    expect(r).toEqual({ ok: true, message: 'Removed the table from this desk — it stays in Files' })
    expect(removeSpy).toHaveBeenCalledWith('w1', { scope: 'desk' })
    expect(trashManySpy).not.toHaveBeenCalled()
  })

  it('"everywhere" trashes the file (and so every copy) through the × path, not the desk copy', async () => {
    api.widgets.get.mockResolvedValue(w('w1', { syncGroupId: 'wf:f1' }))
    api.widgetFiles.get.mockResolvedValue({ id: 'f1', trashed: false })
    const r = await applyDeleteWidget({ id: 'p', kind: 'delete-widget', widgetId: 'w1', label: 'the table', scope: 'everywhere' })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/in Trash, with its copies on every desk/)
    expect(trashManySpy).toHaveBeenCalledWith(['f1'])
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('"everywhere" also takes a file by its documentId, with no desk copy', async () => {
    api.widgets.get.mockResolvedValue(null)
    api.widgetFiles.get.mockResolvedValue({ id: 'f9', trashed: false })
    const r = await applyDeleteWidget({ id: 'p', kind: 'delete-widget', widgetId: 'f9', label: 'the list', scope: 'everywhere' })
    expect(r.ok).toBe(true)
    expect(trashManySpy).toHaveBeenCalledWith(['f9'])
  })

  it('a widget with no file here is removed, and the message says that is all there was', async () => {
    api.widgets.get.mockResolvedValue(w('s1', { kind: 'section' }))
    const r = await applyDeleteWidget({ id: 'p', kind: 'delete-widget', widgetId: 's1', label: 'the section', scope: 'everywhere' })
    expect(r).toEqual({ ok: true, message: 'Removed the section — it only lived on this desk, so that deleted it' })
    expect(removeSpy).toHaveBeenCalledWith('s1', { scope: 'delete' })
    expect(trashManySpy).not.toHaveBeenCalled()
  })

  it('an id that matches nothing fails honestly instead of claiming a removal', async () => {
    api.widgets.get.mockResolvedValue(null)
    api.widgetFiles.get.mockResolvedValue(null)
    const r = await applyDeleteWidget({ id: 'p', kind: 'delete-widget', widgetId: 'ghost-123456', label: 'x' })
    expect(r.ok).toBe(false)
    expect(removeSpy).not.toHaveBeenCalled()
    expect(trashManySpy).not.toHaveBeenCalled()
  })

  it('a trash that did not happen is not reported as done', async () => {
    api.widgets.get.mockResolvedValue(w('w1', { syncGroupId: 'wf:f1' }))
    api.widgetFiles.get.mockResolvedValue({ id: 'f1', trashed: false })
    trashManySpy.mockResolvedValue(0)
    const r = await applyDeleteWidget({ id: 'p', kind: 'delete-widget', widgetId: 'w1', label: 'the table', scope: 'everywhere' })
    expect(r.ok).toBe(false)
  })

  it('MCP still has no delete: its edit tool says where removing happens', () => {
    const mcp = read('main/mcpServer.ts')
    expect(mcp).toContain('Nothing on this surface removes a work widget from a desk or deletes one')
    expect(mcp).not.toMatch(/name: 'plexii_(delete|remove|trash)_/)
  })
})

describe('task lists: the side menu says which one you get', () => {
  it("the task list tooltip names both: a drag is the desk's tasks, a click is its own list", () => {
    const hint = widgetMenuHint({ kind: 'task-list', hint: '' })
    expect(hint).toContain("Drag onto a desk, or right-click and Add to this desk: that desk's tasks.")
    expect(hint).toContain('Click: a task list of its own, saved in Files')
  })

  it('other kinds keep their catalogue hint, plus what a click does', () => {
    expect(widgetMenuHint({ kind: 'sticky', hint: 'A sticky note.' })).toBe(
      'A sticky note. Click for a new one in Files, or drag it onto a desk.'
    )
    expect(widgetMenuHint({ kind: 'section', hint: 'Group things' })).toBe('Group things. Only works on a desk.')
  })

  it('the tile shows it, and the drag path makes the desk lens', () => {
    expect(read('renderer/src/components/nav/WidgetsSection.tsx')).toContain('hint={widgetMenuHint(entry)}')
    expect(read('renderer/src/components/nav/menuParts.tsx')).toContain('[note ? `${label} — ${note}` : label, hint]')
    expect(read('main/ipc/index.ts')).toContain('createAndPlaceWidgetFile(draft, at,')
    expect(read('web/worker/handlers.ts')).toContain('createAndPlaceWidgetFile(draft, at,')
  })
})

describe('the Mail tile places the Inbox work widget', () => {
  const mail = SEGMENT_APPS.office.find((a) => a.key === 'mail')!

  it('drags and "Add … to this desk"s as Plexii\'s own mail, not a Gmail web view', () => {
    expect(tileWidgetKind(mail)).toBe('inbox')
    expect(catalogFor('inbox')!.isWebBased).toBe(false)
    expect(catalogFor('email')!.isWebBased).toBe(true) // what it used to place
  })

  it('still keeps the web-mail kind out of the Work widgets section', () => {
    expect(kindsRepresentedByApps().has('email')).toBe(true)
    expect(widgetMenuEntries().some((e) => e.kind === 'email' || e.kind === 'inbox')).toBe(false)
  })
})

describe('Files: where each work widget file lives', () => {
  const d = (deskTitle: string) => ({ deskId: deskTitle.toLowerCase(), deskTitle })
  it('names its desks, or says it is on none, and says nothing while unknown', () => {
    expect(widgetFileDeskLine(undefined)).toBeNull()
    expect(widgetFileDeskLine([])).toBe('Not on a desk')
    expect(widgetFileDeskLine([d('Launch')])).toBe('On Launch')
    expect(widgetFileDeskLine([d('Launch'), d('Hiring')])).toBe('On Launch and Hiring')
    expect(widgetFileDeskLine([d('A'), d('B'), d('C')])).toBe('On A, B and 1 more desk')
    expect(widgetFileDeskLine([d('A'), d('B'), d('C'), d('D')])).toBe('On A, B and 2 more desks')
  })

  it('Files asks once per listing and moves nothing', () => {
    const files = read('renderer/src/components/views/FilesView.tsx')
    expect(files).toContain('.placements(widgetDocIds)')
    expect(files).toContain('data-testid="files-widget-desks"')
    expect(read('preload/index.ts')).toContain("ipcRenderer.invoke('widgetFiles:placements', ids)")
  })
})

describe('the link mark in a work widget header', async () => {
  const { linkBadge, alsoOnTitle, PLAIN_SYNC_TITLE } = await import('../../src/renderer/src/lib/linkBadge')
  const desk = (deskId: string) => ({ deskId, deskTitle: deskId })
  const inst = { id: 'w1', taskId: 'deskA', syncGroupId: 'wf:f1' }

  it('is not shown just because a work widget is linked to its file', () => {
    expect(linkBadge(inst, [desk('deskA')])).toBeNull()
    expect(linkBadge(inst, undefined)).toBeNull() // unknown yet: no guess
    expect(linkBadge({ ...inst, syncGroupId: null }, [])).toBeNull()
  })

  it('says how many OTHER desks hold the same file', () => {
    expect(linkBadge(inst, [desk('deskA'), desk('deskB')])).toEqual({ title: alsoOnTitle(1), others: 1 })
    expect(alsoOnTitle(1)).toMatch(/^Also on 1 other desk —/)
    expect(linkBadge(inst, [desk('deskA'), desk('deskB'), desk('deskC')])!.title).toMatch(/^Also on 2 other desks/)
  })

  it('keeps the old meaning for a plain synced copy, and never marks the full-pane file', () => {
    expect(linkBadge({ ...inst, syncGroupId: 'grp-1' }, undefined)).toEqual({ title: PLAIN_SYNC_TITLE, others: null })
    expect(linkBadge({ id: 'wf:f1', taskId: '', syncGroupId: 'wf:f1' }, [desk('deskA'), desk('deskB')])).toBeNull()
  })

  it('the header uses it, and placing / removing / trashing refreshes it', () => {
    const frame = read('renderer/src/components/widgets/WidgetFrame.tsx')
    expect(frame).toContain('const linkMark = linkBadge(widget, fileDesks)')
    expect(frame).not.toContain('{widget.syncGroupId && (')
    expect(read('renderer/src/stores/widgetFiles.ts').match(/refreshFileDesks\(\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(read('renderer/src/stores/widgets.ts')).toContain('refreshFileDesks()')
  })
})
