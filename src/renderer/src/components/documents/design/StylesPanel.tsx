import { useMemo, useState } from 'react'
import {
  addParagraphStyle,
  blockKindsUsing,
  deleteParagraphStyle,
  descendantsOf,
  findParagraphStyle,
  resolveParagraphStyle,
  setBlockStyle,
  updateParagraphStyle,
  type BlockStyleKey,
  type DesignStyleSheet
} from '@shared/designStyles'
import { documentStyleSheet } from '@shared/designStories'
import type { DesignBody } from '@shared/design'
import type { FlowParaStyle } from '@shared/designFlow'

// Named styles — the backbone a page-layout tool is built on, and the thing
// PlexiiDesign had an engine for and no way to touch.
//
// The sheet already drove the page: storyParagraphs resolves every block
// through it, and a document without one gets a generated default that sets
// identically to the old hard-coded path. So this panel does not introduce
// styles; it makes the ones already in use editable.
//
// Two decisions worth knowing:
//
//   NOTHING IS WRITTEN until an edit happens. Opening the panel on a document
//   that has no sheet shows the generated one. The first change materialises
//   it into the document — the panel writes the whole resolved sheet on that
//   first edit — so looking costs nothing and lands nothing on the undo stack.
//
//   CHANGING A PARENT CHANGES THE FAMILY, which is the entire point. The panel
//   says so where it can be surprising: the Based on row names the parent, and
//   deleting a style tells you which styles inherit from it before you do.
//
// Hyphenation and baseline snapping live here rather than in their own panels
// because they are properties of a paragraph style, and putting them anywhere
// else would mean two places that set the same field.
//
// NO CHARACTER STYLES, deliberately. The sheet type has carried
// DesignCharacterStyle since the engine landed, and a tab for defining them
// was written and then taken out again: nothing can APPLY one. The flow engine
// sets a line from a single style (FlowLine has one size, one family, one
// colour), so styling a run inside a paragraph is an engine feature — mixed
// measurement and mixed rendering — not a panel. A palette of styles that
// cannot reach any text is the exact thing this branch exists to stop
// shipping, so it is a known gap rather than a tab.

interface Props {
  design: DesignBody
  /** Write the sheet (and, on the first edit, materialise it). */
  onPatch: (patch: Partial<DesignBody>) => void
}

const BLOCK_LABELS: Array<{ key: BlockStyleKey; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'subtitle', label: 'Subtitle' },
  { key: 'heading1', label: 'Heading 1' },
  { key: 'heading2', label: 'Heading 2' },
  { key: 'heading3', label: 'Heading 3' },
  { key: 'paragraph', label: 'Body paragraphs' },
  { key: 'list', label: 'Lists' },
  { key: 'quote', label: 'Quotes' },
  { key: 'caption', label: 'Captions' }
]

const FONTS = ['Georgia', 'Times New Roman', 'Garamond', 'Helvetica', 'Arial', 'Inter', 'Verdana', 'Courier New']

