import type { DeckTheme, Slide, SlideElement, SlideLayout, SlideTransition } from '@shared/types'
import { BUILTIN_THEMES } from '@shared/slideThemes'
import { CHART_TYPES, type ChartType } from '@shared/chart'
import {
  BarButton,
  BarColor,
  BarCustom,
  BarDialogButton,
  BarGroup,
  BarMenu,
  BarNumber,
  BarSelect,
  BarSep,
  BarToggle,
  shellPanelDomId,
  SIDE_PANE_DOM_ID,
  type BarTab,
  type RailItem
} from '../../office/shell'
import FontPicker from '../editor/FontPicker'
import type { AlignEdge } from './slideOps'

// PlexiiDeck on the office shell (SPEC §6.4): the ToolRail items and every
// ContextBar tab. Owner ruling D1 retired the right ElementInspector and the
// property half of SlidesSidePanel, so every control they had lives in a tab
// here, keeping its testid where its meaning is unchanged (§4.1). The AI half
// of the side panel is a pane in the shared right ShellSidePane; the slide
// thumbnails are the navigator (leftAside); speaker notes stay under the canvas.

/** Armed tools (D4). 'select' is the resting state. */
export type DeckTool = 'select' | 'text' | 'rect' | 'roundRect' | 'ellipse' | 'triangle' | 'line'
export type DeckPanel = 'layouts' | 'cells'
export type DeckSidePane = 'ai' | 'generate'

/** What a plain click places, in slide coordinates (the 1280×720 logical page). The sizes the old one-shot inserts used. */
export const TOOL_DEFAULT: Record<Exclude<DeckTool, 'select'>, { w: number; h: number }> = {
  text: { w: 800, h: 140 },
  rect: { w: 400, h: 240 },
  roundRect: { w: 400, h: 240 },
  ellipse: { w: 400, h: 240 },
  triangle: { w: 400, h: 240 },
  line: { w: 680, h: 0 }
}

export type ShapeKind = 'rect' | 'ellipse' | 'roundRect' | 'triangle'
type TextStyle = Partial<{ bold: boolean; italic: boolean; underline: boolean; color: string; fontSize: number }>

/** Everything the editor exposes to the bar and the rail. Built per render by SlidesEditor. */
export interface DeckCtx {
  slide: Slide
  theme: DeckTheme
  /** The selection, whole groups included. */
  selected: SlideElement[]
  /** The one selected element, or null with none or several. */
  el: SlideElement | null
  anyGrouped: boolean
  readOnly: boolean
  tool: DeckTool
  setTool: (t: DeckTool, lock?: boolean) => void
  isPanelOpen: (p: DeckPanel) => boolean
  togglePanel: (p: DeckPanel) => void
  openPanel: (p: DeckPanel) => void
  sidePane: DeckSidePane | null
  openSidePane: (p: DeckSidePane) => void
  toggleSidePane: (p: DeckSidePane) => void
  ed: {
    insertText: () => void
    insertShape: (s: ShapeKind) => void
    insertLine: () => void
    insertImage: () => void
    insertTable: () => void
    insertChart: () => void
    insertWidget: () => void
    /** Open the saved-snippets library, scoped to slide snippets, aimed at this deck. */
    insertSnippet: () => void
    /** Save the selected elements as a snippet (the dialog names it). */
    saveSnippet: () => void
    openGallery: () => void
    duplicateSlide: () => void
    applyLayout: (l: SlideLayout) => void
    applyTheme: (t: DeckTheme) => void
    setBackground: (color: string) => void
    setTransition: (t: SlideTransition) => void
    updateEl: (id: string, patch: Partial<SlideElement>) => void
    styleText: (id: string, patch: TextStyle) => void
    alignText: (id: string, align: 'left' | 'center' | 'right') => void
    setList: (id: string, style: 'bullet' | 'number' | 'none') => void
    align: (edge: AlignEdge) => void
    distribute: (axis: 'h' | 'v') => void
    centre: (axis: 'h' | 'v') => void
    group: () => void
    ungroup: () => void
    reorder: (dir: 'front' | 'back' | 'forward' | 'backmost') => void
    duplicateSelection: () => void
    deleteSelection: () => void
    crop: (id: string) => void
    linkChart: (id: string) => void
    refreshChart: (id: string) => void
    checkA11y: () => void
    focusNotes: () => void
  }
}

