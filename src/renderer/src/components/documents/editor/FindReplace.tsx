// Find & replace panel. Drives the SearchHighlight extension: it sets the query,
// steps through matches, and replaces the current hit or all hits. The match
// count and current index come from the plugin state.

import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import Icon from '../../Icon'
import { getSearchState } from './searchHighlight'
import { isValidRegex } from '../../../lib/docFind'

interface Props {
  editor: Editor
  onClose: () => void
  /** Opened as Find and replace… (⇧⌘H, E-14): the Replace row shows. */
  replace?: boolean
}

export default function FindReplace({ editor, onClose, replace = false }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [showReplace, setShowReplace] = useState(replace)
  useEffect(() => {
    if (replace) setShowReplace(true)
  }, [replace])
  const [status, setStatus] = useState({ count: 0, index: 0 })

  // A regex query that doesn't compile: we keep the panel usable and just flag it
  // rather than matching nothing with no explanation.
  const regexBad = regex && query.length > 0 && !isValidRegex(query, caseSensitive)

  // Push the query into the plugin whenever it or the options change. In regex
  // mode wholeWord is meaningless, so it is not sent.
  useEffect(() => {
    editor.commands.setSearch(query, regex ? { caseSensitive, regex: true } : { caseSensitive, wholeWord })
    setStatus(getSearchState(editor))
  }, [editor, query, caseSensitive, wholeWord, regex])

  // Keep the count/index in sync as the selection or document moves.
  useEffect(() => {
    const update = (): void => setStatus(getSearchState(editor))
    editor.on('selectionUpdate', update)
    editor.on('update', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('update', update)
    }
  }, [editor])

  // Clear highlights when the panel closes.
  useEffect(() => {
    return () => {
      editor.commands.clearSearch()
    }
  }, [editor])

  function next(): void {
    editor.commands.findNext()
    setStatus(getSearchState(editor))
  }
  function prev(): void {
    editor.commands.findPrev()
    setStatus(getSearchState(editor))
  }
  function replaceOne(): void {
    editor.commands.replaceCurrent(replacement)
    editor.commands.findNext()
    setStatus(getSearchState(editor))
  }
  function replaceAll(): void {
    editor.commands.replaceAllMatches(replacement)
    setStatus(getSearchState(editor))
  }

  return (
    <div
      data-testid="doc-find-replace"
      className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in absolute top-2 right-2 z-40 w-80 p-2 space-y-1.5"
    >
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.shiftKey ? prev() : next())
            if (e.key === 'Escape') onClose()
          }}
          placeholder={regex ? 'Find (regex)' : 'Find'}
          data-testid="doc-find-input"
          className={`flex-1 bg-[var(--surface-sunken)] border rounded px-2 py-1 text-[12px] ${
            regexBad
              ? 'border-red-400 focus:border-red-500'
              : 'border-[var(--edge-soft)] focus:border-accent'
          }`}
        />
        <span className="text-[11px] text-[var(--ink-40)] tabular-nums w-14 text-center" data-testid="doc-find-count">
          {regexBad ? 'regex!' : status.count ? `${status.index}/${status.count}` : '0/0'}
        </span>
        <button onClick={prev} title="Previous (Shift+Enter)" className="icon-btn">
          <Icon name="keyboard_arrow_up" size={16} />
        </button>
        <button onClick={next} title="Next (Enter)" className="icon-btn">
          <Icon name="keyboard_arrow_down" size={16} />
        </button>
        <button onClick={onClose} title="Close (Esc)" className="icon-btn">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-[var(--ink-50)]">
        <button
          onClick={() => setShowReplace((v) => !v)}
          className="inline-flex items-center gap-0.5 hover:text-accent"
        >
          <Icon name={showReplace ? 'expand_less' : 'expand_more'} size={14} /> Replace
        </button>
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="accent-accent" />
          Case
        </label>
        <label className={`inline-flex items-center gap-1 ${regex ? 'opacity-40' : 'cursor-pointer'}`} title={regex ? 'Not used in regex mode' : 'Match whole words only'}>
          <input type="checkbox" checked={wholeWord} disabled={regex} onChange={(e) => setWholeWord(e.target.checked)} className="accent-accent" />
          Whole word
        </label>
        <label className="inline-flex items-center gap-1 cursor-pointer" title="Regular expression — the thing Google Docs can't do">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} className="accent-accent" data-testid="doc-find-regex" />
          <span className="font-mono">.*</span> Regex
        </label>
      </div>

      {showReplace && (
        <div className="flex items-center gap-1">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with"
            data-testid="doc-replace-input"
            className="fb-field flex-1 px-2 py-1 text-[12px]"
          />
          <button onClick={replaceOne} className="fb-btn-surface px-2 py-1 text-[11px] hover:bg-[var(--surface-sunken)]">
            Replace
          </button>
          <button onClick={replaceAll} data-testid="doc-replace-all" className="px-2 py-1 rounded text-[11px] bg-accent text-white">
            All
          </button>
        </div>
      )}
    </div>
  )
}
