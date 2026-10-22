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
  type BarTab
} from '../../office/shell'
import type { ReactNode } from 'react'
import { familyLabel, fontFamilyValue } from '../../../lib/googleFonts'
import type { SlideElement, SlideTextElement } from '@shared/types'
import { BASE_LAYER_ID, type DesignBody } from '@shared/design'
import { LAYOUT_STYLES } from '@shared/designAutoLayout'

// PlexiiDesign's ContextBar tabs (office shell SPEC §2.3, §6.3).
//
// This is where the right-hand inspector went. Owner ruling D1: "Everything
// should be in the top bar or the left tool bar" — so every property that
// used to live in a 224px column that was permanently there, whether or not
// anything was selected, is now a control on a tab that is only there when it
// can do something.
//
// Two rules the whole file follows:
//
//   HOME IS SELECTION-AWARE. What you can change about what you have selected
//   is on Home, so the common case needs no tab switching. Text properties
//   appear for text, fill for shapes, and with nothing selected Home offers
//   the page background — which is what the old canvas inspector did.
//
//   CONTEXTUAL TABS DO NOT STEAL FOCUS (D3). Text and Image appear when they
//   apply and are never auto-selected, so the bar does not move under you
//   while you work.
//
// The testids are the inspector's own, unchanged: these controls do the same
// thing to the same document, so a spec that drove the inspector still drives
// them. The ids that DID change meaning are the armed tools, and those were
// renamed (SPEC §4.1).

