// "Find and replace…" for the apps whose text lives in many small records
// (PlexiiCells cells; PlexiiDeck paragraphs, table cells and notes). It looks and
// behaves like Write's panel (FindReplace.tsx): the same field, count, arrows,
// options and Replace row, with Enter / Shift+Enter to step and Esc to close.
// The app supplies the records, goes to a hit, and applies replacements.

import { useEffect, useMemo, useState } from 'react'
import Icon from '../../Icon'
import { isValidRegex } from '../../../lib/docFind'
import { findInRecords, replaceHits, type FindRecord, type RecordHit } from '../../../lib/recordFind'

interface Props {
  records: FindRecord[]
  /** Show this hit: select its cell, its slide and element. */
  onGo: (hit: RecordHit) => void
  /**
   * Write these records' new text, as ONE undoable edit. The hits replaced and
   * the replacement come too, for an app whose text is formatted runs (Deck
   * keeps each run's style by replacing the ranges in place).
   */
  onReplace: (changes: FindRecord[], hits: RecordHit[], replacement: string) => void
  onClose: () => void
  /** Prefix for the testids: `${testid}`, `${testid}-input`, `-count`, `-replace-input`, `-replace`, `-replace-all`. */
  testid: string
  /** What is searched, said in the field's placeholder ("Find in this sheet"). */
  scope: string
  /** Opened as Find and replace… (⇧⌘H): the Replace row shows. */
  replace?: boolean
}

export default function RecordFindReplace({ records, onGo, onReplace, onClose, testid, scope, replace = false }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [showReplace, setShowReplace] = useState(replace)
  // Find and replace… asked for while Find… is open shows the Replace row.
  useEffect(() => {
    if (replace) setShowReplace(true)
  }, [replace])
  const [index, setIndex] = useState(0)

  const regexBad = regex && query.length > 0 && !isValidRegex(query, caseSensitive)
  const opts = useMemo(() => (regex ? { caseSensitive, regex: true } : { caseSensitive, wholeWord }), [caseSensitive, wholeWord, regex])
  const hits = useMemo(() => (regexBad ? [] : findInRecords(records, query, opts)), [records, query, opts, regexBad])
  const current = hits.length ? Math.min(index, hits.length - 1) : -1

  // A new query starts from the first hit and shows it.
  useEffect(() => {
    setIndex(0)
  }, [query, opts])
  useEffect(() => {
    if (current >= 0) onGo(hits[current]!)
    // Only when the hit being shown changes, not on every records edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, hits.length, query, opts])

  function step(dir: 1 | -1): void {
    if (!hits.length) return
    setIndex((current + dir + hits.length) % hits.length)
  }
  function replaceOne(): void {
    if (current < 0) return
    onReplace(replaceHits(records, [hits[current]!], replacement), [hits[current]!], replacement)
    // The replaced hit leaves the list, so the same index now names the next one.
  }
  function replaceAll(): void {
    if (!hits.length) return
    onReplace(replaceHits(records, hits, replacement), hits, replacement)
  }

  return (
    <div data-testid={testid} className="fb-glass-panel rounded-[var(--radius-card)] fb-pop-in absolute top-2 right-2 z-40 w-80 p-2 space-y-1.5">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
            if (e.key === 'Escape') onClose()
          }}
          placeholder={regex ? `${scope} (regex)` : scope}
          data-testid={`${testid}-input`}
          className={`flex-1 bg-[var(--surface-sunken)] border rounded px-2 py-1 text-[12px] ${
            regexBad ? 'border-red-400 focus:border-red-500' : 'border-[var(--edge-soft)] focus:border-accent'
          }`}
        />
        <span className="text-[11px] text-[var(--ink-40)] tabular-nums w-14 text-center" data-testid={`${testid}-count`}>
          {regexBad ? 'regex!' : hits.length ? `${current + 1}/${hits.length}` : '0/0'}
        </span>
        <button onClick={() => step(-1)} title="Previous (Shift+Enter)" className="icon-btn">
          <Icon name="keyboard_arrow_up" size={16} />
        </button>
        <button onClick={() => step(1)} title="Next (Enter)" className="icon-btn">
          <Icon name="keyboard_arrow_down" size={16} />
        </button>
        <button onClick={onClose} title="Close (Esc)" className="icon-btn">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-[var(--ink-50)]">
        <button onClick={() => setShowReplace((v) => !v)} className="inline-flex items-center gap-0.5 hover:text-accent">
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
        <label className="inline-flex items-center gap-1 cursor-pointer" title="Regular expression">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} className="accent-accent" />
          <span className="font-mono">.*</span> Regex
        </label>
      </div>

      {showReplace && (
        <div className="flex items-center gap-1">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with"
            data-testid={`${testid}-replace-input`}
            className="fb-field flex-1 px-2 py-1 text-[12px]"
          />
          <button onClick={replaceOne} data-testid={`${testid}-replace`} disabled={current < 0} className="fb-btn-surface px-2 py-1 text-[11px] hover:bg-[var(--surface-sunken)]">
            Replace
          </button>
          <button onClick={replaceAll} data-testid={`${testid}-replace-all`} disabled={!hits.length} className="px-2 py-1 rounded text-[11px] bg-accent text-white">
            All
          </button>
        </div>
      )}
    </div>
  )
}
