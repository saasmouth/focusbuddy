import type { Editor } from '@tiptap/react'
import {
  BarButton,
  BarColor,
  BarCustom,
  BarSelect,
  BarSep,
  BarToggle,
  shellPanelDomId,
  SIDE_PANE_DOM_ID,
  type BarTab,
  type RailItem
} from '../../office/shell'
import FontPicker from './FontPicker'
import type { HeadingStyle, HeadingStyles } from './headingStyles'

// PlexiiWrite on the office shell (SPEC §6.2): the ToolRail items and every
// ContextBar tab. Owner ruling D1 moved the formatting row's controls into
// tabs here — nothing of Write's chrome is a right-hand inspector any more.
// The three content panes it already had (Outline, Comments, the assistant)
// stay on the right in the shared ShellSidePane (D1 as amended, §2.5a), which
// is why they are not tabs and not overlay panels.
//
// Every control keeps the testid it had in Toolbar.tsx and DocEditor.tsx, so
// the existing doc* specs go on addressing the same things. Where a control
// had no testid it gets none here: this file moves chrome, it does not widen
// the test surface.

export type WritePanel = 'styles' | 'margins' | 'headerfooter' | 'office'
export type WriteSidePane = 'outline' | 'comments' | 'ai'
export type WriteDialog = 'find' | 'wordcount' | 'a11y'

/** The live editor state every tab reads. Built once per render by DocEditor. */
export interface WCtx {
  editor: Editor
  readOnly: boolean
  /** Friendly name of the block the cursor is in — "Normal", "Title", "Heading 2"… */
  styleLabel: string
  headingStyles: HeadingStyles
  setHeadingStyle: (level: number, patch: Partial<HeadingStyle>) => void
  wordCount: number
  // Page setup
  pageView: boolean
  setPageView: (v: boolean) => void
  orientation: 'portrait' | 'landscape'
  paperSize: string
  setPageSetup: (patch: { orientation?: 'portrait' | 'landscape'; size?: string }) => void
  showRuler: boolean
  setShowRuler: (v: boolean) => void
  // Track changes
  suggesting: boolean
  setSuggesting: (v: boolean) => void
  hasTracked: boolean
  acceptAll: () => void
  rejectAll: () => void
  // Shell plumbing
  togglePanel: (p: WritePanel) => void
  isPanelOpen: (p: WritePanel) => boolean
  sidePane: WriteSidePane | null
  toggleSidePane: (p: WriteSidePane) => void
  openDialog: (d: WriteDialog) => void
  // Host-owned flows
  insertImage: () => void
  insertWidget: () => void
  openLink: () => void
  importDocx: () => void
  exportDocx: () => void
  exportPdf: () => void
  askAi: () => void
  focusMode: () => void
}

const FONT_SIZES = ['12', '14', '16', '18', '20', '24', '30', '36']

const LINE_HEIGHTS = [
  { value: '', label: 'Spacing' },
  { value: '1', label: 'Single' },
  { value: '1.15', label: '1.15' },
  { value: '1.5', label: '1.5' },
  { value: '2', label: 'Double' }
]

const PAPER_SIZES = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
  { value: 'a3', label: 'A3' },
  { value: 'a5', label: 'A5' }
]

/**
 * Write's colour controls were `<input type="color">` swatches with no preset
 * palette, so there is no document theme to read one from. These are the
 * swatches BarColor offers; the native picker is still one click further in.
 */
