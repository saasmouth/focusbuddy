import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  findMentionQuery,
  insertMention,
  type TextMention
} from '@shared/mentionText'
import { mentionCandidates, type MentionCandidate } from './mentionCandidates'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { usePeopleStore, personName } from './peopleDirectory'

// The `@` behaviour, once, for every input that wants it.
//
// A hook rather than a component because the inputs it has to serve are not
// alike: a textarea in a sticky, a one-line cell in a table, a prompt box in
// the assistant. What they share is a string, a caret and a key handler, so
// that is exactly what this takes and returns.

export interface MentionAutocomplete {
  /** Whether the picker should be shown. */
  open: boolean
  candidates: MentionCandidate[]
  activeIndex: number
  /** Call on every change, with the new value and caret. */
  onInput: (value: string, caret: number) => void
  /**
   * Call from onKeyDown. Returns true when the key was consumed, in which case
   * the caller must not also act on it -- otherwise Enter both picks a mention
   * and submits the form.
   */
  onKeyDown: (e: { key: string; preventDefault: () => void }) => boolean
  /** Pick a candidate explicitly (a click). */
  choose: (c: MentionCandidate) => void
  close: () => void
}

export function useMentionAutocomplete(
  value: string,
  onCommit: (next: string, caret: number) => void
): MentionAutocomplete {
  const nodes = useNodeStore((s) => s.nodes)
  const widgets = useWidgetStore((s) => s.widgets)
  const people = usePeopleStore((s) => s.people)
  const loadPeople = usePeopleStore((s) => s.load)

  const [query, setQuery] = useState<{ start: number; end: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    void loadPeople()
  }, [loadPeople])

  const candidates = useMemo(
    () =>
      query
        ? mentionCandidates(
            {
              nodes,
              widgets,
              people: people.map((p) => ({
                accountId: p.accountId,
                name: personName(p),
                email: p.email
              }))
            },
            query.query
          )
        : [],
    [query, nodes, widgets, people]
  )

  useEffect(() => setActiveIndex(0), [query?.query])

  const onInput = useCallback((next: string, caret: number) => {
    setQuery(findMentionQuery(next, caret))
  }, [])

  const commit = useCallback(
    (c: TextMention) => {
      if (!query) return
      const r = insertMention(value, query, {
        kind: c.kind,
        id: c.id,
        title: c.title,
        taskId: c.taskId ?? null
      })
      setQuery(null)
      onCommit(r.text, r.caret)
    },
    [query, value, onCommit]
  )

  const open = query !== null && candidates.length > 0

  const onKeyDown = useCallback(
    (e: { key: string; preventDefault: () => void }): boolean => {
      if (!open) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % candidates.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const c = candidates[activeIndex]
        if (c) commit(c)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setQuery(null)
        return true
      }
      return false
    },
    [open, candidates, activeIndex, commit]
  )

  return {
    open,
    candidates,
    activeIndex,
    onInput,
    onKeyDown,
    choose: commit,
    close: () => setQuery(null)
  }
}
