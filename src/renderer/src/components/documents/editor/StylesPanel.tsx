import type { Editor } from '@tiptap/react'
import Icon from '../../Icon'
import type { HeadingStyle, HeadingStyles } from './headingStyles'

// The Styles panel: apply a paragraph style (Normal / Title / Heading 1-5,
// lists, quote, code, link) and define what each heading level looks like.
// Title maps to H1 and Heading 1-5 to H2-H6. Clicking a name applies it;
// editing a row's size / colour / bold / italic restyles every heading of that
// level at once, through DocEditor's scoped CSS.
//
// This is panel CONTENT only. It used to be an absolutely-positioned popover
// inside Toolbar.tsx that closed itself on an outside mousedown; on the office
// shell it is hosted in a ShellPanel, which owns its placement, its Escape key
// and its outside-press close. It keeps `doc-styles-panel` and the
// `doc-style-row-*` ids so the existing doc specs address the same things.

export interface StylesPanelProps {
  editor: Editor
  /** The heading level the cursor is in, or null for body text. */
  currentHeadingLevel: number | null
  headingStyles: HeadingStyles
  onApplyLevel: (level: number) => void
  onSet: (level: number, patch: Partial<HeadingStyle>) => void
  onOpenLink: () => void
}

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
const numCls = 'fb-field w-11 px-1 py-0.5 text-[11px]'

export default function StylesPanel({
  editor,
  currentHeadingLevel,
  headingStyles,
  onApplyLevel,
  onSet,
  onOpenLink
}: StylesPanelProps): JSX.Element {
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

  const normalActive =
    currentHeadingLevel === null &&
    !editor.isActive('blockquote') &&
    !editor.isActive('codeBlock') &&
    !editor.isActive('bulletList') &&
    !editor.isActive('orderedList')

  return (
    <div data-testid="doc-styles-panel" className="font-normal">
      {applyRow(normalActive, 'Normal text', 'notes', () => onApplyLevel(0), 'doc-style-row-0')}
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
