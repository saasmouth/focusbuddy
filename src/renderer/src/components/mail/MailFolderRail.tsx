// The folder rail beside the message list.
//
// Its job is not really navigation. It is to make the size of the unsorted pile
// VISIBLE and shrinking: "Unsorted" sits at the top with a live count, and every
// folder made takes messages out of it. That feedback is the only thing that
// makes setting up folders feel worth the minute it costs, and without it this
// would be one more filing system nobody keeps up.
//
// Suggestions come off the real mailbox -- the senders actually filling it --
// so the first folder is one click rather than a form.

import { useMemo, useState } from 'react'
import type { MailFolder, MailListItem } from '@shared/types'
import Icon from '../Icon'
import { useMailFolderStore, type MailScope } from '../../stores/mailFolders'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { folderCounts, uncategorised, suggestFolders } from '../../lib/mailFolders'

/** The tints a folder can carry, so folders are findable by colour. */
export const FOLDER_COLOURS = [
  'sky',
  'violet',
  'emerald',
  'amber',
  'rose',
  'teal',
  'indigo',
  'orange'
] as const

export const COLOUR_DOT: Record<string, string> = {
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  teal: 'bg-teal-500',
  indigo: 'bg-indigo-500',
  orange: 'bg-orange-500'
}

function Row({
  active,
  onClick,
  children,
  testId
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  testId?: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`w-full text-left px-2.5 py-1.5 rounded-[var(--radius-row)] flex items-center gap-2 transition-colors fb-press ${
        active
          ? 'bg-[var(--surface-sunken)] text-[var(--ink-100)]'
          : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]'
      }`}
    >
      {children}
    </button>
  )
}