const TEXT_PALETTE = ['#111827', '#374151', '#6b7280', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e', '#1d4ed8', '#6d28d9', '#be185d']
const HIGHLIGHT_PALETTE = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff', '#e5e7eb']

const chain = (c: WCtx): ReturnType<Editor['chain']> => c.editor.chain().focus()

// ── Home ─────────────────────────────────────────────────────────────────────

const homeTab: BarTab<WCtx> = {
  id: 'home',
  label: 'Home',
  render: (c) => {
    const { editor } = c
    const fontSize = ((editor.getAttributes('textStyle').fontSize as string) ?? '').replace('px', '')
    const lineHeight = (editor.getAttributes('paragraph').lineHeight as string) ?? ''
    return (
      <>
        <BarButton
          icon="format_size"
          label="Styles — apply and customise paragraph styles"
          showLabel
          onClick={() => c.togglePanel('styles')}
          controls={shellPanelDomId('styles')}
          testid="doc-styles-btn"
        />
        <BarCustom label="Font">
          <FontPicker
            value={(editor.getAttributes('textStyle').fontFamily as string) ?? ''}
            onChange={(v) => (v ? chain(c).setFontFamily(v).run() : chain(c).unsetFontFamily().run())}
          />
        </BarCustom>
        <BarSelect
          label="Font size"
          width={64}
          value={fontSize}
          options={[{ value: '', label: 'Size' }, ...FONT_SIZES.map((s) => ({ value: s, label: s }))]}
          onChange={(v) => (v ? chain(c).setFontSize(`${v}px`).run() : chain(c).unsetFontSize().run())}
        />
        <BarSep />
        <BarToggle icon="format_bold" label="Bold" shortcut="⌘B" pressed={editor.isActive('bold')} onChange={() => chain(c).toggleBold().run()} />
        <BarToggle icon="format_italic" label="Italic" shortcut="⌘I" pressed={editor.isActive('italic')} onChange={() => chain(c).toggleItalic().run()} />
        <BarToggle icon="format_underlined" label="Underline" shortcut="⌘U" pressed={editor.isActive('underline')} onChange={() => chain(c).toggleUnderline().run()} />
        <BarToggle icon="strikethrough_s" label="Strikethrough" pressed={editor.isActive('strike')} onChange={() => chain(c).toggleStrike().run()} />
        <BarToggle icon="code" label="Inline code" pressed={editor.isActive('code')} onChange={() => chain(c).toggleCode().run()} />
        <BarToggle icon="subscript" label="Subscript" pressed={editor.isActive('subscript')} onChange={() => chain(c).toggleSubscript().run()} />
        <BarToggle icon="superscript" label="Superscript" pressed={editor.isActive('superscript')} onChange={() => chain(c).toggleSuperscript().run()} />
        <BarSep />
        <BarColor
          icon="format_color_text"
          label="Text color"
          value={(editor.getAttributes('textStyle').color as string) ?? undefined}
          palette={TEXT_PALETTE}
          onChange={(v) => (v ? chain(c).setColor(v).run() : chain(c).unsetColor().run())}
        />
        <BarColor
          icon="format_ink_highlighter"
          label="Highlight"
          allowNone
          value={(editor.getAttributes('highlight').color as string) ?? undefined}
          palette={HIGHLIGHT_PALETTE}
          onChange={(v) => (v ? chain(c).toggleHighlight({ color: v }).run() : chain(c).unsetHighlight().run())}
        />
        <BarSep />
        <BarToggle icon="format_align_left" label="Align left" pressed={editor.isActive({ textAlign: 'left' })} onChange={() => chain(c).setTextAlign('left').run()} />
        <BarToggle icon="format_align_center" label="Align center" pressed={editor.isActive({ textAlign: 'center' })} onChange={() => chain(c).setTextAlign('center').run()} />
        <BarToggle icon="format_align_right" label="Align right" pressed={editor.isActive({ textAlign: 'right' })} onChange={() => chain(c).setTextAlign('right').run()} />
        <BarToggle icon="format_align_justify" label="Justify" pressed={editor.isActive({ textAlign: 'justify' })} onChange={() => chain(c).setTextAlign('justify').run()} />
        <BarSelect label="Line spacing" width={78} value={lineHeight} options={LINE_HEIGHTS} onChange={(v) => chain(c).setLineHeight(v).run()} />
        <BarSep />
        <BarToggle icon="format_list_bulleted" label="Bullet list" pressed={editor.isActive('bulletList')} onChange={() => chain(c).toggleBulletList().run()} />
        <BarToggle icon="format_list_numbered" label="Numbered list" pressed={editor.isActive('orderedList')} onChange={() => chain(c).toggleOrderedList().run()} />
        <BarToggle icon="checklist" label="Checklist" pressed={editor.isActive('taskList')} onChange={() => chain(c).toggleTaskList().run()} />
        <BarSep />
        <BarButton icon="format_clear" label="Clear formatting" onClick={() => chain(c).unsetAllMarks().clearNodes().run()} />
      </>
    )
  }
}

// ── Insert ───────────────────────────────────────────────────────────────────

const insertTab: BarTab<WCtx> = {
  id: 'insert',
  label: 'Insert',
  render: (c) => (
    <>
      <BarToggle icon="link" label="Link" shortcut="⌘K" pressed={c.editor.isActive('link')} onChange={c.openLink} />
      <BarButton icon="image" label="Insert image" onClick={c.insertImage} />
      <BarButton icon="grid_on" label="Insert table" onClick={() => chain(c).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
      <BarButton icon="horizontal_rule" label="Divider" onClick={() => chain(c).setHorizontalRule().run()} />
      <BarSep />
      <BarButton icon="widgets" label="Insert work widget" onClick={c.insertWidget} />
      <BarSep />
      <BarButton icon="description" label="Header and footer" onClick={() => c.togglePanel('headerfooter')} controls={shellPanelDomId('headerfooter')} />
    </>
  )
}

// ── Layout ───────────────────────────────────────────────────────────────────

const layoutTab: BarTab<WCtx> = {
  id: 'layout',
  label: 'Layout',
  render: (c) => (
    <>
      {/*
        The Continuous / Page switch keeps its original markup, not a pair of
        BarToggles. Three specs address it as a container of text buttons
        (`[data-testid="doc-layout-toggle"] button` filtered by the words
        "Continuous" and "Page"), and doc-pageview-btn is the Page button
        inside it. An icon toggle would satisfy neither.
      */}
      <BarCustom label="View" testid="doc-layout-toggle-wrap">
        <span className="inline-flex rounded-full bg-[var(--surface-sunken)] overflow-hidden" data-testid="doc-layout-toggle">
          <button
            onClick={() => c.setPageView(false)}
            className={`px-2 py-1 text-[11px] ${!c.pageView ? 'bg-accent/10 text-accent' : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'}`}
            title="Continuous view — one flowing column"
          >
            Continuous
          </button>
          <button
            onClick={() => c.setPageView(true)}
            className={`px-2 py-1 text-[11px] ${c.pageView ? 'bg-accent/10 text-accent' : 'hover:bg-[color-mix(in_oklab,var(--surface-sunken)_70%,transparent)]'}`}
            title="Page view — paper sheets with margins"
            data-testid="doc-pageview-btn"
          >
            Page
          </button>
        </span>
      </BarCustom>
      {/*
        The page controls are RENDERED ONLY in Page view, not disabled there.
        DPS-1 asserts doc-orientation-btn is `not.toBeVisible()` back in
        Continuous, and a disabled button is still visible.
      */}
      {c.pageView && (
        <>
          <BarSep />
          <BarButton
            icon={c.orientation === 'portrait' ? 'crop_portrait' : 'crop_landscape'}
            label="Toggle portrait / landscape"
            showLabel
            onClick={() => c.setPageSetup({ orientation: c.orientation === 'portrait' ? 'landscape' : 'portrait' })}
            testid="doc-orientation-btn"
          />
          {/*
            Paper size stays a button that cycles Letter <-> A4 and shows the
            current size as its text. DPS-2 clicks it and then asserts the
            control itself contains "A4" / "Letter"; a <select> satisfies
            neither the click nor the text.
          */}
          <BarCustom label="Paper size">
            <button
              onClick={() => c.setPageSetup({ size: c.paperSize === 'letter' ? 'a4' : 'letter' })}
              className="h-7 px-2 rounded text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              title="Paper size"
              data-testid="doc-paper-btn"
            >
              {c.paperSize === 'a4' ? 'A4' : 'Letter'}
            </button>
          </BarCustom>
          <BarButton
            icon="margin"
            label="Page margins"
            showLabel
            onClick={() => c.togglePanel('margins')}
            controls={shellPanelDomId('margins')}
            testid="doc-margins-btn"
          />
          <BarToggle
            icon="straighten"
            label="Show the ruler — drag the markers to set page margins"
            showLabel
            pressed={c.showRuler}
            onChange={c.setShowRuler}
            readOnlySafe
            testid="doc-ruler-btn"
          />
        </>
      )}
    </>
  )
}

// ── Review ───────────────────────────────────────────────────────────────────

const reviewTab: BarTab<WCtx> = {
  id: 'review',
  label: 'Review',
  render: (c) => (
    <>
      <BarToggle icon="edit_note" label="Suggesting — track every change" pressed={c.suggesting} onChange={c.setSuggesting} showLabel testid="doc-suggest-toggle" />
      <BarButton icon="done_all" label="Accept all changes" disabled={!c.hasTracked} disabledReason="no tracked changes" onClick={c.acceptAll} testid="doc-accept-all" />
      <BarButton icon="close" label="Reject all changes" disabled={!c.hasTracked} disabledReason="no tracked changes" onClick={c.rejectAll} testid="doc-reject-all" />
      <BarSep />
      <BarToggle
        icon="comment"
        label="Comments"
        pressed={c.sidePane === 'comments'}
        onChange={() => c.toggleSidePane('comments')}
        controls={SIDE_PANE_DOM_ID}
        readOnlySafe
        testid="doc-comments-toggle"
      />
      <BarToggle
        icon="toc"
        label="Outline"
        pressed={c.sidePane === 'outline'}
        onChange={() => c.toggleSidePane('outline')}
        controls={SIDE_PANE_DOM_ID}
        readOnlySafe
        testid="doc-outline-toggle"
      />
      <BarSep />
      <BarButton icon="functions" label="Word count" showLabel onClick={() => c.openDialog('wordcount')} readOnlySafe />
      <BarButton icon="accessibility_new" label="Accessibility check" onClick={() => c.openDialog('a11y')} readOnlySafe />
    </>
  )
}

// ── Table (contextual, SPEC §2.3: appears with the cursor, never steals focus) ─

const tableTab: BarTab<WCtx> = {
  id: 'table',
  label: 'Table',
  contextual: true,
  when: (c) => c.editor.isActive('table'),
  render: (c) => (
    <>
      <BarButton icon="add_row_below" label="Add row below" onClick={() => chain(c).addRowAfter().run()} />
      <BarButton icon="add_column_right" label="Add column right" onClick={() => chain(c).addColumnAfter().run()} />
      <BarSep />
      <BarButton icon="delete" label="Delete row" onClick={() => chain(c).deleteRow().run()} />
      <BarButton icon="grid_off" label="Delete table" onClick={() => chain(c).deleteTable().run()} />
    </>
  )
}

export const WRITE_TABS: BarTab<WCtx>[] = [homeTab, insertTab, layoutTab, reviewTab, tableTab]

// ── Rail ─────────────────────────────────────────────────────────────────────

/**
 * Write's rail is short on purpose: it has no drawing tools, so it carries the
 * panel openers and the two file flows. Groups: panels, then files, with Ask AI
 * pinned to the bottom the way Diagrams pins its own.
 */
export function writeRailItems(): RailItem<WCtx>[] {
  return [
    {
      id: 'styles',
      label: 'Styles',
      icon: 'format_size',
      kind: 'panel',
      group: 0,
      order: 0,
      onSelect: (c) => c.togglePanel('styles'),
      testid: 'doc-toggle-styles'
    },
    {
      id: 'headerfooter',
      label: 'Header and footer',
      icon: 'description',
      kind: 'panel',
      group: 0,
      order: 1,
      onSelect: (c) => c.togglePanel('headerfooter'),
      testid: 'doc-toggle-headerfooter'
    },
    {
      id: 'margins',
      label: 'Margins',
      icon: 'straighten',
      kind: 'panel',
      group: 0,
      order: 2,
      hidden: (c) => !c.pageView,
      onSelect: (c) => c.togglePanel('margins'),
      testid: 'doc-toggle-margins'
    },
    {
      id: 'find',
      label: 'Find and replace',
      icon: 'search',
      kind: 'action',
      group: 1,
      order: 0,
      shortcut: '⌘F',
      readOnlySafe: true,
      onSelect: (c) => c.openDialog('find'),
      testid: 'doc-rail-find'
    },
    {
      id: 'office',
      label: 'Open or export Office files',
      icon: 'folder_open',
      kind: 'action',
      group: 1,
      order: 1,
      readOnlySafe: true,
      onSelect: (c) => c.togglePanel('office'),
      testid: 'doc-rail-office'
    },
    {
      id: 'focus',
      label: 'Focus mode',
      icon: 'center_focus_strong',
      kind: 'action',
      group: 1,
      order: 2,
      readOnlySafe: true,
      onSelect: (c) => c.focusMode(),
      testid: 'doc-focus-toggle'
    },
    {
      id: 'ai',
      label: 'Ask AI',
      icon: 'auto_awesome',
      kind: 'action',
      group: 2,
      order: 0,
      pinned: 'bottom',
      onSelect: (c) => c.askAi(),
      testid: 'doc-assistant-toggle'
    }
  ]
}

/** The Office import/export menu, shown from the rail's Office action. */
export function officeMenuItems(c: WCtx): { label: string; icon: string; run: () => void }[] {
  return [
    { label: 'Import Word (.docx)', icon: 'upload_file', run: c.importDocx },
    { label: 'Export Word (.docx)', icon: 'description', run: c.exportDocx },
    { label: 'Export PDF', icon: 'picture_as_pdf', run: c.exportPdf }
  ]
}
