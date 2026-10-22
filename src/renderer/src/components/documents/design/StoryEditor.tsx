import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { contentStats, parsePlainText } from '@shared/designContent'
import { storyFootnotes } from '@shared/designFootnoteText'
import type { DesignBody } from '@shared/design'

// The story editor — where threaded text is actually written.
//
// InDesign has one for the same reason this does: you cannot sensibly type a
// five-page article inside a two-inch column on a zoomed-out page. The frames
// show the typeset result; this panel shows the words. Editing here reflows
// every linked frame live.
//
// The markup is deliberately the same markdown-ish shorthand the wizard accepts,
// so what you paste in and what you edit afterwards are the same language.

interface Props {
  design: DesignBody
  storyId: string
  text: string
  /** Set when the last frame of the chain still has text waiting. */
  overset: boolean
  onChange: (text: string) => void
  /** Finish with the story: the host closes this pane. */
  onClose: () => void
  onAddPage: () => void
}

export default function StoryEditor({ design, storyId, text, overset, onChange, onClose, onAddPage }: Props): JSX.Element {
  const [draft, setDraft] = useState(text)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const lastExternal = useRef(text)

  // Follow the document when the story is changed elsewhere (a re-layout, an
  // undo), but never fight the cursor while the author is typing.
  useEffect(() => {
    if (text !== lastExternal.current) {
      lastExternal.current = text
      setDraft(text)
    }
  }, [text])

  useEffect(() => {
    ref.current?.focus()
  }, [storyId])

  const stats = contentStats(parsePlainText(draft, { firstLineIsTitle: false }))
  const notes = storyFootnotes(parsePlainText(draft, { firstLineIsTitle: false }))

  /**
   * Insert a footnote: a marker where the caret is, and its definition at the
   * end, with the caret left in the definition so the next thing typed is the
   * note. The number is the lowest unused one, so inserting between two
   * existing notes does not collide — the printed numbering comes from reading
   * order anyway, not from the id.
   */
  function insertFootnote(): void {
    const el = ref.current
    const at = el ? el.selectionStart : draft.length
    const used = new Set(notes.map((n) => n.id))
    let n = 1
    while (used.has(String(n))) n += 1
    const id = String(n)
    const marker = `[^${id}]`
    const withMarker = `${draft.slice(0, at)}${marker}${draft.slice(at)}`
    const sep = withMarker.endsWith('\n') ? '\n' : '\n\n'
    const next = `${withMarker}${sep}[^${id}]: `
    setDraft(next)
    lastExternal.current = next
    onChange(next)
    // After the state has landed, put the caret after the definition's colon.
    requestAnimationFrame(() => {
      const t = ref.current
      if (!t) return
      t.focus()
      t.setSelectionRange(next.length, next.length)
    })
  }
  const frames = (design.pages ?? []).reduce(
    (n, pg) => n + pg.elements.filter((el) => el.type === 'text' && el.storyId === storyId).length,
    0
  )

  // A pane BODY: the shared ShellSidePane draws the frame, the "Story" title
  // and the collapse control, and carries the design-story-editor testid on its
  // tabpanel (SPEC §2.5a). So the close that used to sit in this component's
  // own header is now "Done" in the footer instead: a second close up top
  // would have titled the pane twice, and collapsing the pane — which also
  // ends the story — is not something anyone would discover.
  return (
    <div className="flex h-full flex-col text-[12px]">

      <textarea
        ref={ref}
        value={draft}
        data-testid="design-story-text"
        onChange={(e) => {
          setDraft(e.target.value)
          lastExternal.current = e.target.value
          onChange(e.target.value)
        }}
        placeholder={'Type the story. It flows through every linked frame.\n\n### Heading\n- bullet\n> quote'}
        className="flex-1 min-h-0 w-full resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed outline-none font-mono text-[var(--ink-90)]"
      />

      <div className="shrink-0 border-t border-[var(--edge-soft)] px-2 py-1.5 space-y-1.5">
        <div className="text-[10px] text-[var(--ink-40)]">
          {stats.words.toLocaleString()} words flowing through {frames} frame{frames === 1 ? '' : 's'}
        </div>
        {overset && (
          <div className="rounded border border-amber-400/60 bg-amber-400/10 px-2 py-1.5" data-testid="design-story-overset">
            <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <Icon name="warning" size={13} className="mt-0.5 shrink-0" />
              <span>The last frame is full — there is more text than the pages can hold.</span>
            </div>
            <button onClick={onAddPage} data-testid="design-story-add-page" className="fb-btn-surface w-full mt-1.5 px-2 py-1 text-[11px] hover:border-accent">
              Add a page and continue the story
            </button>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="fb-btn-surface px-2 py-1 text-[11px] hover:border-accent"
            data-testid="design-story-close"
            title="Finish with this story and close its pane"
          >
            Done
          </button>
          <button
            onClick={insertFootnote}
            className="fb-btn-surface px-2 py-1 text-[11px] hover:border-accent"
            data-testid="design-insert-footnote"
            title="Put a footnote marker here and its note at the foot of the frame"
          >
            Add a footnote
          </button>
          {notes.length > 0 && (
            <span className="fb-t-caption text-[var(--ink-40)]" data-testid="design-footnote-count">
              {notes.length} note{notes.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="text-[10px] text-[var(--ink-40)] leading-snug">
          <code>###</code> heading · <code>-</code> bullet · <code>1.</code> numbered · <code>&gt;</code> quote · blank line for a new paragraph
        </p>
        <p className="text-[10px] text-[var(--ink-40)] leading-snug">
          A footnote is <code>[^1]</code> where the marker goes, and <code>[^1]: the note</code> on its own line. The
          note sets at the foot of whichever frame its marker lands in, and renumbers itself as the text moves.
        </p>
      </div>
    </div>
  )
}
