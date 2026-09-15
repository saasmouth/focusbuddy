// The single source of truth for the document editor's Tiptap schema.
//
// Both the live editor (DocEditor) and the headless HTML<->JSON converters
// (docHtml.ts, used by AI inserts and .docx import/export) build their extension
// list from here. Sharing one definition is the load-bearing guarantee that a
// round trip through HTML never silently drops or corrupts a node or mark,
// because the editor and the converter always agree on the schema.

import type { Extension, Mark, Node } from '@tiptap/core'
import { DocMentions, type DocMentionHooks } from './docMentions'
import StarterKit from '@tiptap/starter-kit'
import {
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  LineHeight
} from '@tiptap/extension-text-style'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TableKit } from '@tiptap/extension-table'
import { TableHeaderRepeat } from './tableHeaderRepeat'
import { Markdown } from 'tiptap-markdown'
import { createLowlight, common } from 'lowlight'
import { ResizableImage } from './ResizableImage'
import { WidgetEmbedNode } from '../embed/WidgetEmbedNode'
import { DocEmbedNode } from '../embed/DocEmbedNode'
import { SlashCommand } from './SlashMenu'
import { SearchHighlight } from './searchHighlight'
import { FocusBlock } from './focusBlock'
import { PagePagination } from './pagination'
import { CommentMark } from './CommentMark'
import { TrackChanges, InsertionMark, DeletionMark } from './TrackChanges'
import { TableOfContents } from './TableOfContents'
import { Footnote } from './Footnote'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import type { Doc as YDoc } from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

const lowlight = createLowlight(common)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExt = Extension<any, any> | Mark<any, any> | Node<any, any>

interface BuildOptions {
  // The live editor wants the interactive niceties (placeholder, slash menu,
  // image NodeView). The headless converter only needs the schema, so it omits
  // them — the resulting document JSON is identical either way.
  interactive?: boolean
  // When set, the editor is a real-time collaborator on this Yjs document: we
  // add the Collaboration extension and turn StarterKit's own undo/redo off,
  // because Collaboration provides CRDT-aware history and the two conflict.
  collab?: YDoc
  // When set alongside collab, render other people's live cursors/selections.
  awareness?: Awareness
  // `@` mentions. Interactive editors pass hooks and mount a DocMentionPicker;
  // the headless converter passes nothing, and the extension then does nothing
  // -- a mention in a document is a plain link, so conversion needs no help.
  mentionHooks?: DocMentionHooks | null
  // The local user's label + colour shown on their caret to peers.
  user?: { name: string; color: string }
}

export function buildDocExtensions(opts: BuildOptions = {}): AnyExt[] {
  const interactive = opts.interactive ?? true
  const collab = opts.collab
  const exts: AnyExt[] = [
    // StarterKit v3 already provides bold, italic, strike, code, underline,
    // link, bullet/ordered/list-item, blockquote, horizontal-rule, heading and
    // undo/redo. We turn its plain code block off in favour of the syntax-
    // highlighted one below, widen headings to H1-H6, and configure links to not
    // navigate on click (the editor opens an edit popover instead).
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: true,
        // `plexii` is ours, and the Link mark drops hrefs whose scheme it does
        // not know -- so an @-mention inserted as a link silently arrived as
        // plain text. Registering the protocol is what makes a mention survive
        // being written, saved, exported and read back.
        protocols: ['http', 'https', 'mailto', 'plexii'],
        isAllowedUri: (url: string, ctx: { defaultValidate: (u: string) => boolean }) =>
          url.startsWith('plexii://') || ctx.defaultValidate(url)
      },
      // Collaboration brings its own CRDT-aware undo/redo; StarterKit's would
      // fight it, so disable it in collab mode.
      ...(collab ? { undoRedo: false } : {})
    }) as AnyExt,
    // Inline text styling, all carried on the textStyle mark so colour, font and
    // size coexist on one selection and serialise to inline CSS (which is what
    // .docx import/export round-trips through).
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    LineHeight,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript,
    Superscript,
    // Tables with interactive column resizing.
    TableKit.configure({ table: { resizable: true } }) as AnyExt,
    // Word/Docs behaviour, opt-in per table from the right-click menu: when a
    // table is split across pages, repeat its header row at the top of each
    // continuation so the columns stay readable. Stored on the table node so it
    // travels with the document and survives reload and export.
    TableHeaderRepeat as AnyExt,
    TaskList,
    TaskItem.configure({ nested: true }),
    CodeBlockLowlight.configure({ lowlight }),
    // html:true keeps formatting (colour, alignment, tables) when AI/imported
    // HTML is pasted or inserted, instead of flattening to plain markdown.
    Markdown.configure({ html: true, transformPastedText: true, transformCopiedText: false }) as AnyExt,
    // Comment anchors. Always present so a doc carrying comment marks renders the
    // highlight; the thread bodies live on the server.
    CommentMark as AnyExt,
    // Track Changes (suggesting mode): the insertion/deletion marks are always
    // present so a doc carrying suggestions renders them, and .docx/HTML round
    // trips keep them; the capture plugin is inert until suggesting is toggled on.
    InsertionMark as AnyExt,
    DeletionMark as AnyExt,
    TrackChanges as AnyExt,
    // Desk-widget embeds. In BOTH branches: the schema must be shared with the
    // headless converters or a document carrying an embed would lose it on an
    // HTML round trip. Headless use only exercises renderHTML/parseHTML.
    WidgetEmbedNode as AnyExt,
    // PlexiOffice document embeds (a doc/sheet/slides/etc referenced inside a
    // doc). Same shared-schema requirement as widget embeds so it round-trips
    // through the headless HTML / .docx converters.
    DocEmbedNode as AnyExt,
    // A Word-style Table of Contents built from the document's headings.
    TableOfContents as AnyExt,
    // Auto-numbered inline footnotes with editable note text.
    Footnote as AnyExt
  ]

  if (interactive) {
    exts.push(
      ResizableImage.configure({ inline: false, allowBase64: true }) as AnyExt,
      Placeholder.configure({
        placeholder: 'Write something, press "/" for commands, or use Ask AI…'
      }),
      CharacterCount as AnyExt,
      SlashCommand as AnyExt,
      SearchHighlight as AnyExt,
      FocusBlock as AnyExt,
      // Page view: measures blocks and inserts transparent spacers so content
      // flows onto discrete sheets with a real gap between pages. Inert unless
      // page view is on (it reads its config from the active DocEditor).
      PagePagination as AnyExt
    )
  } else {
    // Headless: a plain image node with the identical schema (no NodeView) plus
    // the character counter, so generateJSON/generateHTML parse images and never
    // touch React.
    exts.push(
      ResizableImage.configure({ inline: false, allowBase64: true }) as AnyExt,
      CharacterCount as AnyExt
    )
  }

  if (collab) {
    exts.push(Collaboration.configure({ document: collab, field: 'default' }) as AnyExt)
    if (opts.awareness) {
      exts.push(
        CollaborationCaret.configure({
          provider: { awareness: opts.awareness },
          user: opts.user ?? { name: 'Someone', color: '#888888' }
        }) as AnyExt
      )
    }
  }

  if (interactive && opts.mentionHooks) {
    exts.push(DocMentions.configure({ hooks: opts.mentionHooks }) as AnyExt)
  }

  return exts
}
