import type { Editor } from '@tiptap/react'
import { READ_ONLY_REASON } from '../../office/shell'
import { sharedCommand, type OfficeCommand } from '../../../lib/menus/officeCommand'
import { insertLink, pasteFromMenu } from './docActions'

// PlexiiWrite's command registry: ONE definition per action (SPEC §9, "no
// repeats"). The menu bar, the ContextBar ribbon, the right-click menu and the
// Cmd+K palette all render from this map, so an action cannot carry one label
// in the menu and another in the palette, nor be live on one surface while
// disabled on another.
//
// Before this existed the same action was written out three times, and the
// three copies had already drifted:
//
//   - Format ▸ Paragraph styles ▸ "Normal text" vs the palette's "Body text".
//   - Tools ▸ "Check accessibility" vs the ribbon's "Accessibility check".
//   - The palette's one `doc-find` claimed to be "Find and replace" on ⌘F,
//     while the menu bar had Find… on ⌘F and Find and replace… on ⇧⌘H
//     (lexicon E-14). The palette's hint was simply wrong.
//   - File ▸ "Print (PDF)" ran the PDF export: a menu row that said Print and
//     did not print. It is gone; real printing is `documentCommands().print`,
//     present only where the host can actually print.
//
// Ids are the palette's existing ones (`doc-bold`, `doc-h1`, …) because they
// are the user-visible contract of a keyboard-first palette; nothing is
// renamed. Actions that had no palette entry take an id in the same shape.
//
// `label` is the standalone form the flat palette needs; `shortLabel` is the
// form shown under a menu whose own title supplies the verb (Insert ▸ "Image",
// Download ▸ "Microsoft Word (.docx)", Align ▸ "Left"). Both live in the one
// definition, so they cannot drift apart.

/** Everything the commands need. DocEditor owns every one of these. */
export interface WriteCommandDeps {
  editor: Editor
  /** A viewer's editor. Every command that would change the document is disabled WITH a reason. */
  readOnly: boolean
  /** Used to name the downloaded .html file. */
  title: string
  insertImage: () => void
  insertWidget: () => void
  insertDoc: () => void
  insertSnippet: () => void
  saveSnippet: () => void
  importDocx: () => void
  exportDocx: () => void
  exportPdf: () => void
  find: () => void
  findReplace: () => void
  focusMode: () => void
  outline: () => void
  comments: () => void
  pageView: boolean
  setPageView: (v: boolean) => void
  setPortrait: () => void
  setLandscape: () => void
  dialog: (d: 'wordcount' | 'a11y') => void
  shortcuts: () => void
  draftAi: () => void
  rewriteAi: () => void
}

export type WriteCommands = Record<string, OfficeCommand>