export const LAYOUTS: { id: SlideLayout; label: string }[] = [
  { id: 'title', label: 'Title' },
  { id: 'title-content', label: 'Title + content' },
  { id: 'two-content', label: 'Two content' },
  { id: 'section', label: 'Section' },
  { id: 'image-caption', label: 'Image + caption' },
  { id: 'blank', label: 'Blank' }
]
const LAYOUT_LABEL: Record<SlideLayout, string> = {
  title: 'Title',
  'title-content': 'Title + content',
  'two-content': 'Two content',
  section: 'Section',
  'image-caption': 'Image + caption',
  blank: 'Blank',
  bullets: 'Title + content'
}
const TRANSITIONS: { value: SlideTransition; label: string }[] = [
  { value: 'none', label: 'No transition' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'morph', label: 'Morph (tween shared objects)' }
]
const ANIMS: { value: string; label: string }[] = [
  { value: 'none', label: 'No animation' },
  { value: 'fadeIn', label: 'Fade in' },
  { value: 'slideUp', label: 'Slide up' },
  { value: 'slideLeft', label: 'Slide in' },
  { value: 'zoomIn', label: 'Zoom in' }
]
const SHADOWS: { value: 'none' | 'sm' | 'md' | 'lg'; label: string }[] = [
  { value: 'none', label: 'No shadow' },
  { value: 'sm', label: 'Shadow: subtle' },
  { value: 'md', label: 'Shadow: medium' },
  { value: 'lg', label: 'Shadow: large' }
]
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 54, 64, 72, 96]

/** The deck's palette for colour popovers: the theme's own colours first, then neutrals. */
export function deckPalette(theme: DeckTheme): string[] {
  const seen = new Set<string>()
  return [theme.accent, theme.textColor, theme.background, theme.titleStyle.color ?? theme.textColor, '#111827', '#ffffff', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'].filter(
    (c) => !!c && !seen.has(c.toLowerCase()) && !!seen.add(c.toLowerCase())
  )
}

const firstRun = (el: SlideElement): { bold?: boolean; italic?: boolean; underline?: boolean; color?: string; fontSize?: number } | undefined =>
  el.type === 'text' ? el.paragraphs[0]?.runs[0] : undefined
const nothing = 'Select something on the slide first'
const fillColor = (el: SlideElement): string | undefined => ('fill' in el && el.fill && el.fill.type !== 'none' ? el.fill.color : undefined)

// ── Tabs ──────────────────────────────────────────────────────────────────────

/** Text controls for one selected text element (Home). */
function TextControls({ c }: { c: DeckCtx }): JSX.Element | null {
  const el = c.el
  if (!el || el.type !== 'text') return null
  const run = firstRun(el)
  const list = el.paragraphs[0]?.listStyle
  const align = el.paragraphs[0]?.align ?? 'left'
  return (
    <>
      <BarCustom label="Font" testid="slides-font">
        <FontPicker value={el.fontFamily} onChange={(v) => c.ed.updateEl(el.id, { fontFamily: v })} compact />
      </BarCustom>
      <BarNumber label="Font size" value={run?.fontSize ?? 24} min={6} max={400} width={52} onChange={(n) => c.ed.styleText(el.id, { fontSize: n })} testid="slides-font-size" />
      <BarMenu
        icon="format_size"
        label="Font size presets"
        showLabel={false}
        items={FONT_SIZES.map((s) => ({ label: `${s}`, run: () => c.ed.styleText(el.id, { fontSize: s }), active: run?.fontSize === s }))}
      />
      <BarSep />
      <BarToggle icon="format_bold" label="Bold" shortcut="⌘B" pressed={!!run?.bold} onChange={(v) => c.ed.styleText(el.id, { bold: v })} testid="slides-bold" />
      <BarToggle icon="format_italic" label="Italic" shortcut="⌘I" pressed={!!run?.italic} onChange={(v) => c.ed.styleText(el.id, { italic: v })} testid="slides-italic" />
      <BarToggle icon="format_underlined" label="Underline" shortcut="⌘U" pressed={!!run?.underline} onChange={(v) => c.ed.styleText(el.id, { underline: v })} testid="slides-underline" />
      <BarColor icon="format_color_text" label="Text colour" value={run?.color} palette={deckPalette(c.theme)} onChange={(v) => v && c.ed.styleText(el.id, { color: v })} testid="slides-text-color" />
      <BarSep />
      <BarToggle icon="format_align_left" label="Align left" pressed={align === 'left'} onChange={() => c.ed.alignText(el.id, 'left')} testid="slides-align-text-left" />
      <BarToggle icon="format_align_center" label="Align centre" pressed={align === 'center'} onChange={() => c.ed.alignText(el.id, 'center')} testid="slides-align-text-center" />
      <BarToggle icon="format_align_right" label="Align right" pressed={align === 'right'} onChange={() => c.ed.alignText(el.id, 'right')} testid="slides-align-text-right" />
      <BarSep />
      <BarToggle icon="format_list_bulleted" label="Bulleted list" pressed={list === 'bullet'} onChange={(v) => c.ed.setList(el.id, v ? 'bullet' : 'none')} testid="slides-list-bullet" />
      <BarToggle icon="format_list_numbered" label="Numbered list" pressed={list === 'number'} onChange={(v) => c.ed.setList(el.id, v ? 'number' : 'none')} testid="slides-list-number" />
    </>
  )
}

