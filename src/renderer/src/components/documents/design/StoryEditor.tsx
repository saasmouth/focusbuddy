import { useEffect, useRef, useState } from 'react'
import Icon from '../../Icon'
import { contentStats, parsePlainText } from '@shared/designContent'
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
  const frames = (design.pages ?? []).reduce(
    (n, pg) => n + pg.elements.filter((el) => el.type === 'text' && el.storyId === storyId).length,
    0
  )

  return (
    <div className="w-72 shrink-0 border-l border-[var(--edge-soft)] flex flex-col text-[12px]" data-testid="design-story-editor">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--edge-soft)]">
        <Icon name="edit_note" size={15} className="text-accent" />
        <span className="flex-1 text-[11px] font-medium text-[var(--ink-80)]">Story editor</span>
        <button onClick={onClose} className="icon-btn !h-6 !w-6" title="Close the story editor" aria-label="Close the story editor">
          <Icon name="close" size={14} />
        </button>
      </div>

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
        <p className="text-[10px] text-[var(--ink-40)] leading-snug">
          <code>###</code> heading · <code>-</code> bullet · <code>1.</code> numbered · <code>&gt;</code> quote · blank line for a new paragraph
        </p>
      </div>
    </div>
  )
}
