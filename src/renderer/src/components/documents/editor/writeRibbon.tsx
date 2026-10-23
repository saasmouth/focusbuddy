import type { Editor } from '@tiptap/react'
import {
  BarButton,
  BarColor,
  BarCustom,
  BarFontSize,
  BarSelect,
  BarSep,
  BarToggle,
  shellPanelDomId,
  SIDE_PANE_DOM_ID,
  railGroup,
  type BarTab,
  type RailItem
} from '../../office/shell'
import FontPicker from './FontPicker'
import { barProps, type OfficeCommand } from '../../../lib/menus/officeCommand'
import type { WriteCommands } from './writeCommands'
import { caretFontSize } from './fontSize'
import type { HeadingStyle, HeadingStyles, PageOrientation, PaperSize } from './headingStyles'

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

/** The live editor state every tab reads. Built once per render by DocEditor. */
export interface WCtx {
  editor: Editor
  /**
   * PlexiiWrite's command registry (writeCommands.ts). Every control here that
   * also exists in the menu bar or the Cmd+K palette renders from it through
   * `cmdToggle` / `cmdButton`, so the three surfaces cannot drift — they had,
   * in six places: "Align center" vs "Align centre", "Bullet list" vs
   * "Bulleted list", "Divider" vs "Horizontal line", "Accessibility check" vs
   * "Check accessibility", two snippet rows missing their ellipsis, and a Link
   * button advertising ⌘K, which belongs to the Command Center.
   */
  commands: WriteCommands
  readOnly: boolean
  /** Friendly name of the block the cursor is in — "Normal", "Title", "Heading 2"… */
  styleLabel: string
  headingStyles: HeadingStyles
  setHeadingStyle: (level: number, patch: Partial<HeadingStyle>) => void
  wordCount: number
  // Page setup
  pageView: boolean
  setPageView: (v: boolean) => void
  orientation: PageOrientation
  paperSize: PaperSize
  setPageSetup: (patch: { orientation?: PageOrientation; size?: PaperSize }) => void
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
  // Host-owned flows. Insert image, Insert work widget, the two snippet flows,
  // Word count, the accessibility check, Import, the three Downloads and Focus
  // mode are NOT here: the registry carries them, with their labels and their
  // view-only state, so the ribbon no longer takes nine callbacks it only
  // forwarded. The save-snippet body in particular existed three times in
  // DocEditor because this prop was one of the three.
  openLink: () => void
  askAi: () => void
  /**
   * PlexiiAssist — the ONE assistant. With a global assistant present this
   * opens that overlay, contextual to this document; without one it opens the
   * side pane's AI tab. Distinct from askAi, which is the in-document draft
   * and rewrite panel.
   */
  openAssistant: () => void
}

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 30, 36]

const LINE_HEIGHTS = [
  { value: '', label: 'Spacing' },
  { value: '1', label: 'Single' },
  { value: '1.15', label: '1.15' },
  { value: '1.5', label: '1.5' },
  { value: '2', label: 'Double' }
]


/**
 * Write's colour controls were `<input type="color">` swatches with no preset
 * palette, so there is no document theme to read one from. These are the
 * swatches BarColor offers; the native picker is still one click further in.
 */