/** Opacity and rotation: every single element (the inspector's "Rotation & opacity"). */
function CommonElementControls({ c }: { c: DeckCtx }): JSX.Element | null {
  const el = c.el
  if (!el) return null
  return (
    <BarGroup label="Element">
      <BarNumber label="Opacity" suffix="%" value={Math.round((el.opacity ?? 1) * 100)} min={0} max={100} width={48} onChange={(n) => c.ed.updateEl(el.id, { opacity: n / 100 })} testid="element-opacity" />
      <BarNumber label="Rotation" suffix="°" value={Math.round(el.rotation ?? 0)} min={-360} max={360} width={48} onChange={(n) => c.ed.updateEl(el.id, { rotation: n })} testid="element-rotation" />
    </BarGroup>
  )
}

/** Corner radius and drop shadow for any single element but a line (the inspector's "Frame"). */
function FrameControls({ c }: { c: DeckCtx }): JSX.Element | null {
  const el = c.el
  if (!el || el.type === 'line') return null
  return (
    <BarGroup label="Frame">
      <BarNumber label="Corner radius" value={el.cornerRadius ?? 0} min={0} max={640} width={48} onChange={(n) => c.ed.updateEl(el.id, { cornerRadius: Math.max(0, n) })} testid="slides-radius" />
      <BarSelect
        label="Drop shadow"
        width={120}
        value={(el.shadow ?? 'none') as 'none' | 'sm' | 'md' | 'lg'}
        options={SHADOWS}
        onChange={(v) => c.ed.updateEl(el.id, { shadow: v === 'none' ? undefined : v })}
        testid="inspector-shadow"
      />
    </BarGroup>
  )
}

const homeTab: BarTab<DeckCtx> = {
  id: 'home',
  label: 'Home',
  render: (c) => (
    <>
      {!c.selected.length && (
        <>
          <BarButton icon="add_to_photos" label="New slide" showLabel onClick={c.ed.openGallery} testid="slides-home-new-slide" />
          <BarButton icon="file_copy" label="Duplicate slide" onClick={c.ed.duplicateSlide} testid="slides-home-duplicate-slide" />
          <BarMenu
            icon="dashboard"
            label="Layout"
            testid="slides-home-layout"
            valueLabel={<span className="text-[11px]">{LAYOUT_LABEL[(c.slide.layout ?? 'title-content') as SlideLayout]}</span>}
            items={LAYOUTS.map((l) => ({ label: l.label, run: () => c.ed.applyLayout(l.id), active: c.slide.layout === l.id }))}
          />
        </>
      )}
      <TextControls c={c} />
      {c.el?.type === 'shape' && (
        <>
          <BarColor icon="format_color_fill" label="Fill" value={fillColor(c.el)} palette={deckPalette(c.theme)} allowNone onChange={(v) => c.ed.updateEl(c.el!.id, { fill: v ? { type: 'solid', color: v } : { type: 'none' } })} testid="slides-fill" />
          <BarColor icon="border_color" label="Border colour" value={c.el.border?.color} palette={deckPalette(c.theme)} allowNone onChange={(v) => c.ed.updateEl(c.el!.id, { border: v ? { color: v, width: c.el!.type === 'shape' ? c.el!.border?.width ?? 2 : 2 } : undefined })} testid="slides-border" />
        </>
      )}
      {c.el && <BarSep />}
      <CommonElementControls c={c} />
      {c.selected.length > 1 && <span className="px-2 text-[11px] text-[var(--ink-50)] whitespace-nowrap">{c.selected.length} selected: Arrange aligns and groups them</span>}
    </>
  )
}

