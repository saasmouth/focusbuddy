import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { mentionCandidates, type MentionCandidate } from '../../../lib/mentionCandidates'
import { useNodeStore } from '../../../stores/nodes'
import { useWidgetStore } from '../../../stores/widgets'
import { useDocumentsStore } from '../../../stores/documents'
import { usePeopleStore, personName } from '../../../lib/peopleDirectory'
import { MENTION_ICON } from '../../MentionText'
import Icon from '../../Icon'
import { insertDocMention, type DocMentionQuery } from './docMentions'

// The `@` picker for rich-text documents.
//
// Portalled to <body> at the caret's own coordinates, because a document
// scrolls inside its own pane and an absolutely positioned menu near the
// bottom of one gets clipped -- the same reason the assistant's status menu is
// portalled (DEC-132).
//
// Mount one of these next to an editor and pass it the query the extension
// reports; it owns nothing else.

export default function DocMentionPicker({
  editor,
  query,
  onClose,
  registerKeyHandler
}: {
  editor: { chain: () => any } | null
  query: DocMentionQuery | null
  onClose: () => void
  /** Give the parent a handler to feed the extension's keydown into. */
  registerKeyHandler?: (h: (e: KeyboardEvent) => boolean) => void
}): JSX.Element | null {
  const nodes = useNodeStore((s) => s.nodes)
  const refreshNodes = useNodeStore((s) => s.refresh)
  const widgets = useWidgetStore((s) => s.widgets)
  const documents = useDocumentsStore((s) => s.list)
  const refreshDocuments = useDocumentsStore((s) => s.refresh)
  const people = usePeopleStore((s) => s.people)
  const loadPeople = usePeopleStore((s) => s.load)
  const [active, setActive] = useState(0)
  const [tables, setTables] = useState<Array<{ id: string; title: string }>>([])

  useEffect(() => {
    void loadPeople()
    // A full-screen document view never loads the node tree -- it is not a
    // desk -- so without this the picker offered nothing at all there.
    if (nodes.length === 0) void refreshNodes().catch(() => {})
    void refreshDocuments().catch(() => {})
    const api = (window as { api?: Record<string, any> }).api
    void api?.tables
      ?.list?.()
      .then((t: Array<{ id: string; title: string }>) => setTables(t ?? []))
      .catch(() => setTables([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPeople, refreshDocuments])

  const candidates = useMemo<MentionCandidate[]>(
    () =>
      query
        ? mentionCandidates(
            {
              nodes,
              widgets,
              documents: [
                ...documents.map((d) => ({ id: d.id, title: d.title, docType: d.docType })),
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
    [query, nodes, widgets, documents, tables, people]
  )

  useEffect(() => setActive(0), [query?.query])

  const choose = (c: MentionCandidate): void => {
    if (!editor || !query) return
    insertDocMention(editor, { from: query.from, to: query.to }, c)
    onClose()
  }

  // The extension asks us whether a key was consumed, so Enter picks a mention
  // instead of breaking the paragraph.
  useEffect(() => {
    if (!registerKeyHandler) return
    registerKeyHandler((e: KeyboardEvent): boolean => {
      if (!query || candidates.length === 0) return false
      if (e.key === 'ArrowDown') {
        setActive((i) => (i + 1) % candidates.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        setActive((i) => (i - 1 + candidates.length) % candidates.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const c = candidates[active]
        if (c) choose(c)
        return true
      }
      if (e.key === 'Escape') {
        onClose()
        return true
      }
      return false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerKeyHandler, query, candidates, active])

  if (!query || candidates.length === 0 || !query.rect) return null

  return createPortal(
    <div
      className="fixed z-[300] max-h-[220px] w-[250px] overflow-y-auto rounded-md border border-[var(--line)] bg-[var(--surface-raised)] py-1 shadow-lg"
      style={{ top: Math.round(query.rect.bottom + 4), left: Math.round(query.rect.left) }}
      onMouseDown={(e) => e.preventDefault()}
      data-testid="mention-picker"
    >
      {candidates.map((c, i) => (
        <button
          key={`${c.kind}:${c.id}`}
          type="button"
          onClick={() => choose(c)}
          className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] ${
            i === active
              ? 'bg-accent/10 text-[var(--ink-90)]'
              : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
          }`}
        >
          <Icon
            name={c.icon || MENTION_ICON[c.kind] || 'link'}
            size={12}
            className="shrink-0 text-[var(--ink-40)]"
          />
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
          {c.detail && <span className="shrink-0 text-[9px] text-[var(--ink-35)]">{c.detail}</span>}
        </button>
      ))}
    </div>,
    document.body
  )
}
