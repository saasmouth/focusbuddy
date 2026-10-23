import type { Editor } from '@tiptap/react'
import type { DocumentOps } from './documentOps'
import Icon from '../../Icon'
import { checkDocA11y } from '../../../lib/docA11y'
import { MenuBarShell, MenuModal, type MenuDef, type MenuItem } from './menuBarKit'
import { documentCommands, menuItemOf, menuRow, type OfficeCommand } from '../../../lib/menus/officeCommand'
import type { WriteCommands } from './writeCommands'

// A Google-Docs-style menu bar for the document editor: File / Edit / View /
// Insert / Format / Tools / Help. It declares the SHAPE of the menus — which
// rows, in what order, under which separators — and nothing else: every row's
// label, key hint, icon, enabled state, reason and behaviour comes from the
// command registry (writeCommands.ts), which the ribbon and the Cmd+K palette
// render from too. So a row cannot say one thing here and another there, and
// this file holds no state and no editor calls at all.
//
// This file does not read the documents store, and must not: it used to act on
// the store's `active` document, which in a desk widget is not the document on
// screen (see documentOps). Enforced by tests/unit/documentOpsGuard.test.ts.
//
// This file declares the menus; menuBarKit renders them, as it does for every
// other office app. The bar's testid is `doc-menubar` while its menus are
// `doc-menu-<id>` and `doc-menu-<id>-list`, so the kit is given an explicit
// `itemTestid` — the two prefixes predate the shared kit and specs rely on both.

interface Props {
  /**
   * PlexiiWrite's commands, built by DocEditor from the live editor. One
   * definition per action, shared with the ribbon and the palette.
   */
  commands: WriteCommands
  /**
   * The document on screen, bound to its id by whichever host mounted this
   * editor. Absent where there is no document — a snippet session — and then
   * none of the document items are shown at all.
   */
  documentOps?: DocumentOps
}

export default function DocMenuBar({ commands, documentOps }: Props): JSX.Element {
  // A missing id is a programming error, not an empty menu: fail loudly at
  // render rather than quietly dropping the row.
  const c = (id: string): OfficeCommand => {
    const found = commands[id]
    if (!found) throw new Error(`DocMenuBar: no command "${id}" in the registry`)
    return found
  }
  const item = (id: string, extra?: Partial<MenuItem & { kind: 'item' }>): MenuItem => menuItemOf(c(id), extra)
  /** A row under a menu whose title supplies the verb (Insert ▸ Image, Download ▸ …). */
  const row = (id: string): MenuItem => menuRow(c(id))

  const doc = documentCommands(documentOps, 'doc')

  const MENUS: MenuDef[] = [
    {
      id: 'file',
      label: 'File',
      build: () => {
        // Each of these acts on a document, so the whole group is ABSENT without
        // ops rather than disabled. Download acts on the editor's own content
        // and works with no document at all, so it is never in this group.
        const docGroup: MenuItem[] = doc
          ? [
              menuItemOf(doc.newDocument),
              menuItemOf(doc.makeCopy),
              { kind: 'sep' },
              menuItemOf(doc.rename),
              menuItemOf(doc.versionHistory)
            ]
          : []
        // The separator belongs to Move to trash, so it leaves with it; left
        // behind, the menu would end on a divider with nothing under it.
        const trashGroup: MenuItem[] = doc ? [{ kind: 'sep' }, menuItemOf(doc.moveToTrash)] : []
        return [
          ...docGroup,
          // Real printing, only where the host can really print. The row this
          // replaced was labelled "Print (PDF)" and ran the PDF export: a menu
          // row that said Print and did not print. Download ▸ PDF covers that.
          ...(doc?.print ? [menuItemOf(doc.print)] : []),
          {
            kind: 'submenu',
            label: 'Download',
            icon: 'download',
            items: [row('doc-export-docx'), row('doc-export-pdf'), row('doc-export-html')]
          },
          ...trashGroup
        ]
      }
    },
    {
      id: 'edit',
      label: 'Edit',
      build: () => [
        item('doc-undo'),
        item('doc-redo'),
        { kind: 'sep' },
        item('doc-cut'),
        item('doc-copy'),
        item('doc-paste'),
        { kind: 'sep' },
        item('doc-select-all'),
        item('doc-find'),
        item('doc-find-replace'),
        // Save selection as snippet… belongs to Edit in every office app (SPEC §9.2; it was under Tools).
        { kind: 'sep' },
        item('doc-save-snippet', { hint: 'Keep it for reuse in any document' })
      ]
    },
    {
      id: 'view',
      label: 'View',
      build: () => [
        item('doc-page-paged'),
        item('doc-page-continuous'),
        { kind: 'sep' },
        item('doc-outline'),
        item('doc-comments'),
        { kind: 'sep' },
        item('doc-focus')
      ]
    },
    {
      id: 'insert',
      label: 'Insert',
      build: () => [
        row('doc-insert-image'),
        row('doc-insert-table'),
        row('doc-insert-toc'),
        row('doc-insert-footnote'),
        row('doc-insert-link'),
        row('doc-divider'),
        // The shared tail (SPEC §9.2): Insert snippet… · Work widget from a desk…, then Meeting.
        { kind: 'sep' },
        item('doc-insert-snippet'),
        item('doc-insert-widget'),
        // A meeting is the one item here that reaches other people, so a wrong
        // id invites them to someone else's document. It went out with
        // `id: active?.id ?? ''` — the wrong document, or none at all.
        ...(doc ? ([{ kind: 'sep' }, menuItemOf(doc.meeting)] as MenuItem[]) : [])
      ]
    },
    {
      id: 'format',
      label: 'Format',
      build: () => [
        {
          kind: 'submenu',
          label: 'Text',
          icon: 'format_bold',
          items: [row('doc-bold'), row('doc-italic'), row('doc-underline'), row('doc-strike')]
        },
        {
          kind: 'submenu',
          label: 'Paragraph styles',
          icon: 'title',
          items: [row('doc-paragraph'), row('doc-h1'), row('doc-h2'), row('doc-h3')]
        },
        {
          kind: 'submenu',
          label: 'Align',
          icon: 'format_align_left',
          items: [row('doc-align-left'), row('doc-align-center'), row('doc-align-right'), row('doc-align-justify')]
        },
        {
          kind: 'submenu',
          label: 'Bullets & numbering',
          icon: 'format_list_bulleted',
          items: [row('doc-bullets'), row('doc-numbers'), row('doc-checklist')]
        },
        { kind: 'sep' },
        item('doc-clear-format')
      ]
    },
    {
      id: 'tools',
      label: 'Tools',
      build: () => [item('doc-wordcount'), item('doc-a11y')]
    },
    {
      id: 'help',
      label: 'Help',
      build: () => [item('doc-shortcuts')]
    }
  ]

  return <MenuBarShell menus={MENUS} testid="doc-menubar" itemTestid="doc-menu" />
}