const insertTab: BarTab<DeckCtx> = {
  id: 'insert',
  label: 'Insert',
  render: (c) => (
    <>
      {/* One-shot inserts at the default position, keeping their meaning (§4.1); the rail's armed tools place where you click. */}
      <BarButton icon="title" label="Text box" showLabel onClick={c.ed.insertText} testid="slides-insert-text" />
      <BarButton icon="image" label="Image" showLabel onClick={c.ed.insertImage} testid="slides-insert-image" />
      <BarMenu
        icon="category"
        label="Shape"
        testid="slides-insert-shape"
        items={[
          { label: 'Rectangle', icon: 'crop_square', run: () => c.ed.insertShape('rect') },
          { label: 'Rounded rectangle', icon: 'rounded_corner', run: () => c.ed.insertShape('roundRect') },
          { label: 'Ellipse', icon: 'circle', run: () => c.ed.insertShape('ellipse') },
          { label: 'Triangle', icon: 'change_history', run: () => c.ed.insertShape('triangle') },
          'sep',
          { label: 'Line / arrow', icon: 'arrow_right_alt', run: c.ed.insertLine }
        ]}
      />
      <BarButton icon="table_chart" label="Table" showLabel onClick={c.ed.insertTable} testid="slides-insert-table" />
      <BarButton icon="bar_chart" label="Chart" showLabel onClick={c.ed.insertChart} testid="slides-insert-chart" />
      <BarDialogButton icon="widgets" label="Work widget" onOpen={c.ed.insertWidget} testid="slides-insert-widget" />
      <BarDialogButton icon="bookmarks" label="Saved snippet" onOpen={c.ed.insertSnippet} testid="slides-insert-snippet" />
      {/* The old toolbar's AI button opened deck generation in one click; it still does. */}
      <BarButton icon="auto_awesome" label="AI slides" showLabel onClick={() => c.openSidePane('generate')} controls={SIDE_PANE_DOM_ID} testid="slides-insert-ai" />
      <BarSep />
      <BarButton icon="add_to_photos" label="New slide" showLabel onClick={c.ed.openGallery} testid="slides-insert-new-slide" />
      <BarDialogButton icon="dashboard_customize" label="Templates" onOpen={c.ed.openGallery} testid="slides-templates-btn" />
    </>
  )
}

const designTab: BarTab<DeckCtx> = {
  id: 'design',
  label: 'Design',
  render: (c) => {
    const layout = (c.slide.layout ?? 'title-content') as SlideLayout
    const bg = c.slide.background
    return (
      <>
        <BarMenu
          icon="dashboard"
          label="Slide layout"
          testid="slides-prop-layout"
          valueLabel={<span className="text-[11px]">{LAYOUT_LABEL[layout]}</span>}
          items={LAYOUTS.map((l) => ({ label: l.label, run: () => c.ed.applyLayout(l.id), active: layout === l.id, testid: `slides-layout-${l.id}` }))}
        />
        <BarMenu
          icon="palette"
          label="Theme"
          testid="slides-prop-theme"
          valueLabel={<span className="text-[11px]">{c.theme.name}</span>}
          items={BUILTIN_THEMES.map((t) => ({
            label: t.name,
            preview: <span className="h-3.5 w-3.5 rounded-full border border-[var(--edge-soft)]" style={{ background: t.background, boxShadow: `inset 0 0 0 2px ${t.accent}` }} />,
            run: () => c.ed.applyTheme(t),
            active: t.id === c.theme.id,
            testid: `slides-theme-${t.id}`
          }))}
        />
        <BarColor
          icon="format_paint"
          label="Slide background"
          value={bg && bg.type !== 'none' ? bg.color ?? c.theme.background : c.theme.background}
          palette={deckPalette(c.theme)}
          onChange={(v) => v && c.ed.setBackground(v)}
          testid="slides-prop-background"
        />
        <BarSelect label="Slide transition" width={150} value={(c.slide.transition ?? 'none') as SlideTransition} options={TRANSITIONS} onChange={c.ed.setTransition} testid="slides-prop-transition" />
        <BarSep />
        {/* The theme's heading face, read from the live theme: change it by changing the theme. */}
        <BarCustom label="Slide font (from the theme)" testid="slides-prop-font">
          <span className="px-1.5 text-[11px] text-[var(--ink-60)] whitespace-nowrap" title="Slide font, set by the theme">
            Aa {c.theme.fontHeading.split(',')[0]!.replace(/['"]/g, '')}
          </span>
        </BarCustom>
        <BarDialogButton icon="view_quilt" label="Layouts and themes" onOpen={() => c.togglePanel('layouts')} controls={shellPanelDomId('layouts')} testid="slides-prop-master" />
      </>
    )
  }
}

const arrangeTab: BarTab<DeckCtx> = {
  id: 'arrange',
  label: 'Arrange',
  render: (c) => {
    const el = c.el
    const n = c.selected.length
    const none = n === 0
    const multi = n >= 2
    return (
      <>
        <BarGroup label="Position and size">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <BarNumber
              key={k}
              label={{ x: 'X', y: 'Y', w: 'Width', h: 'Height' }[k]}
              value={el ? Math.round(el[k]) : undefined}
              disabled={!el}
              disabledReason={multi ? 'Position and size edit one element at a time' : nothing}
              min={k === 'w' || k === 'h' ? 0 : undefined}
              width={52}
              onChange={(v) => el && c.ed.updateEl(el.id, { [k]: v } as Partial<SlideElement>)}
              testid={`slides-${k}`}
            />
          ))}
        </BarGroup>
        <BarSep />
        <BarMenu
          icon="align_horizontal_left"
          label="Align"
          testid="slides-align-menu"
          disabled={none}
          disabledReason={nothing}
          items={[
            { label: 'Align left edges', icon: 'align_horizontal_left', run: () => c.ed.align('left'), disabled: !multi },
            { label: 'Align horizontal centres', icon: 'align_horizontal_center', run: () => c.ed.align('centerX'), disabled: !multi },
            { label: 'Align right edges', icon: 'align_horizontal_right', run: () => c.ed.align('right'), disabled: !multi },
            'sep',
            { label: 'Align top edges', icon: 'align_vertical_top', run: () => c.ed.align('top'), disabled: !multi },
            { label: 'Align vertical centres', icon: 'align_vertical_center', run: () => c.ed.align('middleY'), disabled: !multi },
            { label: 'Align bottom edges', icon: 'align_vertical_bottom', run: () => c.ed.align('bottom'), disabled: !multi },
            'sep',
            { label: 'Centre on slide horizontally', icon: 'align_horizontal_center', run: () => c.ed.centre('h') },
            { label: 'Centre on slide vertically', icon: 'align_vertical_center', run: () => c.ed.centre('v') }
          ]}
        />
        <BarButton icon="horizontal_distribute" label="Distribute horizontally" onClick={() => c.ed.distribute('h')} disabled={n < 3} disabledReason="Select three or more to distribute" testid="slides-distribute-h" />
        <BarButton icon="vertical_distribute" label="Distribute vertically" onClick={() => c.ed.distribute('v')} disabled={n < 3} disabledReason="Select three or more to distribute" testid="slides-distribute-v" />
        <BarSep />
        <BarButton icon="group_work" label="Group" shortcut="⌘G" onClick={c.ed.group} disabled={!multi} disabledReason="Select two or more to group" testid="slides-group" />
        <BarButton icon="category" label="Ungroup" shortcut="⇧⌘G" onClick={c.ed.ungroup} disabled={!c.anyGrouped} disabledReason="Select a group to ungroup" testid="slides-ungroup" />
        <BarSep />
        <BarButton icon="flip_to_front" label="Bring to front" onClick={() => c.ed.reorder('front')} disabled={none} disabledReason={nothing} testid="slides-front" />
        <BarButton icon="arrow_upward" label="Bring forward" onClick={() => c.ed.reorder('forward')} disabled={none} disabledReason={nothing} testid="slides-forward" />
        <BarButton icon="arrow_downward" label="Send backward" onClick={() => c.ed.reorder('back')} disabled={none} disabledReason={nothing} testid="slides-backward" />
        <BarButton icon="flip_to_back" label="Send to back" onClick={() => c.ed.reorder('backmost')} disabled={none} disabledReason={nothing} testid="slides-back" />
        <BarSep />
        <BarButton icon="content_copy" label="Duplicate" shortcut="⌘D" onClick={c.ed.duplicateSelection} disabled={none} disabledReason={nothing} testid="slides-el-duplicate" />
        <BarButton icon="delete" label="Delete" shortcut="⌫" onClick={c.ed.deleteSelection} disabled={none} disabledReason={nothing} testid="slides-el-delete" />
        <BarDialogButton icon="bookmark_add" label="Save as snippet" onOpen={c.ed.saveSnippet} disabled={none} disabledReason={nothing} testid="slides-save-snippet" />
        <FrameControls c={c} />
      </>
    )
  }
}