const TEXT_PALETTE = ['#111827', '#374151', '#6b7280', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e', '#1d4ed8', '#6d28d9', '#be185d']
const HIGHLIGHT_PALETTE = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff', '#e5e7eb']

const chain = (c: WCtx): ReturnType<Editor['chain']> => c.editor.chain().focus()

/** A registry command by id. A missing id is a programming error, not a blank button. */
function cmd(c: WCtx, id: string): OfficeCommand {
  const found = c.commands[id]
  if (!found) throw new Error(`writeRibbon: no command "${id}" in the registry`)
  return found
}

/**
 * `readOnlySafe` is derived, not declared: a command that carries no `enabled`
 * gate is one that changes nothing in the document, which is exactly what the
 * shell means by read-only safe. So the registry decides a viewer's ribbon too,
 * and a control cannot be live in the ribbon while its menu row is greyed out.
 */
const safe = (k: OfficeCommand): { readOnlySafe?: true } => (k.enabled ? {} : { readOnlySafe: true })

/** A ribbon toggle rendered from the registry: label, hint, icon, state and run all from the one definition. */
function cmdToggle(c: WCtx, id: string, extra: Partial<Parameters<typeof BarToggle>[0]> = {}): JSX.Element {
  const k = cmd(c, id)
  return <BarToggle {...barProps(k)} {...safe(k)} pressed={!!k.checked?.()} onChange={k.run} {...extra} />
}

/** A ribbon button rendered from the registry. */
function cmdButton(c: WCtx, id: string, extra: Partial<Parameters<typeof BarButton>[0]> = {}): JSX.Element {
  const k = cmd(c, id)
  return <BarButton {...barProps(k)} {...safe(k)} onClick={k.run} {...extra} />
}

// ── Home ─────────────────────────────────────────────────────────────────────

const homeTab: BarTab<WCtx> = {
  id: 'home',
  label: 'Home',
  role: 'home',
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
        <BarCustom label="Font" semantic="font-family">
          <FontPicker
            value={(editor.getAttributes('textStyle').fontFamily as string) ?? ''}
            onChange={(v) => (v ? chain(c).setFontFamily(v).run() : chain(c).unsetFontFamily().run())}
          />
        </BarCustom>
        <BarFontSize
          value={fontSize ? Number(fontSize) : undefined}
          fallback={caretFontSize(editor)}
          presets={FONT_SIZES}
          onChange={(v) => chain(c).setFontSize(`${v}px`).run()}
          onClear={() => chain(c).unsetFontSize().run()}
        />
        <BarSep />
        {cmdToggle(c, 'doc-bold', { semantic: 'bold' })}
        {cmdToggle(c, 'doc-italic', { semantic: 'italic' })}
        {cmdToggle(c, 'doc-underline', { semantic: 'underline' })}
        {cmdToggle(c, 'doc-strike')}
        {cmdToggle(c, 'doc-code')}
        <BarToggle icon="subscript" label="Subscript" pressed={editor.isActive('subscript')} onChange={() => chain(c).toggleSubscript().run()} />
        <BarToggle icon="superscript" label="Superscript" pressed={editor.isActive('superscript')} onChange={() => chain(c).toggleSuperscript().run()} />
        <BarSep />
        <BarColor
          icon="format_color_text"
          semantic="text-color"
          label="Text colour"
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
        {cmdToggle(c, 'doc-align-left', { semantic: 'align-left' })}
        {cmdToggle(c, 'doc-align-center', { semantic: 'align-center' })}
        {cmdToggle(c, 'doc-align-right', { semantic: 'align-right' })}
        {cmdToggle(c, 'doc-align-justify')}
        <BarSelect label="Line spacing" width={78} value={lineHeight} options={LINE_HEIGHTS} onChange={(v) => chain(c).setLineHeight(v).run()} />
        <BarSep />
        {cmdToggle(c, 'doc-bullets')}
        {cmdToggle(c, 'doc-numbers')}
        {cmdToggle(c, 'doc-checklist')}
        <BarSep />
        {cmdButton(c, 'doc-clear-format')}
      </>
    )
  }
}

// ── Insert ───────────────────────────────────────────────────────────────────

const insertTab: BarTab<WCtx> = {
  id: 'insert',
  label: 'Insert',
  role: 'insert',
  render: (c) => (
    <>
      {/* No ⌘K hint: that key is the Command Center's, everywhere in the app. */}
      {cmdToggle(c, 'doc-insert-link', { pressed: c.editor.isActive('link'), onChange: c.openLink })}
      {cmdButton(c, 'doc-insert-image')}
      {cmdButton(c, 'doc-insert-table')}
      {cmdButton(c, 'doc-divider')}
      <BarSep />
      {cmdButton(c, 'doc-insert-widget')}
      <BarSep />
      {/* Saved snippets: insert one from the library, or keep the selection as
          a new one. Both open a React dialog the host owns, so they are ctx
          callbacks rather than editor commands. */}
      {cmdButton(c, 'doc-insert-snippet', { testid: 'doc-insert-snippet' })}
      {cmdButton(c, 'doc-save-snippet', { testid: 'doc-save-snippet' })}
      <BarSep />
      <BarButton icon="web_asset" label="Header & footer" onClick={() => c.togglePanel('headerfooter')} controls={shellPanelDomId('headerfooter')} testid="doc-headerfooter-btn" />
    </>
  )
}

// ── Layout ───────────────────────────────────────────────────────────────────

