// Editing what belongs in a folder.
//
// The rule is shown in full and in plain words, never summarised behind a
// "configure" button, because a filtered view that hides its own rule is one
// you cannot trust: an empty folder and a broken rule look identical from the
// outside. The live count at the bottom answers "is this rule right" before
// anything is saved.

import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import type { MailFolder, MailListItem, InboxRules } from '@shared/types'
import Icon from '../Icon'
import { useMailFolderStore } from '../../stores/mailFolders'
import { useNodeStore } from '../../stores/nodes'
import { inFolder } from '../../lib/mailFolders'
import { describeRules } from '../../lib/inboxFilter'
import { FOLDER_COLOURS, COLOUR_DOT } from './MailFolderRail'

/** A comma-separated field edited as text and stored as terms. */
const toTerms = (raw: string): string[] =>
  raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

export default function MailFolderEditor({
  folder,
  seed,
  messages,
  onClose
}: {
  /** The folder being edited, or null when making a new one. */
  folder: MailFolder | null
  /** Starting values for a new folder, from a suggestion or a message. */
  seed?: { name: string; from: string[] } | null
  messages: readonly MailListItem[]
  onClose: () => void
}): JSX.Element {
  const create = useMailFolderStore((s) => s.create)
  const update = useMailFolderStore((s) => s.update)
  const remove = useMailFolderStore((s) => s.remove)
  const nodes = useNodeStore((s) => s.nodes)

  const [name, setName] = useState(folder?.name ?? seed?.name ?? '')
  const [colour, setColour] = useState(folder?.colour ?? 'sky')
  const [from, setFrom] = useState((folder?.rules.from ?? seed?.from ?? []).join(', '))
  const [subject, setSubject] = useState((folder?.rules.subject ?? []).join(', '))
  const [unreadOnly, setUnreadOnly] = useState(folder?.rules.unreadOnly ?? false)
  const [withAttachments, setWithAttachments] = useState(folder?.rules.withAttachments ?? false)
  const [nodeId, setNodeId] = useState<string | null>(folder?.nodeId ?? null)
  const [saving, setSaving] = useState(false)

  const rules: InboxRules = useMemo(
    () => ({
      from: toTerms(from),
      subject: toTerms(subject),
      unreadOnly: unreadOnly || undefined,
      withAttachments: withAttachments || undefined
    }),
    [from, subject, unreadOnly, withAttachments]
  )

  // What this rule catches RIGHT NOW, against the mail actually in hand. The
  // pinned/excluded lists come along so the preview matches what the folder
  // will really hold, not just what the rule alone would.
  const preview = useMemo(() => {
    const probe: MailFolder = {
      id: folder?.id ?? 'preview',
      name: name || 'Preview',
      colour,
      rules,
      nodeId,
      pinned: folder?.pinned ?? [],
      excluded: folder?.excluded ?? [],
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0
    }
    return messages.filter((m) => inFolder(m, probe))
  }, [messages, rules, folder, name, colour, nodeId])

  // A desk and a task are the same node kind here, so one picker covers both.
  const desks = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'task' && !n.archived)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [nodes]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (): Promise<void> => {
    setSaving(true)
    if (folder) {
      await update(folder.id, { name, colour, rules, nodeId })
    } else {
      await create({ name: name.trim() || 'New folder', colour, rules, nodeId })
    }
    setSaving(false)
    onClose()
  }

  const field =
    'w-full rounded-lg px-2.5 py-1.5 fb-t-label fb-field'

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-6" data-testid="mail-folder-editor">
      <div className="fb-scrim absolute inset-0" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32, mass: 0.8 }}
        className="relative w-[520px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-2xl fb-glass-panel ring-1 ring-black/[0.10] dark:ring-white/[0.10] overflow-hidden"
      >
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-[var(--edge-soft)] shrink-0">
          <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${COLOUR_DOT[colour] ?? COLOUR_DOT.sky}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-[var(--ink-100)] truncate">
              {folder ? 'Edit folder' : 'New folder'}
            </div>
            <div className="fb-t-caption leading-snug">
              Nothing moves on your mail server — a folder is a way of looking at your inbox.
            </div>
          </div>
          <button onClick={onClose} title="Close" aria-label="Close" className="icon-btn shrink-0">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className="fb-t-caption block mb-1" htmlFor="folder-name">
              Name
            </label>
            <input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme, Invoices, Ridge St…"
              data-testid="folder-name"
              className={field}
              autoFocus
            />
          </div>

          <div>
            <span className="fb-t-caption block mb-1.5">Colour</span>
            <div className="flex items-center gap-1.5">
              {FOLDER_COLOURS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColour(c)}
                  aria-label={c}
                  data-testid={`folder-colour-${c}`}
                  className={`h-6 w-6 rounded-full ${COLOUR_DOT[c]} transition-transform ${
                    colour === c ? 'ring-2 ring-offset-2 ring-offset-[var(--surface-raised)] ring-[var(--ink-60)] scale-110' : 'hover:scale-110'
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2.5 rounded-xl border border-[var(--edge-soft)] p-3">
            <div className="fb-t-caption">
              What goes in here. Terms are separated by commas; any one of them
              matching is enough.
            </div>
            <div>
              <label className="fb-t-caption block mb-1" htmlFor="folder-from">
                From — name, address, or a whole domain
              </label>
              <input
                id="folder-from"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="acme.com, sarah@, the conveyancer"
                data-testid="folder-from"
                className={field}
              />
            </div>
            <div>
              <label className="fb-t-caption block mb-1" htmlFor="folder-subject">
                Subject contains
              </label>
              <input
                id="folder-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="invoice, Ridge St"
                data-testid="folder-subject"
                className={field}
              />
            </div>
            <div className="flex items-center gap-4 pt-0.5">
              <label className="inline-flex items-center gap-1.5 fb-t-label text-[var(--ink-70)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(e) => setUnreadOnly(e.target.checked)}
                  data-testid="folder-unread"
                />
                Unread only
              </label>
              <label className="inline-flex items-center gap-1.5 fb-t-label text-[var(--ink-70)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={withAttachments}
                  onChange={(e) => setWithAttachments(e.target.checked)}
                  data-testid="folder-attachments"
                />
                Has an attachment
              </label>
            </div>
          </div>

          <div>
            <label className="fb-t-caption block mb-1" htmlFor="folder-node">
              About a desk or task (optional)
            </label>
            <select
              id="folder-node"
              value={nodeId ?? ''}
              onChange={(e) => setNodeId(e.target.value || null)}
              data-testid="folder-node"
              className={field}
            >
              <option value="">Not about anything in particular</option>
              {desks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
            <p className="fb-t-caption mt-1">
              Linking it means this mail and that work are the same subject. The desk
              keeps its own copy of this view.
            </p>
          </div>

          {/* The rule in plain words plus what it catches right now. An empty
              folder and a broken rule look identical without this. */}
          <div className="rounded-xl bg-[var(--surface-sunken)] border border-[var(--edge-soft)] px-3 py-2.5">
            <div className="fb-t-caption">{describeRules(rules)}</div>
            <div className="fb-t-label text-[var(--ink-90)] mt-1" data-testid="folder-preview-count">
              {preview.length === 0
                ? 'Nothing in the mail you have loaded matches this yet.'
                : `${preview.length} of the ${messages.length} messages you have loaded`}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-[var(--edge-soft)] shrink-0">
          {folder ? (
            <button
              onClick={() => {
                // No confirmation: deleting a folder deletes a view, and no
                // mail moves anywhere. Making this scary would misrepresent it.
                void remove(folder.id)
                onClose()
              }}
              data-testid="folder-delete"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg fb-t-label text-rose-500 hover:bg-rose-500/10 transition-colors"
            >
              <Icon name="delete" size={15} />
              Delete folder
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="h-9 px-3.5 rounded-lg fb-t-label fb-btn-surface fb-press text-[var(--ink-80)]">
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || name.trim() === ''}
              data-testid="folder-save"
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] fb-t-label font-medium fb-press bg-[rgb(var(--accent))] text-white shadow-[0_1px_2px_rgb(var(--accent)/0.25)] disabled:opacity-40 disabled:pointer-events-none"
            >
              <Icon name="check" size={15} />
              {folder ? 'Save' : 'Create folder'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