const shapeTab: BarTab<DeckCtx> = {
  id: 'shape',
  label: 'Shape',
  contextual: true,
  when: (c) => c.el?.type === 'shape',
  render: (c) => {
    const el = c.el
    if (!el || el.type !== 'shape') return null
    const fill = el.fill
    const pal = deckPalette(c.theme)
    return (
      <>
        <BarColor icon="format_color_fill" label="Fill" value={fill?.type === 'solid' ? fill.color : undefined} palette={pal} allowNone onChange={(v) => c.ed.updateEl(el.id, { fill: v ? { type: 'solid', color: v } : { type: 'none' } })} testid="slides-shape-fill" />
        <BarColor icon="border_color" label="Border colour" value={el.border?.color} palette={pal} allowNone onChange={(v) => c.ed.updateEl(el.id, { border: v ? { color: v, width: el.border?.width ?? 2 } : undefined })} testid="slides-shape-border" />
        <BarNumber label="Border width" value={el.border?.width ?? 0} min={0} max={40} width={44} disabled={!el.border} disabledReason="Pick a border colour first" onChange={(n) => el.border && c.ed.updateEl(el.id, { border: { ...el.border, width: n } })} testid="slides-shape-border-width" />
        <BarSep />
        {fill?.type === 'gradient' ? (
          <BarGroup label="Gradient" testid="shape-gradient">
            <BarColor icon="gradient" label="Gradient start" value={fill.color ?? '#6d5dfc'} palette={pal} onChange={(v) => v && c.ed.updateEl(el.id, { fill: { type: 'gradient', color: v, color2: fill.color2 ?? '#22d3ee', angle: fill.angle ?? 135 } })} />
            <BarColor icon="gradient" label="Gradient end" value={fill.color2 ?? '#22d3ee'} palette={pal} onChange={(v) => v && c.ed.updateEl(el.id, { fill: { type: 'gradient', color: fill.color ?? '#6d5dfc', color2: v, angle: fill.angle ?? 135 } })} />
            <BarNumber label="Gradient angle" suffix="°" value={fill.angle ?? 135} min={0} max={360} width={44} onChange={(n) => c.ed.updateEl(el.id, { fill: { type: 'gradient', color: fill.color ?? '#6d5dfc', color2: fill.color2 ?? '#22d3ee', angle: n } })} />
            <BarButton icon="format_color_fill" label="Back to a solid fill" onClick={() => c.ed.updateEl(el.id, { fill: { type: 'solid', color: fill.color ?? '#6d5dfc' } })} testid="shape-gradient-solid" />
          </BarGroup>
        ) : (
          <BarButton
            icon="gradient"
            label="Gradient fill"
            showLabel
            onClick={() => c.ed.updateEl(el.id, { fill: { type: 'gradient', color: (fill?.type === 'solid' && fill.color) || '#6d5dfc', color2: '#22d3ee', angle: 135 } })}
            testid="shape-gradient-toggle"
          />
        )}
      </>
    )
  }
}