export function buildWriteCommands(d: WriteCommandDeps): WriteCommands {
  const { editor, readOnly } = d
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  /** A command that changes the document: off for a viewer, and it says why. */
  const edits = (): Pick<OfficeCommand, 'enabled' | 'reason'> => ({
    enabled: () => !readOnly,
    reason: () => (readOnly ? READ_ONLY_REASON : undefined)
  })

  /** A mark toggle: one line each, all read-only gated, all reporting their own state. */
  const mark = (id: string, label: string, name: string, run: () => void, extra: Partial<OfficeCommand> = {}): OfficeCommand => ({
    id,
    label,
    group: 'Format',
    checked: () => editor.isActive(name),
    run,
    ...edits(),
    ...extra
  })

  async function exportHtml(): Promise<void> {
    await window.api.exportDoc.html({
      html: editor.getHTML(),
      suggestedName: `${d.title || 'document'}.html`
    })
  }

  const cs: OfficeCommand[] = [
    // ── Edit ───────────────────────────────────────────────────────────────
    // Undo and redo now say WHY they are off, which the menu never did: a
    // greyed row with no reason is one of the §9.5 cases ctxRow refuses.
    sharedCommand('doc-undo', 'undo', () => chain().undo().run(), {
      icon: 'undo',
      group: 'Edit',
      enabled: () => !readOnly && editor.can().undo(),
      reason: () => (readOnly ? READ_ONLY_REASON : 'Nothing to undo.')
    }),
    sharedCommand('doc-redo', 'redo', () => chain().redo().run(), {
      icon: 'redo',
      group: 'Edit',
      enabled: () => !readOnly && editor.can().redo(),
      reason: () => (readOnly ? READ_ONLY_REASON : 'Nothing to redo.')
    }),
    // Cut removes text, so it is a viewer's one blocked clipboard row; copy
    // and select all are not.
    sharedCommand('doc-cut', 'cut', () => document.execCommand('cut'), { group: 'Edit', ...edits() }),
    sharedCommand('doc-copy', 'copy', () => document.execCommand('copy'), { group: 'Edit' }),
    sharedCommand('doc-paste', 'paste', () => void pasteFromMenu(editor), { group: 'Edit', ...edits() }),
    sharedCommand('doc-select-all', 'selectAll', () => chain().selectAll().run(), { group: 'Edit' }),
    sharedCommand('doc-find', 'find', d.find, { icon: 'search', group: 'Edit', keywords: 'search' }),
    sharedCommand('doc-find-replace', 'findAndReplace', d.findReplace, {
      icon: 'find_replace',
      group: 'Edit',
      keywords: 'search replace substitute',
      ...edits()
    }),
    sharedCommand('doc-save-snippet', 'saveAsSnippet', d.saveSnippet, {
      group: 'Insert',
      barLabel: 'Save as snippet…',
      // Not read-only gated: reading the selection out into a snippet changes
      // nothing in this document, and a viewer may already copy it.
      keywords: 'reuse template component library'
    }),

    // ── Format: marks ──────────────────────────────────────────────────────
    mark('doc-bold', 'Bold', 'bold', () => chain().toggleBold().run(), { icon: 'format_bold', keys: ['mod', 'b'], keywords: 'strong' }),
    mark('doc-italic', 'Italic', 'italic', () => chain().toggleItalic().run(), { icon: 'format_italic', keys: ['mod', 'i'], keywords: 'emphasis' }),
    mark('doc-underline', 'Underline', 'underline', () => chain().toggleUnderline().run(), { icon: 'format_underlined', keys: ['mod', 'u'] }),
    mark('doc-strike', 'Strikethrough', 'strike', () => chain().toggleStrike().run(), { icon: 'strikethrough_s', keywords: 'cross out' }),
    mark('doc-code', 'Inline code', 'code', () => chain().toggleCode().run(), { icon: 'code', keywords: 'monospace' }),
    mark('doc-highlight', 'Highlight', 'highlight', () => chain().toggleHighlight().run(), { icon: 'ink_highlighter', keywords: 'mark' }),
    // The one shared clear-formatting action (lexicon `clearFormatting`):
    // PlexiiCells binds the same label and the same ⌘\ to its own reset.
    sharedCommand('doc-clear-format', 'clearFormatting', () => chain().unsetAllMarks().clearNodes().run(), {
      group: 'Format',
      keywords: 'remove strip reset marks',
      ...edits()
    }),

    // ── Format: paragraph styles ───────────────────────────────────────────
    // "Normal text" is the label (the palette said "Body text"); the id stays
    // `doc-paragraph`.
    {
      id: 'doc-paragraph',
      label: 'Normal text',
      icon: 'notes',
      group: 'Style',
      keywords: 'body normal paragraph',
      checked: () => editor.isActive('paragraph'),
      run: () => chain().setParagraph().run(),
      ...edits()
    },
    ...([1, 2, 3] as const).map(
      (level): OfficeCommand => ({
        id: `doc-h${level}`,
        label: `Heading ${level}`,
        icon: 'title',
        group: 'Style',
        keywords: level === 1 ? 'title big' : 'subheading',
        checked: () => editor.isActive('heading', { level }),
        // The menu used setHeading and the palette toggleHeading; toggle is
        // the one that lets a second press take the heading back off.
        run: () => chain().toggleHeading({ level }).run(),
        ...edits()
      })
    ),
    {
      id: 'doc-bullets',
      label: 'Bulleted list',
      icon: 'format_list_bulleted',
      group: 'Style',
      keywords: 'unordered bullets',
      checked: () => editor.isActive('bulletList'),
      run: () => chain().toggleBulletList().run(),
      ...edits()
    },
    {
      id: 'doc-numbers',
      label: 'Numbered list',
      icon: 'format_list_numbered',
      group: 'Style',
      keywords: 'ordered',
      checked: () => editor.isActive('orderedList'),
      run: () => chain().toggleOrderedList().run(),
      ...edits()
    },
    {
      id: 'doc-checklist',
      label: 'Checklist',
      icon: 'checklist',
      group: 'Style',
      keywords: 'task todo',
      checked: () => editor.isActive('taskList'),
      run: () => chain().toggleTaskList().run(),
      ...edits()
    },
    {
      id: 'doc-quote',
      label: 'Quote block',
      icon: 'format_quote',
      group: 'Style',
      keywords: 'blockquote',
      checked: () => editor.isActive('blockquote'),
      run: () => chain().toggleBlockquote().run(),
      ...edits()
    },
    {
      id: 'doc-codeblock',
      label: 'Code block',
      icon: 'data_object',
      group: 'Style',
      keywords: 'snippet syntax',
      checked: () => editor.isActive('codeBlock'),
      run: () => chain().toggleCodeBlock().run(),
      ...edits()
    },

    // ── Format: align ──────────────────────────────────────────────────────
    // Labels are British in display and American in the id and the editor
    // attribute, which is the house rule: "Align centre" reads to the user,
    // `doc-align-center` and setTextAlign('center') stay as they are.
    ...(
      [
        ['left', 'Align left', 'Left', 'format_align_left'],
        ['center', 'Align centre', 'Centre', 'format_align_center'],
        ['right', 'Align right', 'Right', 'format_align_right'],
        ['justify', 'Justify', 'Justify', 'format_align_justify']
      ] as const
    ).map(
      ([value, label, shortLabel, icon]): OfficeCommand => ({
        id: `doc-align-${value}`,
        label,
        shortLabel,
        icon,
        group: 'Align',
        ...(value === 'center' ? { keywords: 'center' } : {}),
        checked: () => editor.isActive({ textAlign: value }),
        run: () => chain().setTextAlign(value).run(),
        ...edits()
      })
    ),

    // ── Insert ─────────────────────────────────────────────────────────────
    { id: 'doc-insert-image', label: 'Insert image', shortLabel: 'Image', icon: 'image', group: 'Insert', keywords: 'picture photo', run: d.insertImage, ...edits() },
    {
      id: 'doc-insert-table',
      label: 'Insert table',
      shortLabel: 'Table',
      icon: 'grid_on',
      group: 'Insert',
      keywords: 'grid',
      run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      ...edits()
    },
    {
      id: 'doc-insert-toc',
      label: 'Insert table of contents',
      shortLabel: 'Table of contents',
      icon: 'toc',
      group: 'Insert',
      keywords: 'toc outline contents',
      run: () => chain().insertTableOfContents().run(),
      ...edits()
    },
    {
      id: 'doc-insert-footnote',
      label: 'Insert footnote',
      shortLabel: 'Footnote',
      icon: 'superscript',
      group: 'Insert',
      keywords: 'note reference citation',
      run: () => chain().insertFootnote().run(),
      ...edits()
    },
    // No key: ⌘K is the Command Center's, everywhere in the app.
    { id: 'doc-insert-link', label: 'Insert link', shortLabel: 'Link', icon: 'link', group: 'Insert', keywords: 'url hyperlink', run: () => void insertLink(editor), ...edits() },
    {
      id: 'doc-divider',
      label: 'Insert horizontal line',
      shortLabel: 'Horizontal line',
      icon: 'horizontal_rule',
      group: 'Insert',
      keywords: 'horizontal rule separator divider',
      run: () => chain().setHorizontalRule().run(),
      ...edits()
    },
    // The ribbon's shorter wording is the one the other three office apps'
    // ribbons use, and their specs hold them to it; the menus and the palette
    // take the lexicon label.
    sharedCommand('doc-insert-snippet', 'insertSnippet', d.insertSnippet, { barLabel: 'Saved snippet…', group: 'Insert', keywords: 'saved reusable component template', ...edits() }),
    sharedCommand('doc-insert-widget', 'workWidgetFromDesk', d.insertWidget, { icon: 'widgets', group: 'Insert', keywords: 'embed desk canvas', ...edits() }),
    { id: 'doc-insert-doc', label: 'Insert office file', icon: 'description', group: 'Insert', keywords: 'embed document sheet slides plexioffice', run: d.insertDoc, ...edits() },

    // ── View ───────────────────────────────────────────────────────────────
    { id: 'doc-page-paged', label: 'Page view', icon: 'description', group: 'View', keywords: 'print layout paper', checked: () => d.pageView, run: () => d.setPageView(true) },
    { id: 'doc-page-continuous', label: 'Continuous view', icon: 'notes', group: 'View', keywords: 'scroll flowing', checked: () => !d.pageView, run: () => d.setPageView(false) },
    // The palette's toggle. It is the same single setter, so the three can
    // never disagree about what page view is.
    { id: 'doc-pageview', label: 'Toggle page view', icon: 'description', group: 'View', keywords: 'page continuous print layout paper', run: () => d.setPageView(!d.pageView) },
    { id: 'doc-outline', label: 'Show outline', icon: 'format_list_bulleted', group: 'View', keywords: 'navigation headings map toggle', run: d.outline },
    { id: 'doc-comments', label: 'Show comments', icon: 'comment', group: 'View', keywords: 'notes replies threads', run: d.comments },
    { id: 'doc-focus', label: 'Focus mode', icon: 'fullscreen', group: 'View', keywords: 'zen distraction free writing', run: d.focusMode },
    { id: 'doc-portrait', label: 'Page orientation: portrait', icon: 'crop_portrait', group: 'View', keywords: 'orientation vertical tall', run: d.setPortrait, ...edits() },
    { id: 'doc-landscape', label: 'Page orientation: landscape', icon: 'crop_landscape', group: 'View', keywords: 'orientation horizontal wide', run: d.setLandscape, ...edits() },

    // ── Tools ──────────────────────────────────────────────────────────────
    { id: 'doc-wordcount', label: 'Word count', icon: 'tag', group: 'Tools', keywords: 'words characters length', run: () => d.dialog('wordcount') },
    // "Check accessibility" (the ribbon said "Accessibility check").
    { id: 'doc-a11y', label: 'Check accessibility', icon: 'accessibility_new', group: 'Tools', keywords: 'a11y contrast alt text headings', run: () => d.dialog('a11y') },

    // ── AI ─────────────────────────────────────────────────────────────────
    { id: 'doc-ai-draft', label: 'Draft with AI', icon: 'auto_awesome', group: 'AI', keywords: 'generate write', run: d.draftAi, ...edits() },
    { id: 'doc-ai-rewrite', label: 'Rewrite selection with AI', icon: 'auto_awesome', group: 'AI', keywords: 'improve tone', run: d.rewriteAi, ...edits() },

    // ── File: import and download ──────────────────────────────────────────
    { id: 'doc-import-docx', label: 'Import Word (.docx)', icon: 'upload_file', group: 'File', keywords: 'open word', run: d.importDocx, ...edits() },
    { id: 'doc-export-docx', label: 'Download Word (.docx)…', shortLabel: 'Microsoft Word (.docx)', icon: 'description', group: 'File', keywords: 'save export word docx', run: d.exportDocx },
    { id: 'doc-export-pdf', label: 'Download PDF…', shortLabel: 'PDF document (.pdf)', icon: 'picture_as_pdf', group: 'File', keywords: 'save export pdf', run: d.exportPdf },
    // Reachable from the palette for the first time; it was a Download ▸ row only.
    { id: 'doc-export-html', label: 'Download web page (.html)…', shortLabel: 'Web page (.html)', icon: 'html', group: 'File', keywords: 'save export html web page', run: () => void exportHtml() },

    // ── Help ───────────────────────────────────────────────────────────────
    sharedCommand('doc-shortcuts', 'keyboardShortcuts', d.shortcuts, { icon: 'keyboard', group: 'Help' })
  ]

  const map: WriteCommands = {}
  for (const c of cs) {
    if (map[c.id]) throw new Error(`buildWriteCommands: duplicate id "${c.id}"`)
    map[c.id] = c
  }
  return map
}
