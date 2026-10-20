// The document formatting toolbar. Grouped like Word: history, block type, font,
// inline marks, colour, paragraph alignment/spacing, lists, insert, and tools.
// It re-renders on every editor transaction so active states stay accurate, and
// delegates the heavier flows (link, image, find, AI, Office files) to callbacks
// owned by DocEditor.

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import Icon from '../../Icon'
import LinkPopover from './LinkPopover'
import FontPicker from './FontPicker'
import type { HeadingStyle, HeadingStyles } from './headingStyles'

interface Props {
  editor: Editor
  headingStyles: HeadingStyles
  onSetHeadingStyle: (level: number, patch: Partial<HeadingStyle>) => void
  onAskAi: () => void
  onToggleFind: () => void
  onInsertImage: () => void
  onImportDocx: () => void
  onExportDocx: () => void
  onExportPdf: () => void
}

const FONT_SIZES = ['12', '14', '16', '18', '20', '24', '30', '36']
const LINE_HEIGHTS = [
  { label: 'Single', value: '1' },
  { label: '1.15', value: '1.15' },
  { label: '1.5', value: '1.5' },
  { label: 'Double', value: '2' }
]

export default function Toolbar({
  editor,
  headingStyles,
  onSetHeadingStyle,
  onAskAi,
  onToggleFind,
  onInsertImage,
  onImportDocx,
  onExportDocx,
  onExportPdf
}: Props): JSX.Element {
  const [headingStyleOpen, setHeadingStyleOpen] = useState(false)
  // Force a re-render on every transaction so isActive() reflects the cursor.
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1)
    editor.on('transaction', bump)
    return () => {
      editor.off('transaction', bump)
    }
  }, [editor])

  const [linkOpen, setLinkOpen] = useState(false)
  const [officeOpen, setOfficeOpen] = useState(false)
  const officeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (!officeRef.current?.contains(e.target as Node)) setOfficeOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const btn = (active: boolean): string =>
    `h-7 min-w-7 px-1 inline-flex items-center justify-center rounded text-[13px] ${
      active
        ? 'bg-accent/15 text-accent'
        : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
    }`
  const Divider = (): JSX.Element => <div className="w-px h-5 bg-[var(--edge-soft)] mx-0.5" />

  // Which heading level (if any) the cursor is in, for the heading-style control.
  const currentHeadingLevel =
    [1, 2, 3, 4, 5, 6].find((lvl) => editor.isActive('heading', { level: lvl })) ?? null

  // Friendly label of the current block style, shown on the Styles dropdown.
  const styleLabel = editor.isActive('bulletList')
    ? 'Bulleted'
    : editor.isActive('orderedList')
      ? 'Numbered'
      : editor.isActive('taskList')
        ? 'Checklist'
        : editor.isActive('codeBlock')
          ? 'Code'
          : editor.isActive('blockquote')
            ? 'Quote'
            : currentHeadingLevel === 1
              ? 'Title'
              : currentHeadingLevel
                ? `Heading ${currentHeadingLevel - 1}`
                : 'Normal'

  const wordCount = editor.storage.characterCount?.words?.() ?? 0

  const sel = 'fb-field h-7 text-[11px] px-1 text-[var(--ink-70)]'

  // No sticky, background or blur of its own any more: DocEditor pins the whole
  // chrome block, and this row pinning separately is exactly what made the menu
  // bar above it scroll away while the formatting row stayed behind. mb-4
  // became mb-1 for the same reason the block went full width — the chrome was
  // eating vertical space the document needed.
  return (
    <div
      data-testid="doc-toolbar"
      className="py-1 mb-1 flex items-center gap-0.5 flex-wrap border-b border-[color-mix(in_oklab,var(--edge-soft)_70%,transparent)]"
    >
      <button className={btn(false)} title="Undo" onClick={() => editor.chain().focus().undo().run()}>
        <Icon name="undo" size={15} />
      </button>
      <button className={btn(false)} title="Redo" onClick={() => editor.chain().focus().redo().run()}>
        <Icon name="redo" size={15} />
      </button>
      <Divider />

      {/* One comprehensive Styles dropdown replaces the block-type select: it
          applies Plain text, Title, Headings 1-6, Quote, Code, bulleted and
          numbered lists and links, and lets each heading level's named style be
          customised in place (editing a level updates every heading of it). */}
      <div className="relative">
        <button
          className={btn(headingStyleOpen) + ' px-2'}
          title="Styles — apply and customise paragraph styles"
          data-testid="doc-styles-btn"
          onClick={() => setHeadingStyleOpen((v) => !v)}
        >
          <Icon name="format_size" size={15} />
          <span className="mx-1 text-[12px] w-16 text-left truncate">{styleLabel}</span>
          <Icon name="expand_more" size={13} />
        </button>
        {headingStyleOpen && (
          <StylesPanel
            editor={editor}
            currentHeadingLevel={currentHeadingLevel}
            headingStyles={headingStyles}
            onApplyLevel={(lvl) => {
              if (lvl === 0) editor.chain().focus().setParagraph().run()
              else editor.chain().focus().setHeading({ level: lvl as 1 | 2 | 3 | 4 | 5 | 6 }).run()
            }}
            onSet={onSetHeadingStyle}
            onOpenLink={() => {
              setHeadingStyleOpen(false)
              setLinkOpen(true)
            }}
            onClose={() => setHeadingStyleOpen(false)}
          />
        )}
      </div>

      <FontPicker
        value={(editor.getAttributes('textStyle').fontFamily as string) ?? ''}
        onChange={(v) => {
          if (v) editor.chain().focus().setFontFamily(v).run()
          else editor.chain().focus().unsetFontFamily().run()
        }}
      />

      <select
        className={`${sel} w-12`}
        title="Font size"
        value={((editor.getAttributes('textStyle').fontSize as string) ?? '').replace('px', '')}
        onChange={(e) => {
          const v = e.target.value
          if (v) editor.chain().focus().setFontSize(`${v}px`).run()
          else editor.chain().focus().unsetFontSize().run()
        }}
      >
        <option value="">Size</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Divider />

      <button className={btn(editor.isActive('bold'))} title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>
        <Icon name="format_bold" size={15} />
      </button>
      <button className={btn(editor.isActive('italic'))} title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Icon name="format_italic" size={15} />
      </button>
      <button className={btn(editor.isActive('underline'))} title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Icon name="format_underlined" size={15} />
      </button>
      <button className={btn(editor.isActive('strike'))} title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Icon name="strikethrough_s" size={15} />
      </button>
      <button className={btn(editor.isActive('code'))} title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()}>
        <Icon name="code" size={15} />
      </button>
      <button className={btn(editor.isActive('subscript'))} title="Subscript" onClick={() => editor.chain().focus().toggleSubscript().run()}>
        <Icon name="subscript" size={15} />
      </button>
      <button className={btn(editor.isActive('superscript'))} title="Superscript" onClick={() => editor.chain().focus().toggleSuperscript().run()}>
        <Icon name="superscript" size={15} />
      </button>
      <Divider />

      <label className={btn(false) + ' relative cursor-pointer'} title="Text color">
        <Icon name="format_color_text" size={15} />
        <input
          type="color"
          className="absolute inset-0 opacity-0 cursor-pointer"
          onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
        />
      </label>
      <label className={btn(false) + ' relative cursor-pointer'} title="Highlight">
        <Icon name="format_ink_highlighter" size={15} />
        <input
          type="color"
          className="absolute inset-0 opacity-0 cursor-pointer"
          onChange={(e) => editor.chain().focus().toggleHighlight({ color: e.target.value }).run()}
        />
      </label>
      <Divider />

      <button className={btn(editor.isActive({ textAlign: 'left' }))} title="Align left" onClick={() => editor.chain().focus().setTextAlign('left').run()}>
        <Icon name="format_align_left" size={15} />
      </button>
      <button className={btn(editor.isActive({ textAlign: 'center' }))} title="Align center" onClick={() => editor.chain().focus().setTextAlign('center').run()}>
        <Icon name="format_align_center" size={15} />
      </button>
      <button className={btn(editor.isActive({ textAlign: 'right' }))} title="Align right" onClick={() => editor.chain().focus().setTextAlign('right').run()}>
        <Icon name="format_align_right" size={15} />
      </button>
      <button className={btn(editor.isActive({ textAlign: 'justify' }))} title="Justify" onClick={() => editor.chain().focus().setTextAlign('justify').run()}>
        <Icon name="format_align_justify" size={15} />
      </button>
      <select
        className={`${sel} w-16`}
        title="Line spacing"
        value={(editor.getAttributes('paragraph').lineHeight as string) ?? ''}
        onChange={(e) => editor.chain().focus().setLineHeight(e.target.value).run()}
      >
        <option value="">Spacing</option>
        {LINE_HEIGHTS.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      <Divider />

      <button className={btn(editor.isActive('bulletList'))} title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <Icon name="format_list_bulleted" size={15} />
      </button>
      <button className={btn(editor.isActive('orderedList'))} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <Icon name="format_list_numbered" size={15} />
      </button>
      <button className={btn(editor.isActive('taskList'))} title="Checklist" onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <Icon name="checklist" size={15} />
      </button>
      <Divider />

      <div className="relative inline-flex">
        <button className={btn(editor.isActive('link'))} title="Link" onClick={() => setLinkOpen((v) => !v)}>
          <Icon name="link" size={15} />
        </button>
        {linkOpen && <LinkPopover editor={editor} onClose={() => setLinkOpen(false)} />}
      </div>
      <button className={btn(false)} title="Insert image" onClick={onInsertImage}>
        <Icon name="image" size={15} />
      </button>
      <button
        className={btn(false)}
        title="Insert table"
        onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Icon name="grid_on" size={15} />
      </button>
      <button className={btn(false)} title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        <Icon name="horizontal_rule" size={15} />
      </button>
      <button
        className={btn(false)}
        title="Clear formatting"
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        <Icon name="format_clear" size={15} />
      </button>
      <button className={btn(false)} title="Find & replace" onClick={onToggleFind}>
        <Icon name="search" size={15} />
      </button>

      {/* Table operations appear only when the cursor is inside a table. */}
      {editor.isActive('table') && (
        <>
          <Divider />
          <button className={btn(false)} title="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}>
            <Icon name="add_row_below" size={15} />
          </button>
          <button className={btn(false)} title="Add column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            <Icon name="add_column_right" size={15} />
          </button>
          <button className={btn(false)} title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
            <Icon name="delete" size={15} />
          </button>
          <button className={btn(false)} title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
            <Icon name="grid_off" size={15} />
          </button>
        </>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[11px] text-[var(--ink-40)] tabular-nums">{wordCount} words</span>
        <div ref={officeRef} className="relative">
          <button className={btn(officeOpen)} title="Open or export Office files" onClick={() => setOfficeOpen((v) => !v)}>
            <Icon name="folder_open" size={15} />
          </button>
          {officeOpen && (
            <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 z-50 mt-1 w-48 py-1 text-[12px]">
              <button onClick={() => { setOfficeOpen(false); onImportDocx() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)]">
                <Icon name="upload_file" size={14} className="text-[var(--ink-40)]" /> Import Word (.docx)
              </button>
              <button onClick={() => { setOfficeOpen(false); onExportDocx() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)]">
                <Icon name="description" size={14} className="text-[var(--ink-40)]" /> Export Word (.docx)
              </button>
              <button onClick={() => { setOfficeOpen(false); onExportPdf() }} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-sunken)]">
                <Icon name="picture_as_pdf" size={14} className="text-[var(--ink-40)]" /> Export PDF
              </button>
            </div>
          )}
        </div>
        <button
          onClick={onAskAi}
          className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg bg-accent/10 text-accent hover:bg-accent/20"
        >
          <Icon name="auto_awesome" size={13} /> Ask AI
        </button>
      </div>
    </div>
  )
}