export default function StylesPanel({ design, onPatch }: Props): JSX.Element {
  const sheet = useMemo(() => documentStyleSheet(design), [design])
  const [selected, setSelected] = useState<string>('body')

  const style = findParagraphStyle(sheet, selected) ?? sheet.paragraph[0]
  // What the style actually sets, parents and all — the numbers to show, since
  // a style that inherits its size has nothing of its own to display.
  const resolved: FlowParaStyle = resolveParagraphStyle(sheet, style?.id ?? 'body', {
    fontSize: 10,
    lineHeight: 1.4,
    font: '10px Georgia',
    align: 'left'
  })

  /** Every edit goes through here, so the sheet is materialised exactly once. */
  function write(next: DesignStyleSheet): void {
    onPatch({ paragraphStyles: next })
  }
  const patchProps = (patch: Partial<FlowParaStyle>): void => {
    if (!style) return
    write(updateParagraphStyle(sheet, style.id, { props: patch }))
  }

  return (
    <div className="text-[12px]" data-testid="design-styles-panel">
      <div className="flex items-center gap-1 mb-2">
        {!design.paragraphStyles && (
          <span className="ml-auto fb-t-caption text-[var(--ink-40)]" data-testid="design-styles-generated">
            These are the document&rsquo;s current styles. Editing one saves the set into the document.
          </span>
        )}
      </div>


        <div className="grid gap-3 md:grid-cols-3">
          {/* ── The styles ───────────────────────────────────────────────── */}
          <section>
            <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)] mb-1">Styles</h4>
            <ul className="flex flex-col gap-0.5 max-h-44 overflow-auto pr-1" data-testid="design-styles-list">
              {sheet.paragraph.map((s) => {
                const kinds = blockKindsUsing(sheet, s.id)
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => setSelected(s.id)}
                      className={`w-full text-left px-1.5 py-1 rounded-md ${
                        s.id === style?.id ? 'bg-[rgb(var(--accent)/0.1)]' : 'hover:bg-[var(--surface-base)]'
                      }`}
                      data-testid={`design-style-${s.id}`}
                    >
                      <span className="block text-[12px] text-[var(--ink-90)]">{s.name}</span>
                      <span className="block fb-t-caption text-[var(--ink-40)]">
                        {s.basedOn ? `based on ${findParagraphStyle(sheet, s.basedOn)?.name ?? s.basedOn}` : 'stands alone'}
                        {kinds.length ? ` · sets every ${kinds.map((k) => BLOCK_LABELS.find((b) => b.key === k)?.label ?? k).join(', ')}` : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="flex gap-1.5 mt-1.5">
              <button
                onClick={() => {
                  const { sheet: next, id } = addParagraphStyle(sheet, {
                    name: `Style ${sheet.paragraph.length + 1}`,
                    basedOn: style?.id,
                    props: {}
                  })
                  write(next)
                  setSelected(id)
                }}
                className="fb-btn-surface flex-1 px-2 py-1 text-[11px] hover:border-accent"
                data-testid="design-style-new"
              >
                New style
              </button>
              <button
                onClick={() => {
                  if (!style || style.id === 'body') return
                  write(deleteParagraphStyle(sheet, style.id))
                  setSelected('body')
                }}
                disabled={!style || style.id === 'body'}
                className="fb-btn-surface px-2 py-1 text-[11px] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
                title={
                  style?.id === 'body'
                    ? 'Body cannot be deleted: every other style resolves down to it'
                    : descendantsOf(sheet, style?.id ?? '').length
                      ? `${descendantsOf(sheet, style?.id ?? '').map((d) => d.name).join(', ')} inherit from this; they will be re-based onto ${
                          style?.basedOn ? findParagraphStyle(sheet, style.basedOn)?.name ?? 'nothing' : 'nothing'
                        }`
                      : 'Delete this style'
                }
                data-testid="design-style-delete"
              >
                Delete
              </button>
            </div>
          </section>

          {/* ── The selected style ───────────────────────────────────────── */}
          <section className="space-y-1.5">
            <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)]">
              {style?.name ?? 'No style'}
            </h4>
            <label className="block">
              <span className="fb-t-caption text-[var(--ink-50)]">Name</span>
              <input
                value={style?.name ?? ''}
                onChange={(e) => style && write(updateParagraphStyle(sheet, style.id, { name: e.target.value }))}
                className="fb-field w-full px-1.5 py-1 mt-0.5"
                data-testid="design-style-name"
              />
            </label>
            <label className="block">
              <span className="fb-t-caption text-[var(--ink-50)]">Based on</span>
              <select
                value={style?.basedOn ?? ''}
                onChange={(e) =>
                  style &&
                  write(
                    updateParagraphStyle(sheet, style.id, {
                      basedOn: e.target.value || undefined
                    })
                  )
                }
                className="fb-field w-full px-1.5 py-1 mt-0.5"
                data-testid="design-style-basedon"
              >
                <option value="">Nothing — stands alone</option>
                {sheet.paragraph
                  // A style cannot be based on itself or on its own descendant.
                  .filter((s) => s.id !== style?.id && !descendantsOf(sheet, style?.id ?? '').some((d) => d.id === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-50)]">Size</span>
                <input
                  type="number"
                  min={4}
                  step={0.5}
                  value={resolved.fontSize}
                  onChange={(e) => patchProps({ fontSize: Math.max(4, Number(e.target.value) || resolved.fontSize) })}
                  className="fb-field w-full px-1.5 py-1 mt-0.5"
                  data-testid="design-style-size"
                />
              </label>
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-50)]">Line height</span>
                <input
                  type="number"
                  min={0.8}
                  step={0.05}
                  value={resolved.lineHeight}
                  onChange={(e) => patchProps({ lineHeight: Math.max(0.8, Number(e.target.value) || resolved.lineHeight) })}
                  className="fb-field w-full px-1.5 py-1 mt-0.5"
                  data-testid="design-style-leading"
                />
              </label>
            </div>
            <label className="block">
              <span className="fb-t-caption text-[var(--ink-50)]">Typeface</span>
              <select
                value={resolved.fontFamily ?? ''}
                onChange={(e) => patchProps({ fontFamily: e.target.value })}
                className="fb-field w-full px-1.5 py-1 mt-0.5"
                data-testid="design-style-family"
              >
                {[...new Set([resolved.fontFamily ?? 'Georgia', ...FONTS])].filter(Boolean).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => patchProps({ bold: !resolved.bold })}
                className={`fb-btn-surface px-2 py-1 text-[11px] ${resolved.bold ? 'border-accent text-[rgb(var(--accent))]' : ''}`}
                data-testid="design-style-bold"
              >
                B
              </button>
              <button
                onClick={() => patchProps({ italic: !resolved.italic })}
                className={`fb-btn-surface px-2 py-1 text-[11px] italic ${resolved.italic ? 'border-accent text-[rgb(var(--accent))]' : ''}`}
                data-testid="design-style-italic"
              >
                I
              </button>
              <select
                value={resolved.align}
                onChange={(e) => patchProps({ align: e.target.value as FlowParaStyle['align'] })}
                className="fb-field flex-1 px-1.5 py-1"
                data-testid="design-style-align"
              >
                <option value="left">Left</option>
                <option value="center">Centred</option>
                <option value="right">Right</option>
                <option value="justify">Justified</option>
              </select>
              <input
                type="color"
                value={(resolved.color ?? '#111111').startsWith('#') ? resolved.color : '#111111'}
                onChange={(e) => patchProps({ color: e.target.value })}
                className="h-6 w-8 rounded border border-[var(--edge-soft)] bg-transparent"
                aria-label="Colour"
                data-testid="design-style-color"
              />
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-50)]">Space before</span>
                <input
                  type="number"
                  step={1}
                  value={resolved.spaceBefore ?? 0}
                  onChange={(e) => patchProps({ spaceBefore: Math.max(0, Number(e.target.value) || 0) })}
                  className="fb-field w-full px-1.5 py-1 mt-0.5"
                  data-testid="design-style-space-before"
                />
              </label>
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-50)]">Space after</span>
                <input
                  type="number"
                  step={1}
                  value={resolved.spaceAfter ?? 0}
                  onChange={(e) => patchProps({ spaceAfter: Math.max(0, Number(e.target.value) || 0) })}
                  className="fb-field w-full px-1.5 py-1 mt-0.5"
                  data-testid="design-style-space-after"
                />
              </label>
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-50)]">First line</span>
                <input
                  type="number"
                  step={1}
                  value={resolved.indent ?? 0}
                  onChange={(e) => patchProps({ indent: Math.max(0, Number(e.target.value) || 0) })}
                  className="fb-field w-full px-1.5 py-1 mt-0.5"
                  data-testid="design-style-indent"
                />
              </label>
            </div>
          </section>

          {/* ── Typesetting switches + the block map ─────────────────────── */}
          <section className="space-y-2">
            <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)]">Typesetting</h4>
            <label className="flex items-start gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={resolved.hyphenate === true}
                onChange={(e) => patchProps({ hyphenate: e.target.checked })}
                className="mt-0.5"
                data-testid="design-style-hyphenate"
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-[var(--ink-90)]">Hyphenate</span>
                <span className="block fb-t-caption text-[var(--ink-40)] leading-snug">
                  Breaks long words at the ends of lines. This is what stops rivers of white in a justified
                  column — and it changes where every line breaks, so a saved document will repaginate.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={resolved.snapToGrid === true}
                onChange={(e) => patchProps({ snapToGrid: e.target.checked })}
                className="mt-0.5"
                data-testid="design-style-snap"
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-[var(--ink-90)]">Snap to the baseline grid</span>
                <span className="block fb-t-caption text-[var(--ink-40)] leading-snug">
                  Puts every line of this style on a grid line, so columns line up across the page.
                  {design.baselineGrid
                    ? ` The grid is set to ${design.baselineGrid.spacing}px.`
                    : ' Set a grid under Layout first, or this does nothing.'}
                </span>
              </span>
            </label>
            <label className="block">
              <span className="fb-t-caption text-[var(--ink-50)]">Keep at least this many lines together</span>
              <input
                type="number"
                min={1}
                max={5}
                value={resolved.widowLines ?? 1}
                onChange={(e) => patchProps({ widowLines: Math.min(5, Math.max(1, Number(e.target.value) || 1)) })}
                className="fb-field w-full px-1.5 py-1 mt-0.5"
                data-testid="design-style-widows"
              />
            </label>

            <h4 className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)] pt-1">What sets what</h4>
            <div className="flex flex-col gap-1 max-h-32 overflow-auto pr-1">
              {BLOCK_LABELS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5">
                  <span className="w-28 shrink-0 fb-t-caption text-[var(--ink-50)]">{label}</span>
                  <select
                    value={sheet.blockMap?.[key] ?? (findParagraphStyle(sheet, key) ? key : 'body')}
                    onChange={(e) => write(setBlockStyle(sheet, key, e.target.value))}
                    className="fb-field flex-1 px-1.5 py-0.5 text-[11px]"
                    data-testid={`design-blockmap-${key}`}
                  >
                    {sheet.paragraph.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </section>
        </div>
    </div>
  )
}
