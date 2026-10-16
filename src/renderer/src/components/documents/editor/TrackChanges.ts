import { Extension, Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Node as PmNode } from '@tiptap/pm/model'
import {
  acceptTrackedChanges,
  rejectTrackedChanges,
  INSERTION_MARK,
  DELETION_MARK,
  type PmNode as JsonNode
} from '../../../lib/trackChanges'

// Track Changes (suggesting mode) for PlexiDocs. When active, edits are recorded
// as suggestions rather than applied directly: typed/inserted text is wrapped in
// an `insertion` mark, and deletions are wrapped in a `deletion` mark (struck
// through) instead of being removed. Accepting realises the suggestions;
// rejecting discards them. The marks are ordinary ProseMirror marks, so on a
// live-collaborative doc they sync through Yjs like any other formatting.
//
// Scope note: deletion capture covers the keyboard editing gestures (Backspace,
// Delete, and replacing a selection by typing). Structural joins at a block edge
// pass through as normal edits — they are not tombstoned.

export interface TrackUser {
  author: string
  color: string
}

const trackKey = new PluginKey('trackChanges')

function attrs(user: TrackUser): Record<string, unknown> {
  // ts is stamped at author time so a reviewer can see when a change was made.
  return { author: user.author, color: user.color, ts: Date.now() }
}

// How a suggestion is written to HTML, and why it is not a styled <span>.
//
// These marks used to render as <span class="tc-insert" style="text-decoration:
// underline">. ProseMirror reads a `text-decoration` inline style with the
// Underline and Strike extensions' own parse rules, so any HTML round trip (copy
// and paste, an HTML import, a reopen through HTML) brought every suggestion back
// carrying a second, ordinary underline or strike mark. "Accept all" then did
// exactly what it says to the suggestion marks and left the ordinary ones behind:
// the help audit's "suggestions remain as plain strike/underline formatting".
//
// Now an insertion is <ins class="tc-insert"> and a deletion <del class="tc-delete">.
// Browsers and Word exports draw both without any inline text-decoration, the
// colour travels as a CSS custom property no parse rule reads, and the rules
// below outrank Strike's own `del` rule. Spans written by the old renderer still
// parse; they are flagged `legacyStyle` so accept/reject also clears the
// ordinary mark their inline style produced (see lib/trackChanges).
function markSpec(name: string, className: string, tag: 'ins' | 'del') {
  return Mark.create({
    name,
    inclusive: false,
    // Excludes only itself: a deletion can sit beside an insertion, but striking
    // already-struck text replaces the mark instead of nesting a second one
    // (which rendered as <del><del>…</del></del> and doubled the count).
    excludes: name,
    addAttributes() {
      return {
        author: { default: null, parseHTML: (el) => el.getAttribute('data-author'), renderHTML: (a) => (a.author ? { 'data-author': a.author } : {}) },
        color: { default: null, parseHTML: (el) => el.getAttribute('data-color'), renderHTML: (a) => (a.color ? { 'data-color': a.color } : {}) },
        ts: { default: null, parseHTML: (el) => Number(el.getAttribute('data-ts')) || null, renderHTML: (a) => (a.ts ? { 'data-ts': String(a.ts) } : {}) },
        // Never rendered: it only records that this mark was read from an old
        // styled span, whose inline style also produced an underline/strike mark.
        legacyStyle: {
          default: null,
          parseHTML: (el) => (el.tagName === 'SPAN' && /text-decoration/i.test(el.getAttribute('style') ?? '') ? true : null),
          renderHTML: () => ({})
        }
      }
    },
    parseHTML() {
      // Priority above the default 50 so Strike's plain `del` rule never claims
      // a suggestion first.
      return [
        { tag: `${tag}.${className}`, priority: 60 },
        { tag: `span.${className}`, priority: 60 }
      ]
    },
    renderHTML({ HTMLAttributes }) {
      const color = (HTMLAttributes as Record<string, string>)['data-color']
      const extra: Record<string, string> = { class: className }
      if (color) extra.style = `--tc-color: ${color}`
      return [tag, mergeAttributes(HTMLAttributes, extra), 0]
    }
  })
}

export const InsertionMark = markSpec(INSERTION_MARK, 'tc-insert', 'ins')
export const DeletionMark = markSpec(DELETION_MARK, 'tc-delete', 'del')

// Does every text node in [from,to) carry the given mark? Used to decide whether
// deleting a range removes a fresh suggestion outright or tombstones committed
// text.
function rangeFullyMarked(state: EditorState, from: number, to: number, markName: string): boolean {
  const markType = state.schema.marks[markName]
  if (!markType || from >= to) return false
  let all = true
  let sawText = false
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      sawText = true
      if (!markType.isInSet(node.marks)) all = false
    }
  })
  return sawText && all
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      setSuggesting: (on: boolean) => ReturnType
      setTrackUser: (user: TrackUser) => ReturnType
      acceptAllChanges: () => ReturnType
      rejectAllChanges: () => ReturnType
    }
  }
}

export interface TrackChangesStorage {
  active: boolean
  user: TrackUser
}