const lineTab: BarTab<DeckCtx> = {
  id: 'line',
  label: 'Line',
  contextual: true,
  when: (c) => c.el?.type === 'line',
  render: (c) => {
    const el = c.el
    if (!el || el.type !== 'line') return null
    return (
      <>
        <BarColor icon="palette" label="Line colour" value={el.stroke} palette={deckPalette(c.theme)} onChange={(v) => v && c.ed.updateEl(el.id, { stroke: v })} testid="slides-line-stroke" />
        <BarNumber label="Line width" value={el.strokeWidth ?? 2} min={1} max={40} width={44} onChange={(n) => c.ed.updateEl(el.id, { strokeWidth: n })} testid="slides-line-width" />
        <BarToggle icon="arrow_forward" label="Arrowhead" pressed={!!el.arrowEnd} onChange={(v) => c.ed.updateEl(el.id, { arrowEnd: v })} testid="slides-line-arrow" />
      </>
    )
  }
}

const imageTab: BarTab<DeckCtx> = {
  id: 'image',
  label: 'Image',
  contextual: true,
  when: (c) => c.el?.type === 'image',
  render: (c) => {
    const el = c.el
    if (!el || el.type !== 'image') return null
    return (
      <>
        <BarCustom label="Alt text" testid="slides-alt-wrap">
          <input
            className="fb-field h-6 w-44 px-1.5 py-0 text-[12px]"
            data-testid="element-alt"
            aria-label="Alt text (for accessibility)"
            placeholder="Alt text (for accessibility)"
            value={el.alt ?? ''}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => c.ed.updateEl(el.id, { alt: e.target.value })}
          />
        </BarCustom>
        <BarSelect
          label="How the image fills its frame"
          width={120}
          value={(el.fit ?? 'contain') as 'contain' | 'cover' | 'fill'}
          options={[
            { value: 'contain', label: 'Fit (show all)' },
            { value: 'cover', label: 'Fill frame (crop)' },
            { value: 'fill', label: 'Stretch' }
          ]}
          onChange={(v) => c.ed.updateEl(el.id, { fit: v })}
          testid="slides-image-fit"
        />
        <BarToggle icon={el.lockAspect ? 'lock' : 'lock_open'} label="Lock aspect ratio" pressed={!!el.lockAspect} onChange={(v) => c.ed.updateEl(el.id, { lockAspect: v })} testid="slides-image-lock" />
        <BarSep />
        <BarDialogButton icon="crop" label={el.crop ? 'Edit crop' : 'Crop'} onOpen={() => c.ed.crop(el.id)} testid="inspector-crop" />
        <BarButton icon="crop_free" label="Remove the crop" onClick={() => c.ed.updateEl(el.id, { crop: undefined })} disabled={!el.crop} disabledReason="The image is not cropped" testid="slides-image-uncrop" />
        <BarButton
          icon="aspect_ratio"
          label="Reset proportions"
          onClick={() => el.naturalW && el.naturalH && c.ed.updateEl(el.id, { h: Math.round(el.w * (el.naturalH / el.naturalW)) })}
          disabled={!(el.naturalW && el.naturalH)}
          disabledReason="The image's natural size is unknown"
          testid="slides-image-reset"
        />
        <BarColor icon="border_color" label="Image border colour" value={el.border?.color} palette={deckPalette(c.theme)} allowNone onChange={(v) => c.ed.updateEl(el.id, { border: v ? { color: v, width: el.border?.width ?? 2 } : undefined })} testid="slides-image-border" />
      </>
    )
  }
}

