import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Contact, Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { usePeopleStore, personName } from '../../lib/peopleDirectory'
import { useAccountStore } from '../../stores/account'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import { inviteMember } from '../../lib/orgsClient'
import { suggestContacts, type ContactSuggestion } from '@shared/contactSuggestions'

// The people on this desk.
//
// Two populations, and the difference is real rather than cosmetic. Colleagues
// come from the org on the signal server, which stays the authority on who they
// are and what they can reach. Everybody else -- the conveyancer, the
// photographer, the client's accountant -- is a guest, stored locally, and on
// most real work that is half the people involved.
//
// This used to keep its own list inside one widget's content, so the same
// person on three desks was three unrelated rows and nothing else in the app
// could see any of them. Now a contact is a record and a desk link is a link.

interface ContactsContent {
  activeGroup?: string
}

function parse(raw: string | null | undefined): ContactsContent {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as ContactsContent
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?'

type Api = {
  listForNode: (nodeId: string) => Promise<Contact[]>
  create: (draft: Record<string, unknown>) => Promise<Contact>
  remove: (id: string) => Promise<boolean>
  link: (contactId: string, nodeId: string) => Promise<boolean>
  unlink: (contactId: string, nodeId: string) => Promise<boolean>
}

export default function ContactsWidget({ widget }: { widget: Widget }): JSX.Element {
  const model = useMemo(() => parse(widget.content), [widget.content])
  const deskId = widget.taskId

  const api = (window as unknown as { api?: { contacts?: Api } }).api?.contacts
  const people = usePeopleStore((s) => s.people)
  const loadPeople = usePeopleStore((s) => s.load)
  const sessionToken = useAccountStore((s) => s.sessionToken)
  const orgId = useOrgStore((s) => s.activeOrgId)

  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', email: '', role: '', company: '', address: '' })
  // People the workspace can already see you working with.
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!api || !deskId) {
      setContacts([])
      return
    }
    try {
      setContacts(await api.listForNode(deskId))
    } catch (e) {
      setContacts([])
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api, deskId])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    void loadPeople()
  }, [loadPeople])

  const canInvite = Boolean(sessionToken && orgId && orgId !== PERSONAL_ORG_ID)

  const add = async (fromMember?: { accountId: string; name: string; email: string | null }): Promise<void> => {
    if (!api || !deskId) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.create(
        fromMember
          ? {
              name: fromMember.name,
              email: fromMember.email,
              kind: 'member',
              accountId: fromMember.accountId,
              nodeId: deskId
            }
          : {
              name: draft.name.trim() || draft.email.trim() || 'Unnamed',
              email: draft.email.trim() || null,
              role: draft.role.trim() || null,
              company: draft.company.trim() || null,
              address: draft.address.trim() || null,
              kind: 'guest',
              nodeId: deskId
            }
      )
      setDraft({ name: '', email: '', role: '', company: '', address: '' })
      setAdding(false)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeFromDesk = async (c: Contact): Promise<void> => {
    if (!api || !deskId) return
    // Unlink, not delete: taking somebody off this desk must not erase them
    // from every other desk they are on.
    await api.unlink(c.id, deskId)
    await refresh()
  }

  const invite = async (c: Contact): Promise<void> => {
    if (!c.email) {
      setError(`${c.name} has no email address to invite.`)
      return
    }
    if (!canInvite || !sessionToken || !orgId) {
      setError('Inviting needs a signed-in workspace with an organisation.')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await inviteMember(sessionToken, orgId, c.email, 'member')
      if (!res.ok) {
        setError(res.error || 'The invitation was not sent.')
        return
      }
      setNotice(
        res.added
          ? `${c.name} is already on Plexii and has been added.`
          : `Invitation sent to ${c.email}.`
      )
      void loadPeople()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const shareDesk = async (c: Contact): Promise<void> => {
    if (!deskId) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const shares = (window as unknown as { api?: { shares?: Record<string, any> } }).api?.shares
      if (!shares?.create || !sessionToken) {
        setError('Sharing needs a signed-in workspace.')
        return
      }
      const link = await shares.create({
        token: sessionToken,
        kind: 'desk',
        entityId: deskId,
        label: `Shared with ${c.name}`,
        scope: 'view',
        // The 48-hour clock is the whole shape of a Plexii desk share; it is
        // not configurable here because a share that never expires is a
        // different product decision, not a checkbox.
        expiresAt: Date.now() + 48 * 3600_000
      })
      const url = (link as { url?: string })?.url
      if (url) {
        await navigator.clipboard.writeText(url).catch(() => {})
        setNotice(`Link copied — valid 48 hours. Send it to ${c.email || c.name}.`)
      } else {
        setNotice('Share created.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Build the suggestions from what the workspace actually holds: who emails
  // you, who tasks here are assigned to, who organised a meeting, and who is in
  // the org. Each carries its reason, so the list can never be mistaken for a
  // list of people who exist -- it is people who appeared in your own data.
  useEffect(() => {
    if (!deskId || contacts === null) return
    let alive = true
    void (async () => {
      const api = (window as unknown as { api?: Record<string, any> }).api
      const [mailRes, nodes, events] = await Promise.all([
        api?.mail?.list?.(200).catch(() => null),
        api?.nodes?.list?.().catch(() => []),
        api?.externalCalendars
          ?.listEvents?.(Date.now() - 60 * 86_400_000, Date.now() + 60 * 86_400_000)
          .catch(() => [])
      ])
      if (!alive) return

      const inDesk = new Set<string>([deskId])
      for (const n of (nodes ?? []) as Array<{ id: string; parentId: string | null }>) {
        if (n.parentId && inDesk.has(n.parentId)) inDesk.add(n.id)
      }
      const account = await api?.mail?.getAccount?.().catch(() => null)

      setSuggestions(
        suggestContacts({
          mail: mailRes?.ok ? mailRes.items : [],
          assignees: ((nodes ?? []) as Array<{ id: string; assignee?: string | null }>)
            .filter((n) => inDesk.has(n.id))
            .map((n) => n.assignee ?? '')
            .filter(Boolean),
          organisers: ((events ?? []) as Array<{ organizer: string | null }>)
            .map((e) => e.organizer ?? '')
            .filter(Boolean),
          orgMembers: people.map((p) => ({
            accountId: p.accountId,
            name: personName(p),
            email: p.email
          })),
          existing: contacts,
          self: [account?.email, account?.user].filter(Boolean) as string[]
        })
      )
    })()
    return () => {
      alive = false
    }
  }, [deskId, contacts, people])

  const addSuggested = async (sg: ContactSuggestion): Promise<void> => {
    if (!api || !deskId) return
    setBusy(true)
    try {
      await api.create({
        name: sg.name,
        email: sg.email,
        kind: sg.accountId ? 'member' : 'guest',
        accountId: sg.accountId ?? null,
        // Where this person came from, kept on the record. A contact that
        // appeared by itself should be able to say why.
        notes: `Added from ${sg.source} — ${sg.reason}`,
        nodeId: deskId
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const shown = contacts ?? []
  const group = model.activeGroup ?? 'All'
  const filtered =
    group === 'All'
      ? shown
      : shown.filter((c) => (group === 'Guests' ? c.kind === 'guest' : c.kind === 'member'))

  return (
    <WidgetFrame
      widget={widget}
      headerLabel="Contacts"
      headerAccent="bg-amber-200/50 dark:bg-amber-400/10"
    >
      <div className="flex h-full flex-col bg-[var(--surface-raised)] text-[11px]">
        <div className="flex items-center gap-1 border-b border-[color:var(--edge-soft)] px-2 py-1.5">
          {(['All', 'Team', 'Guests'] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                const api2 = (window as unknown as { api?: { widgets?: Record<string, any> } }).api?.widgets
                void api2?.update?.(widget.id, {
                  content: JSON.stringify({ ...model, activeGroup: g })
                })
              }}
              className={`widget-nodrag rounded-full px-2 py-0.5 transition-colors ${
                g === group
                  ? 'bg-accent/10 font-medium text-accent'
                  : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
              }`}
            >
              {g}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAdding(!adding)}
            title="Add someone"
            className="widget-nodrag ml-auto rounded p-0.5 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
          >
            <Icon name={adding ? 'close' : 'person_add'} size={13} />
          </button>
        </div>

        {adding && (
          <div className="flex flex-col gap-1 border-b border-[color:var(--edge-soft)] px-2 py-2">
            <div className="flex gap-1">
              <input
                className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
                placeholder="Name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <input
                className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
                placeholder="Email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </div>
            <div className="flex gap-1">
              <input
                className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
                placeholder="Role"
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
              />
              <input
                className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
                placeholder="Company"
                value={draft.company}
                onChange={(e) => setDraft({ ...draft, company: e.target.value })}
              />
              <button
                type="button"
                onClick={() => void add()}
                disabled={busy || (!draft.name.trim() && !draft.email.trim())}
                className="widget-nodrag shrink-0 rounded bg-[var(--accent)] px-2 py-1 font-medium text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
            <input
              className="widget-nodrag w-full rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
              placeholder="Address"
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-1 pt-1" data-testid="contact-suggestions">
                <span className="text-[9px] text-[var(--ink-40)]">
                  People already on this work
                </span>
                {suggestions.map((sg) => (
                  <button
                    key={sg.key}
                    type="button"
                    onClick={() => void addSuggested(sg)}
                    disabled={busy}
                    className="widget-nodrag flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                  >
                    <Icon name="add" size={10} className="shrink-0 text-[var(--ink-40)]" />
                    <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--ink-80)]">
                      {sg.name}
                    </span>
                    {/* The reason, always. A suggested person with no
                        provenance is indistinguishable from an invented one. */}
                    <span className="shrink-0 text-[9px] text-[var(--ink-40)]">{sg.reason}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="px-2 py-1 text-[10px] text-rose-500">{error}</p>}
        {notice && <p className="px-2 py-1 text-[10px] text-emerald-600">{notice}</p>}

        <div className="widget-nodrag min-h-0 flex-1 overflow-y-auto">
          {contacts === null ? (
            <p className="px-2 py-3 text-center text-[10px] text-[var(--ink-40)]">Loading…</p>
          ) : filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
              <Icon name="group" size={18} className="text-[var(--ink-40)]" />
              <span className="text-[11px] text-[var(--ink-60)]">
                {shown.length === 0 ? 'Nobody on this desk yet' : `No ${group.toLowerCase()}`}
              </span>
              <span className="text-[10px] leading-snug text-[var(--ink-40)]">
                Add the people this work actually involves — colleagues or not.
              </span>
            </div>
          ) : (
            filtered.map((c) => (
              <div key={c.id} className="border-b border-[color:var(--edge-soft)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--surface-sunken)]"
                >
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
                      c.kind === 'member'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-[var(--surface-sunken)] text-[var(--ink-60)]'
                    }`}
                  >
                    {initials(c.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-[var(--ink-90)]">{c.name}</span>
                    <span className="block truncate text-[9px] text-[var(--ink-45)]">
                      {[c.role, c.company, c.email].filter(Boolean).join(' · ') ||
                        (c.kind === 'member' ? 'Team' : 'Guest')}
                    </span>
                  </span>
                  {c.kind === 'guest' && (
                    <span className="shrink-0 rounded-full bg-[var(--surface-sunken)] px-1.5 text-[9px] text-[var(--ink-50)]">
                      Guest
                    </span>
                  )}
                </button>
                {openId === c.id && (
                  <div className="flex flex-wrap gap-1 px-2 pb-2">
                    {c.address && (
                      <div className="w-full whitespace-pre-wrap text-[10px] leading-snug text-[var(--ink-60)]">
                        {c.address}
                      </div>
                    )}
                    {c.notes && (
                      <div className="w-full text-[9px] text-[var(--ink-40)]">{c.notes}</div>
                    )}
                    {c.email && (
                      <a
                        href={`mailto:${c.email}`}
                        className="widget-nodrag inline-flex items-center gap-0.5 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                      >
                        <Icon name="mail" size={10} /> Email
                      </a>
                    )}
                    {c.kind === 'guest' && c.email && (
                      <button
                        type="button"
                        onClick={() => void invite(c)}
                        disabled={busy || !canInvite}
                        title={
                          canInvite
                            ? 'Invite them to your Plexii organisation'
                            : 'Sign in to an organisation to invite people'
                        }
                        className="widget-nodrag inline-flex items-center gap-0.5 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                      >
                        <Icon name="person_add" size={10} /> Invite to Plexii
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void shareDesk(c)}
                      disabled={busy}
                      title="Create a 48-hour link to this desk"
                      className="widget-nodrag inline-flex items-center gap-0.5 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                    >
                      <Icon name="share" size={10} /> Share this desk
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeFromDesk(c)}
                      title="Take them off this desk (they stay in your contacts)"
                      className="widget-nodrag ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-40)] hover:text-rose-500"
                    >
                      <Icon name="close" size={10} /> Remove
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </WidgetFrame>
  )
}