export const TrackChanges = Extension.create<{ user?: TrackUser }, TrackChangesStorage>({
  name: 'trackChanges',

  addStorage() {
    return { active: false, user: this.options.user ?? { author: 'You', color: '#2563eb' } }
  },

  addCommands() {
    return {
      setSuggesting:
        (on: boolean) =>
        () => {
          this.storage.active = on
          return true
        },
      setTrackUser:
        (user: TrackUser) =>
        () => {
          this.storage.user = user
          return true
        },
      acceptAllChanges:
        () =>
        ({ state, tr, dispatch }) => {
          const next = acceptTrackedChanges(state.doc.toJSON() as JsonNode)
          const node = PmNode.fromJSON(state.schema, next)
          tr.replaceWith(0, state.doc.content.size, node.content)
          tr.setMeta(trackKey, true) // don't re-capture this rebuild
          tr.setMeta('addToHistory', true)
          if (dispatch) dispatch(tr)
          return true
        },
      rejectAllChanges:
        () =>
        ({ state, tr, dispatch }) => {
          const next = rejectTrackedChanges(state.doc.toJSON() as JsonNode)
          const node = PmNode.fromJSON(state.schema, next)
          tr.replaceWith(0, state.doc.content.size, node.content)
          tr.setMeta(trackKey, true)
          tr.setMeta('addToHistory', true)
          if (dispatch) dispatch(tr)
          return true
        }
    }
  },

  // Deletion capture: Backspace / Delete tombstone committed text (or remove a
  // fresh suggestion) instead of deleting.
  addKeyboardShortcuts() {
    const handleDelete = (dir: 'back' | 'forward'): boolean => {
      if (!this.storage.active) return false
      const { state, view } = this.editor
      const delType = state.schema.marks[DELETION_MARK]
      if (!delType) return false
      let { from, to } = state.selection
      const empty = from === to
      if (empty) {
        if (dir === 'back') {
          if (from === 0) return false
          from = from - 1
        } else {
          if (to >= state.doc.content.size) return false
          to = to + 1
        }
      }
      // Only handle real text deletions; a block-boundary join has no text and is
      // left to default behaviour.
      if (!state.doc.textBetween(from, to, '￿').replace(/￿/g, '')) return false

      const tr = state.tr
      if (rangeFullyMarked(state, from, to, INSERTION_MARK)) {
        tr.delete(from, to) // removing your own un-accepted suggestion
      } else {
        tr.addMark(from, to, delType.create(attrs(this.storage.user)))
        // Move the cursor past the struck text so repeated presses advance.
        const caret = dir === 'back' ? from : to
        tr.setSelection(TextSelection.create(tr.doc, caret))
      }
      tr.setMeta(trackKey, true)
      view.dispatch(tr)
      return true
    }
    return {
      Backspace: () => handleDelete('back'),
      Delete: () => handleDelete('forward')
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    return [
      new Plugin({
        key: trackKey,
        props: {
          // Typing over a non-empty selection: tombstone the selection, then
          // insert the typed text as a suggestion after it.
          handleTextInput(view, from, to, text) {
            if (!storage.active || from === to) return false
            const { state } = view
            const delType = state.schema.marks[DELETION_MARK]
            const insType = state.schema.marks[INSERTION_MARK]
            if (!delType || !insType) return false
            const tr = state.tr
            if (!rangeFullyMarked(state, from, to, INSERTION_MARK)) {
              tr.addMark(from, to, delType.create(attrs(storage.user)))
            } else {
              tr.delete(from, to)
            }
            const insertAt = tr.selection.to
            tr.insert(insertAt, state.schema.text(text, [insType.create(attrs(storage.user))]))
            tr.setSelection(TextSelection.create(tr.doc, insertAt + text.length))
            tr.setMeta(trackKey, true)
            view.dispatch(tr)
            return true
          }
        },
        // Insertion capture: mark any text the transaction inserted (typing,
        // paste, AI insert) with the insertion mark.
        appendTransaction(trs, _oldState, newState) {
          if (!storage.active) return null
          if (trs.every((t) => !t.docChanged)) return null
          if (trs.some((t) => t.getMeta(trackKey))) return null
          const insType = newState.schema.marks[INSERTION_MARK]
          const delType = newState.schema.marks[DELETION_MARK]
          if (!insType) return null
          let tr: Transaction | null = null
          for (const orig of trs) {
            orig.steps.forEach((step, i) => {
              step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd <= newStart) return
                // Map the inserted range forward through this transaction's later
                // steps so it points into newState's doc.
                let from = newStart
                let end = newEnd
                for (let j = i + 1; j < orig.steps.length; j++) {
                  const m = orig.steps[j].getMap()
                  from = m.map(from, -1)
                  end = m.map(end, 1)
                }
                if (!tr) tr = newState.tr
                tr.addMark(from, end, insType.create(attrs(storage.user)))
                // Inserted-and-marked text is a fresh suggestion, never also a deletion.
                if (delType) tr.removeMark(from, end, delType)
              })
            })
          }
          if (tr) {
            ;(tr as Transaction).setMeta(trackKey, true)
            ;(tr as Transaction).setMeta('addToHistory', false)
            return tr
          }
          return null
        }
      })
    ]
  }
})