const tableTab: BarTab<DeckCtx> = {
  id: 'table',
  label: 'Table',
  contextual: true,
  when: (c) => c.el?.type === 'table',
  render: (c) => {
    const el = c.el
    if (!el || el.type !== 'table') return null
    const cols = el.cells[0]?.length ?? 1
    return (
      <>
        <BarButton icon="add" label="Add row" showLabel onClick={() => c.ed.updateEl(el.id, { cells: [...el.cells, new Array(cols).fill('')] })} testid="table-add-row" />
        <BarButton icon="add" label="Add column" showLabel onClick={() => c.ed.updateEl(el.id, { cells: el.cells.map((r) => [...r, '']) })} testid="table-add-col" />
        <BarButton icon="remove" label="Remove last row" onClick={() => c.ed.updateEl(el.id, { cells: el.cells.slice(0, -1) })} disabled={el.cells.length <= 1} disabledReason="A table keeps at least one row" testid="table-remove-row" />
        <BarButton icon="remove" label="Remove last column" onClick={() => c.ed.updateEl(el.id, { cells: el.cells.map((r) => r.slice(0, -1)) })} disabled={cols <= 1} disabledReason="A table keeps at least one column" testid="table-remove-col" />
        <BarSep />
        <BarToggle icon="table_rows" label="Header row" showLabel pressed={!!el.headerRow} onChange={(v) => c.ed.updateEl(el.id, { headerRow: v })} testid="table-header-row" />
        <BarDialogButton icon="edit_note" label="Edit cells" onOpen={() => c.openPanel('cells')} controls={shellPanelDomId('cells')} testid="table-edit-cells" />
      </>
    )
  }
}

const chartTab: BarTab<DeckCtx> = {
  id: 'chart',
  label: 'Chart',
  contextual: true,
  when: (c) => c.el?.type === 'chart',
  render: (c) => {
    const el = c.el
    if (!el || el.type !== 'chart') return null
    return (
      <>
        <BarCustom label="Chart title" testid="slides-chart-title-wrap">
          <input
            className="fb-field h-6 w-40 px-1.5 py-0 text-[12px]"
            aria-label="Chart title"
            placeholder="Chart title"
            data-testid="slides-chart-title"
            value={el.chart.title ?? ''}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => c.ed.updateEl(el.id, { chart: { ...el.chart, title: e.target.value } })}
          />
        </BarCustom>
        <BarSelect label="Chart type" width={110} value={el.chart.type} options={CHART_TYPES.map((t) => ({ value: t.type, label: t.label }))} onChange={(v) => c.ed.updateEl(el.id, { chart: { ...el.chart, type: v as ChartType } })} testid="chart-type" />
        {(el.chart.type === 'bar' || el.chart.type === 'area') && (
          <BarToggle icon="stacked_bar_chart" label="Stacked" showLabel pressed={!!el.chart.stacked} onChange={(v) => c.ed.updateEl(el.id, { chart: { ...el.chart, stacked: v } })} testid="slides-chart-stacked" />
        )}
        <BarSep />
        <BarDialogButton icon="table_chart" label="Link a sheet range" onOpen={() => c.ed.linkChart(el.id)} testid="chart-link" />
        <BarButton icon="refresh" label="Refresh from sheet" showLabel onClick={() => c.ed.refreshChart(el.id)} disabled={!el.source} disabledReason="Link a sheet range first" testid="chart-refresh" />
        {el.source && (
          <span className="px-1.5 text-[11px] text-[var(--ink-50)] max-w-[160px] truncate" title={el.source.range} data-testid="slides-chart-linked">
            Linked to {el.source.range}
          </span>
        )}
      </>
    )
  }
}

const animationsTab: BarTab<DeckCtx> = {
  id: 'animations',
  label: 'Animations',
  render: (c) => {
    const el = c.el
    return (
      <>
        <BarSelect
          label="Entrance animation"
          width={130}
          value={el?.anim?.type ?? 'none'}
          options={ANIMS}
          disabled={!el}
          disabledReason={c.selected.length > 1 ? 'Animate one element at a time' : nothing}
          onChange={(v) => el && c.ed.updateEl(el.id, { anim: v === 'none' ? undefined : { ...(el.anim ?? {}), type: v as NonNullable<SlideElement['anim']>['type'] } })}
          testid="element-anim"
        />
        <BarNumber
          label="Play order (staggers several animations)"
          value={el?.anim ? el.anim.order ?? 0 : undefined}
          min={0}
          max={99}
          width={44}
          disabled={!el?.anim}
          disabledReason="Choose an entrance animation first"
          onChange={(n) => el?.anim && c.ed.updateEl(el.id, { anim: { ...el.anim, order: Math.max(0, n) } })}
          testid="slides-anim-order"
        />
        <BarSep />
        <BarSelect label="Slide transition" width={150} value={(c.slide.transition ?? 'none') as SlideTransition} options={TRANSITIONS} onChange={c.ed.setTransition} testid="slides-anim-transition" />
      </>
    )
  }
}