export default function MailFolderRail({
  messages,
  onEdit,
  onCreate
}: {
  messages: readonly MailListItem[]
  onEdit: (folder: MailFolder) => void
  onCreate: (seed?: { name: string; from: string[] }) => void
}): JSX.Element {
  const folders = useMailFolderStore((s) => s.folders)
  const scope = useMailFolderStore((s) => s.scope)
  const setScope = useMailFolderStore((s) => s.setScope)
  const nodes = useNodeStore((s) => s.nodes)
  const goTask = useViewStore((s) => s.goTask)
  const [showSuggestions, setShowSuggestions] = useState(true)

  const counts = useMemo(() => folderCounts(messages, folders), [messages, folders])
  const unsorted = useMemo(() => uncategorised(messages, folders), [messages, folders])
  const unsortedUnread = unsorted.filter((m) => !m.seen).length
  const inboxUnread = messages.filter((m) => !m.seen).length

  // Only worth offering when there is enough mail to see a pattern in.
  const suggestions = useMemo(
    () => (messages.length >= 10 ? suggestFolders(messages, folders) : []),
    [messages, folders]
  )

  const nodeTitle = (id: string): string | null =>
    nodes.find((n) => n.id === id)?.title ?? null

  const is = (s: MailScope): boolean =>
    scope.kind === s.kind && (s.kind !== 'folder' || (scope.kind === 'folder' && scope.id === s.id))

  return (
    <div
      className="w-56 shrink-0 border-r border-[var(--edge-soft)] flex flex-col overflow-y-auto py-2 px-2 gap-0.5"
      data-testid="mail-folder-rail"
    >
      <Row active={is({ kind: 'inbox' })} onClick={() => setScope({ kind: 'inbox' })} testId="mail-scope-inbox">
        <Icon name="inbox" size={15} className="shrink-0 text-[var(--ink-50)]" />
        <span className="fb-t-label flex-1 min-w-0 truncate">All mail</span>
        <span className="fb-t-caption fb-tabular">{messages.length}</span>
        {inboxUnread > 0 && (
          <span className="fb-t-caption fb-tabular text-accent font-medium">{inboxUnread}</span>
        )}
      </Row>

      {/* The point of the whole feature: what nothing has claimed. It is listed
          second, above the folders, because it is the pile that still needs a
          decision -- and it goes down as folders are made. */}
      <Row
        active={is({ kind: 'unsorted' })}
        onClick={() => setScope({ kind: 'unsorted' })}
        testId="mail-scope-unsorted"
      >
        <Icon name="filter_alt_off" size={15} className="shrink-0 text-[var(--ink-50)]" />
        <span className="fb-t-label flex-1 min-w-0 truncate">Unsorted</span>
        <span className="fb-t-caption fb-tabular" data-testid="mail-unsorted-count">
          {unsorted.length}
        </span>
        {unsortedUnread > 0 && (
          <span className="fb-t-caption fb-tabular text-accent font-medium">{unsortedUnread}</span>
        )}
      </Row>

      {folders.length > 0 && (
        <div className="fb-t-caption px-2.5 pt-3 pb-1 uppercase tracking-wide">Folders</div>
      )}

      {folders.map((f) => {
        const c = counts.get(f.id) ?? { total: 0, unread: 0 }
        const desk = f.nodeId ? nodeTitle(f.nodeId) : null
        return (
          <div key={f.id} className="group/folder relative">
            <Row
              active={is({ kind: 'folder', id: f.id })}
              onClick={() => setScope({ kind: 'folder', id: f.id })}
              testId={`mail-folder-${f.id}`}
            >
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${COLOUR_DOT[f.colour] ?? COLOUR_DOT.sky}`}
              />
              <span className="min-w-0 flex-1">
                <span className="fb-t-label block truncate">{f.name}</span>
                {/* The desk this folder is about. Shown, not hidden in a menu,
                    because "which desk is this about" is the question the link
                    exists to answer. */}
                {desk && (
                  <span
                    role="link"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (f.nodeId) goTask(f.nodeId)
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && f.nodeId) {
                        e.stopPropagation()
                        goTask(f.nodeId)
                      }
                    }}
                    data-testid={`mail-folder-desk-${f.id}`}
                    className="fb-t-caption block truncate hover:text-accent hover:underline cursor-pointer"
                  >
                    {desk}
                  </span>
                )}
              </span>
              <span className="fb-t-caption fb-tabular group-hover/folder:opacity-0 transition-opacity">
                {c.total}
              </span>
              {c.unread > 0 && (
                <span className="fb-t-caption fb-tabular text-accent font-medium group-hover/folder:opacity-0 transition-opacity">
                  {c.unread}
                </span>
              )}
            </Row>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onEdit(f)
              }}
              data-testid={`mail-folder-edit-${f.id}`}
              title={`Edit ${f.name}`}
              aria-label={`Edit ${f.name}`}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 rounded-md inline-flex items-center justify-center opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100 text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-raised)] transition-opacity"
            >
              <Icon name="tune" size={14} />
            </button>
          </div>
        )
      })}

      <button
        onClick={() => onCreate()}
        data-testid="mail-folder-new"
        className="w-full text-left px-2.5 py-1.5 mt-0.5 rounded-[var(--radius-row)] flex items-center gap-2 fb-t-label text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)] transition-colors fb-press"
      >
        <Icon name="create_new_folder" size={15} className="shrink-0" />
        New folder
      </button>

      {/* Read off the mailbox, not invented: each one says how much of the
          unsorted pile it would take away. */}
      {suggestions.length > 0 && showSuggestions && (
        <div className="mt-3" data-testid="mail-folder-suggestions">
          <div className="flex items-center gap-1 px-2.5 pb-1">
            <span className="fb-t-caption uppercase tracking-wide flex-1">Suggested</span>
            <button
              onClick={() => setShowSuggestions(false)}
              title="Hide suggestions"
              aria-label="Hide suggestions"
              className="h-5 w-5 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-80)]"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          {suggestions.map((s) => (
            <button
              key={s.name + (s.from?.[0] ?? '')}
              onClick={() => onCreate({ name: s.name, from: s.from ?? [] })}
              data-testid={`mail-suggestion-${s.from?.[0] ?? s.name}`}
              title={s.reason}
              className="w-full text-left px-2.5 py-1.5 rounded-[var(--radius-row)] flex items-center gap-2 text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)] transition-colors fb-press"
            >
              <Icon name="add" size={14} className="shrink-0 text-[var(--ink-40)]" />
              <span className="fb-t-label flex-1 min-w-0 truncate">{s.name}</span>
              <span className="fb-t-caption fb-tabular shrink-0">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
