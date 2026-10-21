// Named paragraph and character styles — the backbone of a page-layout tool.
//
// The typographic engine already supported everything a style needs: size,
// leading, indents, space before and after, drop caps, widow control,
// keep-with-next, rules above. What it had no concept of was a STYLE: a named,
// stored, editable thing that many paragraphs share. Type was computed in code
// from a whole-document layout preset, so "make every caption one point
// smaller" meant editing every caption, and a document could not carry a look
// of its own at all.
//
// This adds the sheet on top of the engine rather than beside it. A style
// resolves to the same FlowParaStyle the flow engine already takes, so nothing
// downstream changes — the renderer, the exporter and the measurer are
// untouched.
//
// Three properties are the point of the whole file:
//
//   NAMED       a paragraph says "I am Body", not "I am 10.5px Söhne".
//   INHERITED   a style may be based on another, so changing the parent moves
//               the family. This is how a document keeps one voice.
//   STORED      the sheet lives in the document, so it travels with the file
//               and can be edited.
//
// Backward compatibility is the hard constraint, not an afterthought: a
// document with no sheet must set EXACTLY as it does today. defaultStyleSheet
// is therefore generated from the same layout preset and scale the old code
// path used, and a test asserts the two produce identical paragraphs.

import type { FlowParaStyle } from './designFlow'
import type { ContentBlock } from './designContent'

/** A named paragraph style. `props` is any subset of the engine's style. */
export interface DesignParagraphStyle {
  id: string
  name: string
  /**
   * Inherit from another style in the same sheet. Absent means it stands
   * alone. A cycle is tolerated rather than fatal — see resolveParagraphStyle.
   */
  basedOn?: string
  props: Partial<FlowParaStyle>
}

/**
 * A named character style: the run-level subset. Alignment, indents and space
 * around belong to a paragraph and are deliberately not offered here, because
 * a character style that could change them would silently reflow the page from
 * inside a word.
 */
export type CharacterProps = Pick<
  FlowParaStyle,
  'fontFamily' | 'bold' | 'italic' | 'color' | 'letterSpacing' | 'fontSize'
>

export interface DesignCharacterStyle {
  id: string
  name: string
  basedOn?: string
  props: Partial<CharacterProps>
}

/** Which paragraph style a content block uses when it names none itself. */
export type BlockStyleKey =
  | 'title'
  | 'subtitle'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'caption'

export interface DesignStyleSheet {
  paragraph: DesignParagraphStyle[]
  character?: DesignCharacterStyle[]
  /** Block kind to style id. Missing entries fall back to the body style. */
  blockMap?: Partial<Record<BlockStyleKey, string>>
}

/** The style a block asks for, before the sheet is consulted. */
export function blockStyleKey(b: ContentBlock): BlockStyleKey {
  switch (b.kind) {
    case 'title':
      return 'title'
    case 'subtitle':
      return 'subtitle'
    case 'heading':
      return b.level === 1 ? 'heading1' : b.level === 2 ? 'heading2' : 'heading3'
    case 'list':
      return 'list'
    case 'quote':
      return 'quote'
    default:
      return 'paragraph'
  }
}

export function findParagraphStyle(sheet: DesignStyleSheet, id: string): DesignParagraphStyle | null {
  return sheet.paragraph.find((s) => s.id === id) ?? null
}

/**
 * Resolve a style to the full set of properties the engine wants.
 *
 * Walks the basedOn chain to its root and merges back down, so a child
 * overrides its parent and the parent's other properties survive — which is
 * the entire reason inheritance is worth having.
 *
 * A cycle returns what it has rather than hanging. Styles are editable by
 * people and a cycle is two clicks away ("Body based on Caption, Caption based
 * on Body"); a layout engine that locks up because of it is a worse answer
 * than a style that resolves slightly oddly.
 */
export function resolveParagraphStyle(
  sheet: DesignStyleSheet,
  id: string,
  base: FlowParaStyle
): FlowParaStyle {
  const chain: DesignParagraphStyle[] = []
  const seen = new Set<string>()
  let cur = findParagraphStyle(sheet, id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.basedOn ? findParagraphStyle(sheet, cur.basedOn) : null
  }
  let out: FlowParaStyle = { ...base }
  for (const s of chain) out = { ...out, ...s.props }
  // `font` is the CSS shorthand the measurer and the renderer must agree on,
  // so it is rebuilt from whatever size/family/weight actually won rather than
  // inherited from a parent that had a different size.
  return { ...out, font: fontShorthand(out) }
}