/** Everything the tabs read, and every command they run. */
export interface DesignCtx {
  design: DesignBody
  selected: SlideElement[]
  /** The first selected element, which is what single-element controls act on. */
  first: SlideElement | null
  fonts: string[]
  palette: string[]
  cmd: {
    patchElement: (patch: Partial<SlideElement>) => void
    patchText: (patch: { fontFamily?: string; fontSize?: number; color?: string; bold?: boolean; italic?: boolean; underline?: boolean }) => void
    setAlign: (align: 'left' | 'center' | 'right') => void
    setBackground: (color: string) => void
    align: (edge: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom') => void
    distribute: (axis: 'h' | 'v') => void
    group: () => void
    ungroup: () => void
    order: (dir: 'forward' | 'back' | 'front' | 'backmost') => void
    duplicate: () => void
    remove: () => void
    /** Save the selected elements as a snippet (the dialog names it). */
    saveSnippet: () => void
    /** Open the saved-snippets library, scoped to design snippets, aimed at this design. */
    insertSnippet: () => void
    setLayer: (id: string) => void
    setWrap: (mode: 'none' | 'square', offset?: number) => void
    openStory: () => void
    linkFrames: () => void
    unlinkFrame: () => void
    setStoryColumns: (n: number) => void
    setStoryStyle: (id: string) => void
    setAlt: (text: string) => void
    removeBackground: () => void
    addPage: () => void
    duplicatePage: () => void
    toggleGuides: () => void
    toggleFacing: () => void
    setBleed: (px: number) => void
    brandify: () => void
    openBrandKit: () => void
    openPanel: (id: DesignPanelId) => void
    exportAs: (f: 'png' | 'pdf') => void
    exportPrint: () => void
    checkA11y: () => void
  }
  /**
   * The Start-from control, rendered by the editor and passed in: it is a
   * self-contained control with its own trigger and state (SPEC §2.5's
   * BarCustom), so the bar hosts it rather than rebuilding it.
   */
  startFrom: ReactNode
  guidesVisible: boolean
  facing: boolean
  /** Print bleed in logical px (design.bleed). */
  bleed: number
  layers: Array<{ id: string; name: string }>
}

/** The overlay panels the bar can open (SPEC §2.4). */
export type DesignPanelId = 'layout' | 'styles' | 'swatches' | 'preflight' | 'stock' | 'redesign' | 'templates'

const isText = (e: SlideElement | null): e is SlideTextElement => !!e && e.type === 'text'
const firstRun = (e: SlideTextElement): { fontSize?: number; color?: string; bold?: boolean; italic?: boolean; underline?: boolean } =>
  e.paragraphs?.[0]?.runs?.[0] ?? {}

const ALIGNS: Array<[DesignCtx['cmd'] extends { align: (e: infer E) => void } ? E : never, string, string]> = [
  ['left', 'align_horizontal_left', 'Align left'],
  ['centerX', 'align_horizontal_center', 'Align centre'],
  ['right', 'align_horizontal_right', 'Align right'],
  ['top', 'align_vertical_top', 'Align top'],
  ['middleY', 'align_vertical_center', 'Align middle'],
  ['bottom', 'align_vertical_bottom', 'Align bottom']
]

/** Text properties, shown on Home for text and again on the Text tab. */
function TextControls({ c, el, ids }: { c: DesignCtx; el: SlideTextElement; ids: boolean }): JSX.Element {
  const run = firstRun(el)
  return (
    <BarGroup label="Text">
      {/* The element stores a full CSS stack; the picker shows the family's
          name. Converting in both directions is what the inspector did, and
          skipping it leaves the select showing nothing for every font. */}
      <BarSelect
        label="Font"
        value={familyLabel(el.fontFamily) || c.fonts[0] || 'Inter'}
        options={c.fonts.map((f) => ({ value: f, label: f }))}
        onChange={(v) => c.cmd.patchText({ fontFamily: fontFamilyValue(v) })}
        testid={ids ? 'design-font-family' : undefined}
      />
      <BarNumber
        label="Font size"
        value={run.fontSize ?? 24}
        min={6}
        onChange={(v) => c.cmd.patchText({ fontSize: v })}
        testid={ids ? 'design-font-size' : undefined}
      />
      <BarColor
        icon="format_color_text"
        label="Text colour"
        value={run.color ?? '#1c1917'}
        palette={c.palette}
        onChange={(v) => v && c.cmd.patchText({ color: v })}
        testid={ids ? 'design-text-color' : undefined}
      />
      <BarToggle icon="format_bold" label="Bold" pressed={run.bold === true} onChange={(v) => c.cmd.patchText({ bold: v })} testid={ids ? 'design-bold' : undefined} />
      <BarToggle icon="format_italic" label="Italic" pressed={run.italic === true} onChange={(v) => c.cmd.patchText({ italic: v })} testid={ids ? 'design-italic' : undefined} />
      <BarToggle icon="format_underlined" label="Underline" pressed={run.underline === true} onChange={(v) => c.cmd.patchText({ underline: v })} testid={ids ? 'design-underline' : undefined} />
      <BarMenu
        icon="format_align_left"
        label="Alignment"
        showLabel={false}
        testid={ids ? 'design-align-text' : undefined}
        items={[
          { label: 'Left', icon: 'format_align_left', run: () => c.cmd.setAlign('left') },
          { label: 'Centre', icon: 'format_align_center', run: () => c.cmd.setAlign('center') },
          { label: 'Right', icon: 'format_align_right', run: () => c.cmd.setAlign('right') }
        ]}
      />
    </BarGroup>
  )
}

const homeTab: BarTab<DesignCtx> = {
  id: 'home',
  label: 'Home',
  render: (c) => {
    const { first, selected } = c
    if (selected.length === 0) {
      // What the canvas inspector used to show, in the same place as
      // everything else rather than in a column of its own.
      return (
        <>
          <BarGroup label="Page">
            <BarColor
              icon="format_color_fill"
              label="Background"
              value={(c.design.background as { color?: string } | undefined)?.color ?? '#ffffff'}
              palette={c.palette}
              onChange={(v) => v && c.cmd.setBackground(v)}
              testid="design-bg-color"
            />
          </BarGroup>
          <span className="shrink-0 px-1.5 text-[11px] text-[var(--ink-50)]">
            Select something to format it, or pick a tool on the left to add something.
          </span>
        </>
      )
    }
    return (
      <>
        {isText(first) && <TextControls c={c} el={first} ids />}
        {first?.type === 'shape' && (
          <BarGroup label="Shape">
            <BarColor
              icon="format_color_fill"
              label="Fill"
              value={(first.fill as { color?: string } | undefined)?.color ?? '#000000'}
              palette={c.palette}
              allowNone
              onChange={(v) => c.cmd.patchElement({ fill: v ? { type: 'solid', color: v } : { type: 'none' } } as Partial<SlideElement>)}
              testid="design-fill-color"
            />
          </BarGroup>
        )}
        <BarSep />
        <BarGroup label="Appearance">
          <BarNumber
            label="Opacity"
            value={Math.round((first?.opacity ?? 1) * 100)}
            min={0}
            max={100}
            suffix="%"
            onChange={(v) => c.cmd.patchElement({ opacity: Math.max(0, Math.min(1, v / 100)) })}
            testid="design-opacity"
          />
          <BarNumber
            label="Rotation"
            value={Math.round(first?.rotation ?? 0)}
            min={-180}
            max={180}
            suffix="°"
            onChange={(v) => c.cmd.patchElement({ rotation: v })}
            testid="design-rotation"
          />
        </BarGroup>
        <BarSep />
        <BarButton icon="file_copy" label="Duplicate" shortcut="⌘D" onClick={c.cmd.duplicate} testid="design-duplicate" />
        <BarButton icon="delete" label="Delete" shortcut="⌫" onClick={c.cmd.remove} testid="design-delete-element" />
      </>
    )
  }
}

const insertTab: BarTab<DesignCtx> = {
  id: 'insert',
  label: 'Insert',
  render: (c) => (
    <>
      <BarGroup label="Page">
        <BarButton icon="note_add" label="Add page" showLabel onClick={c.cmd.addPage} testid="design-insert-page" />
        <BarButton icon="file_copy" label="Duplicate this page" onClick={c.cmd.duplicatePage} testid="design-insert-duplicate-page" />
      </BarGroup>
      <BarSep />
      <BarGroup label="From a library">
        <BarButton icon="photo_library" label="Stock photos…" showLabel onClick={() => c.cmd.openPanel('stock')} testid="design-stock-btn" />
        <BarButton icon="dashboard_customize" label="Templates…" showLabel onClick={() => c.cmd.openPanel('templates')} testid="design-templates-open" />
        <BarDialogButton icon="bookmarks" label="Saved snippet" onOpen={c.cmd.insertSnippet} testid="design-insert-snippet" />
      </BarGroup>
      <span className="shrink-0 px-1.5 text-[11px] text-[var(--ink-50)]">
        Text, shapes and lines are tools on the left: pick one, then click or drag on the page.
      </span>
    </>
  )
}

const arrangeTab: BarTab<DesignCtx> = {
  id: 'arrange',
  label: 'Arrange',
  render: (c) => {
    const n = c.selected.length
    return (
      <>
        <BarGroup label="Align and distribute" testid="design-arrange">
          {ALIGNS.map(([edge, icon, label]) => (
            <BarButton
              key={String(edge)}
              icon={icon}
              label={label}
              disabled={n < 2}
              disabledReason="select two or more things"
              onClick={() => c.cmd.align(edge)}
              testid={`design-align-${String(edge)}`}
            />
          ))}
          <BarButton icon="horizontal_distribute" label="Distribute horizontally" disabled={n < 3} disabledReason="select three or more things" onClick={() => c.cmd.distribute('h')} testid="design-distribute-h" />
          <BarButton icon="vertical_distribute" label="Distribute vertically" disabled={n < 3} disabledReason="select three or more things" onClick={() => c.cmd.distribute('v')} testid="design-distribute-v" />
        </BarGroup>
        <BarSep />
        <BarGroup label="Group and order">
          <BarButton icon="link" label="Group" shortcut="⌘G" disabled={n < 2} disabledReason="select two or more things" onClick={c.cmd.group} testid="design-group" />
          <BarButton icon="link_off" label="Ungroup" disabled={n === 0} onClick={c.cmd.ungroup} testid="design-ungroup" />
          <BarButton icon="flip_to_front" label="Bring forward" disabled={n === 0} onClick={() => c.cmd.order('forward')} testid="design-order-forward" />
          <BarButton icon="flip_to_back" label="Send back" disabled={n === 0} onClick={() => c.cmd.order('back')} testid="design-order-back" />
          <BarDialogButton icon="bookmark_add" label="Save as snippet" onOpen={c.cmd.saveSnippet} disabled={n === 0} disabledReason="select something first" testid="design-save-snippet" />
        </BarGroup>
        <BarSep />
        <BarGroup label="Layer and wrap">
          <BarSelect
            label="Layer"
            value={(c.first as { layerId?: string } | null)?.layerId ?? BASE_LAYER_ID}
            options={c.layers.map((l) => ({ value: l.id, label: l.name }))}
            disabled={n === 0 || c.layers.length === 0}
            onChange={(v) => c.cmd.setLayer(v)}
            testid="design-element-layer"
          />
          <BarMenu
            icon="wrap_text"
            label="Text wrap"
            showLabel={false}
            disabled={n === 0}
            testid="design-wrap-controls"
            items={[
              {
                label: 'No wrap',
                run: () => c.cmd.setWrap('none'),
                active: ((c.first as { wrap?: { mode?: string } } | null)?.wrap?.mode ?? 'none') === 'none',
                testid: 'design-wrap-none'
              },
              {
                label: 'Wrap around',
                run: () => c.cmd.setWrap('square'),
                active: (c.first as { wrap?: { mode?: string } } | null)?.wrap?.mode === 'square',
                testid: 'design-wrap-square'
              }
            ]}
          />
          <BarNumber
            label="Standoff"
            value={(c.first as { wrap?: { offset?: number } } | null)?.wrap?.offset ?? 12}
            min={0}
            disabled={n === 0}
            onChange={(v) => c.cmd.setWrap('square', v)}
            testid="design-wrap-offset"
          />
        </BarGroup>
      </>
    )
  }
}

const layoutTab: BarTab<DesignCtx> = {
  id: 'layout',
  label: 'Layout',
  render: (c) => (
    <>
      <BarCustom label="Start from" testid="design-start-slot">
        {c.startFrom}
      </BarCustom>
      <BarSep />
      <BarButton icon="grid_on" label="Margins, columns & layers…" showLabel onClick={() => c.cmd.openPanel('layout')} testid="design-layout-btn" />
      <BarToggle icon="visibility" label="Layout guides" pressed={c.guidesVisible} onChange={c.cmd.toggleGuides} testid="design-aids-toggle" />
      <BarToggle icon="auto_stories" label="Facing pages" pressed={c.facing} onChange={c.cmd.toggleFacing} testid="design-facing-toggle-bar" />
      <BarSep />
      {/* Bleed belongs with page setup, not buried in the export menu where it
          used to live. Keeping the id: it still sets design.bleed, so a spec
          written against it is still testing the same thing (SPEC §4.1). */}
      <BarNumber
        label="Bleed (px)"
        value={c.bleed}
        min={0}
        max={100}
        onChange={c.cmd.setBleed}
        testid="design-bleed-input"
      />
    </>
  )
}

const brandTab: BarTab<DesignCtx> = {
  id: 'brand',
  label: 'Brand',
  render: (c) => (
    <>
      <BarButton icon="palette" label="Brandify" showLabel onClick={c.cmd.brandify} testid="design-brandify" />
      <BarButton icon="tune" label="Brand kit…" showLabel onClick={c.cmd.openBrandKit} testid="design-brand-kit-btn" />
      <BarSep />
      <BarButton icon="format_paint" label="Paragraph styles…" showLabel onClick={() => c.cmd.openPanel('styles')} testid="design-styles-btn" />
      <BarButton icon="invert_colors" label="Swatches & spot inks…" showLabel onClick={() => c.cmd.openPanel('swatches')} testid="design-swatches-btn" />
      <BarButton icon="auto_fix_high" label="Redesign…" showLabel onClick={() => c.cmd.openPanel('redesign')} testid="design-redesign-btn" />
    </>
  )
}

const reviewTab: BarTab<DesignCtx> = {
  id: 'review',
  label: 'Review',
  render: (c) => (
    <>
      <BarButton icon="fact_check" label="Preflight for print…" showLabel onClick={() => c.cmd.openPanel('preflight')} testid="design-preflight-btn" />
      <BarButton icon="accessibility_new" label="Check accessibility" showLabel onClick={c.cmd.checkA11y} testid="design-a11y-check" />
      <BarSep />
      <BarMenu
        icon="download"
        label="Export"
        testid="design-export-btn"
        items={[
          { label: 'Image (.png)', run: () => c.cmd.exportAs('png'), testid: 'design-export-png' },
          { label: 'PDF document (.pdf)', run: () => c.cmd.exportAs('pdf'), testid: 'design-export-pdf' },
          'sep',
          { label: 'Print PDF (bleed + crop marks)', run: c.cmd.exportPrint, testid: 'design-export-print' }
        ]}
      />
    </>
  )
}

/** Contextual: only while a text frame is selected (D3 — it never auto-switches). */
const textTab: BarTab<DesignCtx> = {
  id: 'text',
  label: 'Text',
  contextual: true,
  when: (c) => isText(c.first),
  render: (c) =>
    isText(c.first) ? (
      <>
        <TextControls c={c} el={c.first} ids={false} />
        <BarSep />
        <BarGroup label="Story" testid="design-thread-controls">
          <BarButton icon="edit_note" label="Edit the story" showLabel onClick={c.cmd.openStory} testid="design-open-story" />
          <BarNumber label="Columns" value={(c.first as { storyColumns?: number }).storyColumns ?? 1} min={1} max={6} onChange={c.cmd.setStoryColumns} testid="design-story-columns" />
          <BarSelect
            label="Style"
            value={c.design.layoutStyleId ?? 'editorial'}
            // The presets the engine actually has, not a list typed here that
            // drifts the moment one is added.
            options={LAYOUT_STYLES.map((st) => ({ value: st.id, label: st.name }))}
            onChange={c.cmd.setStoryStyle}
            testid="design-story-style"
          />
          <BarButton icon="link" label="Link text frames into one story" disabled={c.selected.length < 2} onClick={c.cmd.linkFrames} testid="design-link-frames" />
          <BarButton icon="link_off" label="Unlink frame from its story" onClick={c.cmd.unlinkFrame} testid="design-unlink" />
        </BarGroup>
      </>
    ) : null
}

/** Contextual: only while an image is selected. */
const imageTab: BarTab<DesignCtx> = {
  id: 'image',
  label: 'Image',
  contextual: true,
  when: (c) => c.first?.type === 'image',
  render: (c) => (
    <>
      <BarCustom label="Alt text" testid="design-alt-slot">
        <input
          value={(c.first as { alt?: string } | null)?.alt ?? ''}
          onChange={(e) => c.cmd.setAlt(e.target.value)}
          placeholder="Describe this image"
          className="fb-field h-6 w-52 px-1.5 text-[12px]"
          aria-label="Alt text"
          data-testid="design-alt"
        />
      </BarCustom>
      <BarButton icon="auto_awesome" label="Remove background" showLabel onClick={c.cmd.removeBackground} testid="design-remove-bg" />
    </>
  )
}

export const DESIGN_TABS: BarTab<DesignCtx>[] = [homeTab, insertTab, arrangeTab, layoutTab, brandTab, reviewTab, textTab, imageTab]