const layoutTab: BarTab<WCtx> = {
  id: 'layout',
  label: 'Layout',
  role: 'layout',
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
  role: 'review',
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
      {cmdButton(c, 'doc-wordcount', { showLabel: true })}
      {cmdButton(c, 'doc-a11y')}
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
 * Write's rail, in the one order every app shares (SPEC §3.9): Write has no
 * drawing tools, so it starts at Insert (Image first), then its app action,
 * then the overlay panels and the two AI entries pinned to the bottom with
 * PlexiiAssist last. Each insert runs the same editor command its Insert-tab
 * button runs.
 */
export function writeRailItems(): RailItem<WCtx>[] {
  // No Find item: the ContextBar's right slot carries Find & replace and is
  // visible on every tab, so a rail copy only duplicates the accessible name —
  // DE-1 looks that control up by name and a second one is a strict-mode
  // violation. Write had exactly one find button before the conversion.
  return [
    { id: 'image', label: 'Insert image', icon: 'image', kind: 'action', role: 'image', group: railGroup('image'), order: 0, onSelect: (c) => cmd(c, 'doc-insert-image').run(), testid: 'doc-rail-image' },
    {
      id: 'table',
      label: 'Insert table',
      icon: 'grid_on',
      kind: 'action',
      role: 'insert',
      group: railGroup('insert'),
      order: 1,
      onSelect: (c) => chain(c).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      testid: 'doc-rail-table'
    },
    { id: 'link', label: 'Insert link', icon: 'link', kind: 'action', role: 'insert', group: railGroup('insert'), order: 2, onSelect: (c) => c.openLink(), testid: 'doc-rail-link' },
    { id: 'divider', label: 'Divider', icon: 'horizontal_rule', kind: 'action', role: 'insert', group: railGroup('insert'), order: 3, onSelect: (c) => chain(c).setHorizontalRule().run(), testid: 'doc-rail-divider' },
    { id: 'widget', label: 'Insert work widget', icon: 'widgets', kind: 'action', role: 'insert', group: railGroup('insert'), order: 4, onSelect: (c) => cmd(c, 'doc-insert-widget').run(), testid: 'doc-rail-widget' },
    {
      id: 'focus',
      label: 'Focus mode',
      icon: 'center_focus_strong',
      kind: 'action',
      role: 'app',
      group: railGroup('app'),
      order: 0,
      readOnlySafe: true,
      onSelect: (c) => cmd(c, 'doc-focus').run(),
      testid: 'doc-focus-toggle'
    },
    // The overlay panels, pinned to the bottom like every app's.
    { id: 'styles', label: 'Styles', icon: 'format_size', kind: 'panel', role: 'panel', group: railGroup('panel'), order: 0, pinned: 'bottom', onSelect: (c) => c.togglePanel('styles'), testid: 'doc-toggle-styles' },
    { id: 'headerfooter', label: 'Header and footer', icon: 'description', kind: 'panel', role: 'panel', group: railGroup('panel'), order: 1, pinned: 'bottom', onSelect: (c) => c.togglePanel('headerfooter'), testid: 'doc-toggle-headerfooter' },
    { id: 'margins', label: 'Margins', icon: 'straighten', kind: 'panel', role: 'panel', group: railGroup('panel'), order: 2, pinned: 'bottom', hidden: (c) => !c.pageView, onSelect: (c) => c.togglePanel('margins'), testid: 'doc-toggle-margins' },
    // The Office files list is an overlay panel (doc-panel-office), so it is a
    // panel item: pressed while open, aria-controls pointing at it.
    {
      id: 'office',
      label: 'Open or export Office files',
      icon: 'folder_open',
      kind: 'panel',
      role: 'panel',
      group: railGroup('panel'),
      order: 3,
      pinned: 'bottom',
      readOnlySafe: true,
      onSelect: (c) => c.togglePanel('office'),
      testid: 'doc-rail-office'
    },
    // Two AI entries, both at the bottom: Ask AI is the in-document draft and
    // rewrite panel; PlexiiAssist, the one assistant, is last.
    { id: 'draft', label: 'Ask AI', icon: 'edit_note', kind: 'action', role: 'ai', group: railGroup('ai'), order: 0, pinned: 'bottom', onSelect: (c) => c.askAi() },
    {
      // doc-assistant-toggle belongs to PlexiiAssist, not to the draft panel:
      // docAssistantConsolidation clicks it and expects the one global overlay.
      id: 'assistant',
      label: 'Show PlexiiAssist',
      icon: 'auto_awesome',
      kind: 'action',
      role: 'ai',
      group: railGroup('ai'),
      order: 1,
      pinned: 'bottom',
      onSelect: (c) => c.openAssistant(),
      testid: 'doc-assistant-toggle'
    }
  ]
}

/** The Office import/export menu, shown from the rail's Office action. */
/**
 * The Office panel's rows, from the registry. They were a fourth copy of these
 * labels, and had drifted: "Export Word (.docx)" and "Export PDF" here against
 * the palette's "Download Word (.docx)…" and the menu's Download ▸ rows. Web
 * page (.html) joins them, because Download ▸ has always offered it.
 */
export function officeMenuItems(c: WCtx): { label: string; icon: string; run: () => void }[] {
  return ['doc-import-docx', 'doc-export-docx', 'doc-export-pdf', 'doc-export-html'].map((id) => {
    const k = cmd(c, id)
    return { label: k.label, icon: k.icon ?? '', run: k.run }
  })
}