export function resolveCharacterStyle(
  sheet: DesignStyleSheet,
  id: string
): Partial<CharacterProps> {
  const chain: DesignCharacterStyle[] = []
  const seen = new Set<string>()
  let cur = (sheet.character ?? []).find((s) => s.id === id) ?? null
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.basedOn ? ((sheet.character ?? []).find((s) => s.id === cur?.basedOn) ?? null) : null
  }
  let out: Partial<CharacterProps> = {}
  for (const s of chain) out = { ...out, ...s.props }
  return out
}

/** The CSS font shorthand for a resolved style. */
export function fontShorthand(s: Pick<FlowParaStyle, 'fontSize' | 'fontFamily' | 'bold' | 'italic'>): string {
  const size = Math.round(s.fontSize * 100) / 100
  return `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}${size}px ${s.fontFamily ?? 'sans-serif'}`
}

/** Which style id a block resolves to, honouring an explicit override. */
export function styleIdForBlock(sheet: DesignStyleSheet, b: ContentBlock): string {
  const explicit = (b as { styleId?: string }).styleId
  if (explicit && findParagraphStyle(sheet, explicit)) return explicit
  const key = blockStyleKey(b)
  const mapped = sheet.blockMap?.[key]
  if (mapped && findParagraphStyle(sheet, mapped)) return mapped
  // The key doubles as the conventional id, so a sheet that simply names its
  // styles 'heading1', 'quote' and so on needs no map at all.
  if (findParagraphStyle(sheet, key)) return key
  return 'body'
}

/**
 * Rename-safe edit: change one style and return a new sheet.
 *
 * Returns a NEW sheet rather than mutating, because the document is held in
 * React state and an in-place edit would not re-render — and because undo
 * depends on the previous sheet still existing.
 */
export function updateParagraphStyle(
  sheet: DesignStyleSheet,
  id: string,
  patch: Partial<Omit<DesignParagraphStyle, 'id'>>
): DesignStyleSheet {
  return {
    ...sheet,
    paragraph: sheet.paragraph.map((s) =>
      s.id === id ? { ...s, ...patch, props: { ...s.props, ...(patch.props ?? {}) } } : s
    )
  }
}

/** Every style that inherits from `id`, directly or through a chain. */
export function descendantsOf(sheet: DesignStyleSheet, id: string): DesignParagraphStyle[] {
  const out: DesignParagraphStyle[] = []
  let frontier = [id]
  const seen = new Set<string>([id])
  while (frontier.length) {
    const next: string[] = []
    for (const s of sheet.paragraph) {
      if (s.basedOn && frontier.includes(s.basedOn) && !seen.has(s.id)) {
        seen.add(s.id)
        out.push(s)
        next.push(s.id)
      }
    }
    frontier = next
  }
  return out
}

export interface SheetScale {
  body: number
  h1: number
  h2: number
  h3: number
  quote: number
  caption: number
  title: number
  subtitle: number
  bodyFamily: string
  headFamily: string
  ink: string
  accent: string
  muted: string
}

export interface SheetLayout {
  leading: number
  justify: boolean
  dropCap: boolean
  headingRule: boolean
}

const r2 = (n: number): number => Math.round(n * 100) / 100

/**
 * The sheet a document starts with, generated from the layout preset and scale
 * the hard-coded path already used.
 *
 * This is what makes the feature additive instead of a migration: a document
 * with no sheet of its own gets this one, and it sets identically to before.
 * It is also the right starting point for editing — a page-layout tool should
 * open with Body, Heading 1 and Quote already defined, the way InDesign does,
 * not with an empty style palette.
 */
