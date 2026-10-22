// The "/" command extension. Built on @tiptap/suggestion: typing "/" at the
// start of a block opens a filterable menu of block insertions (headings, lists,
// table, code, quote, image, rule). It mounts the React list (SlashMenuList) in
// a fixed-position popup at the caret and forwards keystrokes to it.

import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { ReactRenderer } from '@tiptap/react'
import SlashMenuList from './SlashMenuList'
import type { SlashItem, SlashListHandle } from './SlashMenuList'

const ITEMS: SlashItem[] = [
  { title: 'Heading 1', subtitle: 'Large section title', icon: 'title', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run() },
  { title: 'Heading 2', subtitle: 'Medium section title', icon: 'title', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run() },
  { title: 'Heading 3', subtitle: 'Small section title', icon: 'title', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run() },
  { title: 'Bullet list', subtitle: 'A simple bulleted list', icon: 'format_list_bulleted', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { title: 'Numbered list', subtitle: 'An ordered list', icon: 'format_list_numbered', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { title: 'Checklist', subtitle: 'A list of tasks', icon: 'checklist', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
  { title: 'Table', subtitle: 'Insert a 3x3 table', icon: 'grid_on', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: 'Quote', subtitle: 'A block quotation', icon: 'format_quote', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { title: 'Code block', subtitle: 'Syntax-highlighted code', icon: 'code', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
  { title: 'Divider', subtitle: 'A horizontal rule', icon: 'horizontal_rule', command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
  // Insert group. These open a picker (React state in DocEditor), so they clear
  // the "/" range then call a callback the editor registers in
  // storage.slashCommand (see DocEditor). Guarded so a doc rendered without those
  // callbacks (e.g. a headless/preview mount) simply no-ops instead of throwing.
  {
    title: 'Insert work widget from a desk',
    subtitle: 'Embed a live work widget',
    icon: 'widgets',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run()
      ;(editor.storage.slashCommand as SlashInsertHooks | undefined)?.onInsertWidget?.()
    }
  },
  {
    title: 'Insert office file',
    subtitle: 'Embed a document, sheet or slides',
    icon: 'description',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run()
      ;(editor.storage.slashCommand as SlashInsertHooks | undefined)?.onInsertDoc?.()
    }
  },
  {
    title: 'Insert saved snippet',
    subtitle: 'A reusable block from your library, as a copy or live',
    icon: 'bookmarks',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run()
      ;(editor.storage.slashCommand as SlashInsertHooks | undefined)?.onInsertSnippet?.()
    }
  }
]

// Callbacks the host DocEditor registers so the "/" menu can open its React
// pickers. Null when unset (headless/preview mounts).
export interface SlashInsertHooks {
  onInsertWidget?: (() => void) | null
  onInsertDoc?: (() => void) | null
  /** Opens the saved-snippet library so one can be inserted at the caret. */
  onInsertSnippet?: (() => void) | null
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addStorage() {
    return { onInsertWidget: null, onInsertDoc: null, onInsertSnippet: null } as SlashInsertHooks
  },
  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        command: ({ editor, range, props }: any) => {
          ;(props as SlashItem).command({ editor, range })
        }
      }
    }
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }): SlashItem[] => {
          const q = query.toLowerCase()
          return ITEMS.filter(
            (i) => i.title.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q)
          )
        },
        render: () => {
          let component: ReactRenderer<SlashListHandle> | null = null
          let popup: HTMLDivElement | null = null

          const position = (clientRect: (() => DOMRect | null) | null | undefined): void => {
            if (!popup || !clientRect) return
            const rect = clientRect()
            if (!rect) return
            popup.style.left = `${rect.left}px`
            popup.style.top = `${rect.bottom + 6}px`
          }

          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onStart: (props: any) => {
              component = new ReactRenderer(SlashMenuList, {
                props: {
                  items: props.items,
                  command: (item: SlashItem) => props.command(item)
                },
                editor: props.editor
              })
              popup = document.createElement('div')
              popup.style.position = 'fixed'
              popup.style.zIndex = '300'
              popup.appendChild(component.element)
              document.body.appendChild(popup)
              position(props.clientRect)
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onUpdate: (props: any) => {
              component?.updateProps({
                items: props.items,
                command: (item: SlashItem) => props.command(item)
              })
              position(props.clientRect)
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onKeyDown: (props: any) => {
              if (props.event.key === 'Escape') {
                popup?.remove()
                return true
              }
              return component?.ref?.onKeyDown(props.event) ?? false
            },
            onExit: () => {
              popup?.remove()
              popup = null
              component?.destroy()
              component = null
            }
          }
        }
      })
    ]
  }
})
