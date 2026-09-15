import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import {
  findMentionQuery,
  insertMention,
  type TextMention
} from '@shared/mentionText'
import { mentionCandidates, type MentionCandidate } from './mentionCandidates'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { useDocumentsStore } from '../stores/documents'
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

/**
 * The handlers a plain <textarea> or <input> needs to understand `@`.
 *
 * Spread onto the field. Everything a caller must not forget lives here: the
 * caret has to be read on keyup as well as change (arrows and clicks move it
 * without changing the value), and keydown has to be able to CONSUME a key so
 * Enter does not both pick a mention and submit the form.
 */
export function mentionFieldProps(
  mentions: MentionAutocomplete,
  onChange: (next: string) => void,
  opts: { onKeyDown?: (e: React.KeyboardEvent) => void } = {}
): {
  onChange: (e: { target: { value: string; selectionStart: number | null } }) => void
  onKeyUp: (e: { currentTarget: { value: string; selectionStart: number | null } }) => void
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  return {
    onChange: (e) => {
      onChange(e.target.value)
      mentions.onInput(e.target.value, e.target.selectionStart ?? e.target.value.length)
    },
    onKeyUp: (e) =>
      mentions.onInput(
        e.currentTarget.value,
        e.currentTarget.selectionStart ?? e.currentTarget.value.length
      ),
    onKeyDown: (e) => {
      if (mentions.onKeyDown(e)) return
      opts.onKeyDown?.(e)
    }
  }
}

export function useMentionAutocomplete(
  value: string,
  onCommit: (next: string, caret: number) => void
): MentionAutocomplete {
  const nodes = useNodeStore((s) => s.nodes)
  const widgets = useWidgetStore((s) => s.widgets)
  const people = usePeopleStore((s) => s.people)
  const loadPeople = usePeopleStore((s) => s.load)
  // Docs, sheets, slides, diagrams, designs and drawings are all documents, so
  // one source covers every PlexiOffice kind -- including ones added later.
  const documents = useDocumentsStore((s) => s.list)
  const refreshDocuments = useDocumentsStore((s) => s.refresh)
  // Tables, so "@Enquiries" reaches the data as well as the desk it sits on.
  const [tables, setTables] = useState<Array<{ id: string; title: string }>>([])

  const [query, setQuery] = useState<{ start: number; end: number; query: string } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    void loadPeople()
    // Documents and tables are fetched once when a picker is first used rather
    // than kept live: a mention list a few seconds stale is fine, and polling
    // for it would not be.
    void refreshDocuments().catch(() => {})
    const api = (window as { api?: Record<string, any> }).api
    void api?.tables
      ?.list?.()
      .then((t: Array<{ id: string; title: string }>) => setTables(t ?? []))
      .catch(() => setTables([]))
  }, [loadPeople, refreshDocuments])

  const candidates = useMemo(
    () =>
      query
        ? mentionCandidates(
            {
              nodes,
              widgets,
              documents: [
                ...documents.map((d) => ({ id: d.id, title: d.title, docType: d.docType })),
                // A table is referenced the same way a document is; labelling
                // it as one keeps the resolver's job unchanged.
                ...tables.map((t) => ({ id: t.id, title: t.title, docType: 'table' }))
              ],
              people: people.map((p) => ({
                accountId: p.accountId,
                name: personName(p),
                email: p.email
              }))
            },
            query.query
          )
        : [],
    [query, nodes, widgets, people, documents, tables]
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