export function defaultStyleSheet(scale: SheetScale, layout: SheetLayout): DesignStyleSheet {
  const body: DesignParagraphStyle = {
    id: 'body',
    name: 'Body',
    props: {
      fontSize: r2(scale.body),
      lineHeight: layout.leading,
      fontFamily: scale.bodyFamily,
      align: layout.justify ? 'justify' : 'left',
      color: scale.ink,
      spaceAfter: r2(scale.body * 0.5),
      widowLines: 2,
      // Stated, not omitted, so the switch is findable — this is the single
      // property that decides whether justified columns get rivers of white.
      //
      // OFF by default, deliberately, even though justified text is exactly
      // where hyphenation earns its place. Turning it on changes where every
      // line breaks, which for a saved multi-page document means repagination
      // and possibly text that now oversets. Looser spacing in an old
      // brochure is a smaller harm than silently re-flowing it, so this is an
      // opt-in: one property on the Body style, and the whole document
      // re-flows with it.
      hyphenate: false
    }
  }

  const heading = (level: 1 | 2 | 3, size: number): DesignParagraphStyle => ({
    id: `heading${level}`,
    name: `Heading ${level}`,
    // Based on Body so a change of ink or family carries through the family,
    // which is exactly what a style sheet is for.
    basedOn: 'body',
    props: {
      fontSize: r2(size),
      lineHeight: 1.2,
      fontFamily: scale.headFamily,
      bold: true,
      align: 'left',
      color: level === 1 ? scale.accent : scale.ink,
      spaceBefore: r2(scale.body * (level === 1 ? 1.5 : 1.1)),
      spaceAfter: r2(scale.body * 0.35),
      keepWithNext: true,
      // Explicitly cleared, not merely unset. Headings are based on Body so a
      // change of ink or family carries through the family, but Body's widow
      // control must not come with it: the inline code never gave a heading
      // widowLines, and inheriting it would change where a long heading
      // breaks across frames. Setting it to undefined is how a child opts OUT
      // of a parent's property under a spread merge.
      widowLines: undefined,
      ...(layout.headingRule && level === 1
        ? { ruleAbove: { width: 1, thickness: Math.max(1, r2(scale.body * 0.07)), color: scale.accent } }
        : {})
    }
  })

  return {
    paragraph: [
      body,
      heading(1, scale.h1),
      heading(2, scale.h2),
      heading(3, scale.h3),
      // Quote, list, caption and attribution reproduce storyParagraphs' values
      // EXACTLY, down to the multiplier. The sheet's promise is that a
      // document with no styles of its own sets as it always has; a quote that
      // is "about right" would silently restyle every existing document the
      // moment this is wired in, which is the kind of change nobody reports as
      // a bug and everybody notices.
      {
        id: 'quote',
        name: 'Quote',
        basedOn: 'body',
        props: {
          fontSize: r2(scale.body * 1.05),
          italic: true,
          color: scale.muted,
          align: 'left',
          leftInset: r2(scale.body * 1.2),
          rightInset: r2(scale.body * 0.6),
          spaceBefore: r2(scale.body * 0.7),
          spaceAfter: r2(scale.body * 0.7),
          // Cleared for the same reason as the headings: the inline code built
          // a quote from scratch and never gave it widow control.
          widowLines: undefined
        }
      },
      {
        id: 'quote-attribution',
        name: 'Quote attribution',
        basedOn: 'body',
        props: {
          fontSize: r2(scale.caption),
          lineHeight: 1.3,
          color: scale.muted,
          align: 'left',
          leftInset: r2(scale.body * 1.2),
          spaceAfter: r2(scale.body * 0.7),
          widowLines: undefined
        }
      },
      {
        id: 'caption',
        name: 'Caption',
        basedOn: 'body',
        props: {
          fontSize: r2(scale.caption),
          lineHeight: 1.3,
          color: scale.muted,
          align: 'left',
          spaceAfter: r2(scale.body * 0.7)
        }
      },
      {
        id: 'list',
        name: 'List item',
        basedOn: 'body',
        props: {
          align: 'left',
          leftInset: r2(scale.body * 1.4),
          spaceAfter: r2(scale.body * 0.22),
          indent: 0
        }
      },
      {
        id: 'title',
        name: 'Title',
        props: {
          fontSize: r2(scale.title),
          lineHeight: 1.05,
          fontFamily: scale.headFamily,
          bold: true,
          align: 'left',
          color: scale.ink
        }
      },
      {
        id: 'subtitle',
        name: 'Subtitle',
        basedOn: 'title',
        props: { fontSize: r2(scale.subtitle), bold: false, color: scale.muted, lineHeight: 1.25 }
      }
    ],
    // Stated rather than left to the fallback. A plain paragraph uses the
    // style called 'body', and relying on styleIdForBlock not finding a style
    // named 'paragraph' would make that behaviour an accident of naming.
    blockMap: {
      paragraph: 'body',
      heading1: 'heading1',
      heading2: 'heading2',
      heading3: 'heading3',
      quote: 'quote',
      list: 'list',
      caption: 'caption',
      title: 'title',
      subtitle: 'subtitle'
    }
  }
}