export function WordCountModal({ editor, onClose }: { editor: Editor; onClose: () => void }): JSX.Element {
  const text = editor.getText()
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const characters = text.length
  const charactersNoSpaces = text.replace(/\s/g, '').length
  const rows: [string, number][] = [
    ['Words', words],
    ['Characters', characters],
    ['Characters excluding spaces', charactersNoSpaces]
  ]
  return (
    <MenuModal width={320} title="Word count" onClose={onClose}>
      <div className="space-y-1.5">
        {rows.map(([label, n]) => (
          <div key={label} className="flex items-center justify-between text-[13px]">
            <span className="text-[var(--ink-50)]">{label}</span>
            <span className="font-medium fb-tabular text-[var(--ink-90)]">{n.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </MenuModal>
  )
}

export function A11yModal({ editor, onClose }: { editor: Editor; onClose: () => void }): JSX.Element {
  const issues = checkDocA11y(editor.getJSON())
  return (
    <MenuModal width={320} title="Accessibility check" onClose={onClose}>
      {issues.length === 0 ? (
        <div className="flex items-center gap-2 text-[13px] text-emerald-600" data-testid="doc-a11y-clean">
          <Icon name="check_circle" size={16} />
          <span>No accessibility issues found.</span>
        </div>
      ) : (
        <div className="space-y-2" data-testid="doc-a11y-issues">
          {issues.map((it, i) => (
            <div key={i} className="flex items-start gap-2 text-[12px]" data-testid="doc-a11y-issue">
              <Icon
                name={it.severity === 'error' ? 'error' : 'warning'}
                size={15}
                className={it.severity === 'error' ? 'text-rose-500 shrink-0 mt-0.5' : 'text-amber-500 shrink-0 mt-0.5'}
              />
              <span className="text-[var(--ink-70)]">{it.message}</span>
            </div>
          ))}
        </div>
      )}
    </MenuModal>
  )
}