const reviewTab: BarTab<DeckCtx> = {
  id: 'review',
  label: 'Review',
  render: (c) => (
    <>
      <BarDialogButton icon="accessibility_new" label="Check accessibility" onOpen={c.ed.checkA11y} testid="slides-a11y-btn" />
      <BarButton icon="speaker_notes" label="Speaker notes" showLabel onClick={c.ed.focusNotes} testid="slides-notes-focus" readOnlySafe />
      <BarButton icon="auto_awesome" label="PlexiiAssist" showLabel onClick={() => c.openSidePane('ai')} controls={SIDE_PANE_DOM_ID} testid="slides-review-ai" readOnlySafe />
    </>
  )
}

export const DECK_TABS: BarTab<DeckCtx>[] = [homeTab, insertTab, designTab, arrangeTab, animationsTab, reviewTab, shapeTab, lineTab, imageTab, tableTab, chartTab]

// ── Rail ──────────────────────────────────────────────────────────────────────

const armed = (id: Exclude<DeckTool, 'select'>, label: string, icon: string, order: number, shortcut?: string, flyout?: string): RailItem<DeckCtx> => ({
  id: `tool-${id}`,
  label,
  icon,
  kind: 'tool',
  group: 1,
  order,
  shortcut,
  flyout,
  optionsHint: 'double-click to keep it selected',
  onSelect: (c) => c.setTool(id),
  onOptions: (c) => c.setTool(id, true),
  testid: `slides-tool-${id.toLowerCase()}`
})

/**
 * The rail in the common order the spec fixes for every app (§3.1): navigate,
 * create (armed tools carry `slides-tool-*` ids: clicking one arms a mode and
 * places nothing until the canvas is used, §4.1), insert, then the panels.
 */
export function deckRailItems(): RailItem<DeckCtx>[] {
  return [
    { id: 'select', label: 'Select', icon: 'arrow_selector_tool', kind: 'tool', group: 0, order: 0, shortcut: 'V', readOnlySafe: true, onSelect: (c) => c.setTool('select'), testid: 'slides-tool-select' },
    armed('text', 'Text box', 'title', 0, 'T'),
    armed('rect', 'Rectangle', 'crop_square', 1, 'M', 'shapes'),
    armed('roundRect', 'Rounded rectangle', 'rounded_corner', 2, undefined, 'shapes'),
    armed('ellipse', 'Ellipse', 'circle', 3, 'L', 'shapes'),
    armed('triangle', 'Triangle', 'change_history', 4, undefined, 'shapes'),
    armed('line', 'Line', 'horizontal_rule', 5, '\\', 'shapes'),
    { id: 'image', label: 'Image', icon: 'image', kind: 'action', group: 2, order: 0, onSelect: (c) => c.ed.insertImage(), testid: 'slides-rail-image' },
    { id: 'table', label: 'Table', icon: 'table_chart', kind: 'action', group: 2, order: 1, onSelect: (c) => c.ed.insertTable(), testid: 'slides-rail-table' },
    { id: 'chart', label: 'Chart', icon: 'bar_chart', kind: 'action', group: 2, order: 2, onSelect: (c) => c.ed.insertChart(), testid: 'slides-rail-chart' },
    { id: 'widget', label: 'Work widget from a desk', icon: 'widgets', kind: 'action', group: 2, order: 3, onSelect: (c) => c.ed.insertWidget(), testid: 'slides-rail-widget' },
    { id: 'layouts', label: 'Layouts and themes', icon: 'view_quilt', kind: 'panel', group: 9, order: 0, pinned: 'bottom', onSelect: (c) => c.togglePanel('layouts'), testid: 'slides-rail-layouts' },
    { id: 'ai', label: 'PlexiiAssist', icon: 'auto_awesome', kind: 'panel', sidePane: true, group: 9, order: 1, pinned: 'bottom', readOnlySafe: true, onSelect: (c) => c.toggleSidePane('ai'), testid: 'slides-rail-ai' }
  ]
}

/** The tool a rail id stands for (the rail's activeId is `tool-<kind>`). */
export const railIdForTool = (t: DeckTool): string => (t === 'select' ? 'select' : `tool-${t}`)