// Popover to edit one heading level's named style (size, colour, bold). Changes
// The Styles panel: apply a paragraph style (Normal / Heading 1-3) and define
// The Styles dropdown: one comprehensive list to apply a paragraph style and to
// customise each heading level. Title maps to H1 and Heading 1-5 to H2-H6.
// Clicking a name applies it; editing a heading row's size / colour / bold /
// italic updates every heading of that level at once via DocEditor's CSS.
function StylesPanel({
  editor,
  currentHeadingLevel,
  headingStyles,
  onApplyLevel,
  onSet,
  onOpenLink,
  onClose
}: {
  editor: Editor
  currentHeadingLevel: number | null
  headingStyles: HeadingStyles
  onApplyLevel: (level: number) => void
  onSet: (level: number, patch: Partial<HeadingStyle>) => void
  onOpenLink: () => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  // Title = H1, Heading 1..5 = H2..H6.
  const HEADINGS: Array<{ label: string; level: number; preview: number }> = [
    { label: 'Title', level: 1, preview: 28 },
    { label: 'Heading 1', level: 2, preview: 24 },
    { label: 'Heading 2', level: 3, preview: 21 },
    { label: 'Heading 3', level: 4, preview: 18 },
    { label: 'Heading 4', level: 5, preview: 16 },
    { label: 'Heading 5', level: 6, preview: 14 }
  ]

  const tiny = 'h-6 w-6 inline-flex items-center justify-center rounded text-[12px]'
  const numCls =
    'fb-field w-11 px-1 py-0.5 text-[11px]'

  function applyRow(active: boolean, label: string, icon: string, onClick: () => void, testid: string): JSX.Element {
    return (
      <button
        onClick={onClick}
        data-testid={testid}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[13px] ${
          active ? 'bg-accent/10 text-accent' : 'hover:bg-[var(--surface-sunken)]'
        }`}
      >
        <Icon name={icon} size={14} className="text-[var(--ink-40)]" />
        {label}
      </button>
    )
  }

  function headingRow(h: { label: string; level: number; preview: number }): JSX.Element {
    const s: HeadingStyle = headingStyles[h.level] ?? {}
    const active = currentHeadingLevel === h.level
    return (
      <div
        key={h.level}
        data-testid={`doc-style-row-${h.level}`}
        className={`flex items-center gap-1 px-2 py-1 rounded ${active ? 'bg-accent/10' : 'hover:bg-[var(--surface-sunken)]'}`}
      >
        <button
          onClick={() => onApplyLevel(h.level)}
          className="flex-1 min-w-0 text-left truncate"
          title={`Apply ${h.label}`}
          style={{ fontSize: Math.min(h.preview, 18), fontWeight: s.bold ?? true ? 700 : 600, fontStyle: s.italic ? 'italic' : undefined, color: s.color }}
        >
          {h.label}
        </button>
        <button className={`${tiny} ${s.bold ? 'bg-accent/15 text-accent' : 'text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]'}`} title="Bold" onClick={() => onSet(h.level, { bold: !s.bold })}>
          <Icon name="format_bold" size={13} />
        </button>
        <button className={`${tiny} ${s.italic ? 'bg-accent/15 text-accent' : 'text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]'}`} title="Italic" onClick={() => onSet(h.level, { italic: !s.italic })}>
          <Icon name="format_italic" size={13} />
        </button>
        <input type="number" min={10} max={96} value={s.fontSize ?? ''} placeholder={String(h.preview)} title="Size" onChange={(e) => onSet(h.level, { fontSize: e.target.value === '' ? undefined : Number(e.target.value) })} className={numCls} />
        <input type="color" value={s.color ?? '#1c1917'} title="Colour" onChange={(e) => onSet(h.level, { color: e.target.value })} className="fb-field h-6 w-6 cursor-pointer p-0" />
      </div>
    )
  }

  return (
    <div
      ref={ref}
      data-testid="doc-styles-panel"
      className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in absolute z-50 mt-1 left-0 w-[340px] max-h-[70vh] overflow-auto p-2 font-normal"
    >
      {applyRow(currentHeadingLevel === null && !editor.isActive('blockquote') && !editor.isActive('codeBlock') && !editor.isActive('bulletList') && !editor.isActive('orderedList'), 'Normal text', 'notes', () => onApplyLevel(0), 'doc-style-row-0')}
      <div className="my-1 border-t border-[var(--edge-soft)]" />
      {HEADINGS.map(headingRow)}
      <div className="my-1 border-t border-[var(--edge-soft)]" />
      {applyRow(editor.isActive('bulletList'), 'Bulleted list', 'format_list_bulleted', () => editor.chain().focus().toggleBulletList().run(), 'doc-style-bullet')}
      {applyRow(editor.isActive('orderedList'), 'Numbered list', 'format_list_numbered', () => editor.chain().focus().toggleOrderedList().run(), 'doc-style-ordered')}
      {applyRow(editor.isActive('taskList'), 'Checklist', 'checklist', () => editor.chain().focus().toggleTaskList().run(), 'doc-style-task')}
      {applyRow(editor.isActive('blockquote'), 'Quote', 'format_quote', () => editor.chain().focus().toggleBlockquote().run(), 'doc-style-quote')}
      {applyRow(editor.isActive('codeBlock'), 'Code block', 'code', () => editor.chain().focus().toggleCodeBlock().run(), 'doc-style-code')}
      {applyRow(editor.isActive('link'), 'Hyperlink', 'link', onOpenLink, 'doc-style-link')}
      <div className="text-[10px] text-[var(--ink-40)] px-2 pt-1.5 border-t border-[var(--edge-soft)] mt-1">
        Click a name to apply it. Editing a heading row updates every heading of that level.
      </div>
    </div>
  )
}
