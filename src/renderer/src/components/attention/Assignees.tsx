import { useEffect, useMemo } from 'react'
import { parseAssigneeIds } from '@shared/workItems'
import { usePeopleStore, personName, type DirectoryPerson } from '../../lib/peopleDirectory'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import { useAccountStore } from '../../stores/account'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'

// DEC-144 — who a task is assigned to, in a team workspace.
//
// Assignees are account ids (organisation members and guests). Names come from
// the people directory the app genuinely loaded for the active organisation;
// an id it does not know is shown as exactly that, never as an invented name.

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('') || '?'
  )
}

/**
 * Load the active team's people, for the picker and the avatars. `ready` is
 * true only once the list in hand was loaded for THIS workspace; a list from
 * the previous workspace (or one fetched in Personal) never counts.
 */
export function useTeamPeople(): {
  people: DirectoryPerson[]
  inTeam: boolean
  ready: boolean
  failed: boolean
  retry: () => void
} {
  const orgId = useOrgStore((s) => s.activeOrgId)
  const people = usePeopleStore((s) => s.people)
  const attempted = usePeopleStore((s) => s.attempted)
  const loadedFor = usePeopleStore((s) => s.loadedFor)
  const loading = usePeopleStore((s) => s.loading)
  const failed = usePeopleStore((s) => s.failed)
  const load = usePeopleStore((s) => s.load)
  const inTeam = !!orgId && orgId !== PERSONAL_ORG_ID
  // A refresh keeps showing the list it already has for this workspace.
  const ready = attempted && loadedFor === orgId
  useEffect(() => {
    if (inTeam && !loading && (!attempted || loadedFor !== orgId)) void load()
  }, [inTeam, attempted, loadedFor, orgId, loading, load])
  return { people: ready ? people : [], inTeam, ready, failed: ready && failed, retry: () => void load() }
}

/** Overlapping initials for a task's assignees (up to three, then +N). */
export function AssigneeAvatars({ assigneeIds }: { assigneeIds: string | null | undefined }): JSX.Element | null {
  const ids = parseAssigneeIds(assigneeIds)
  const people = usePeopleStore((s) => s.people)
  if (ids.length === 0) return null
  const named = ids.map((id) => {
    const p = people.find((x) => x.accountId === id)
    return { id, name: p ? personName(p) : null, guest: p?.role === 'guest' }
  })
  const label = named.map((n) => n.name ?? 'someone outside this workspace').join(', ')
  return (
    <span className="flex items-center -space-x-1.5 pl-0.5" title={`Assigned to ${label}`} data-testid="task-assignees">
      {named.slice(0, 3).map((n) => (
        <span
          key={n.id}
          className="h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-semibold uppercase text-[var(--ink-70)] bg-accent/15 ring-1 ring-[var(--surface-raised)]"
        >
          {n.name ? initials(n.name) : '?'}
        </span>
      ))}
      {named.length > 3 && (
        <span className="h-5 w-5 rounded-full flex items-center justify-center text-[9px] text-[var(--ink-50)] bg-[var(--surface-sunken)] ring-1 ring-[var(--surface-raised)]">
          +{named.length - 3}
        </span>
      )}
    </span>
  )
}

/**
 * Pick any number of people from the active team: members and guests. Shown
 * only in a team workspace — a Personal task has nobody else to give it to.
 */
export function AssigneePicker({
  value,
  onChange
}: {
  value: string[]
  onChange: (next: string[]) => void
}): JSX.Element | null {
  const { people, inTeam, ready, failed, retry } = useTeamPeople()
  // Refresh once each time the picker opens, so someone who joined since the
  // list was loaded (the invite this picker points to) is there to pick.
  useEffect(() => {
    if (inTeam) retry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inTeam])
  const selfId = useAccountStore((s) => s.account?.id ?? null)
  const goOrg = useViewStore((s) => s.goOrg)
  const sorted = useMemo(
    () =>
      [...people].sort(
        (a, b) =>
          Number(a.accountId !== selfId) - Number(b.accountId !== selfId) ||
          Number(a.role === 'guest') - Number(b.role === 'guest') ||
          personName(a).localeCompare(personName(b))
      ),
    [people, selfId]
  )
  if (!inTeam) return null
  // Someone already assigned who is not in the loaded directory (left the
  // team, or the directory failed to load) stays listed, so saving never
  // silently drops them.
  const unknown = ready ? value.filter((id) => !people.some((p) => p.accountId === id)) : []
  const toggle = (id: string): void =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  // Joined people other than you. With none, the list is not broken: there is
  // nobody to give the task to yet, and the picker says how to change that.
  const others = people.filter((p) => p.accountId !== selfId)
  return (
    <div className="block mt-3" data-testid="assignee-picker">
      <span className="fb-t-caption text-[var(--ink-40)]">
        Assigned to <span className="text-[var(--ink-30)]">— it shows in each person’s Focus</span>
      </span>
      {!ready ? (
        <div className="mt-1 text-[12px] text-[var(--ink-50)]" data-testid="assignee-picker-loading">
          Loading this team’s people…
        </div>
      ) : failed ? (
        <div className="mt-1 text-[12px] text-[var(--ink-50)] flex items-center gap-2" data-testid="assignee-picker-failed">
          Could not load this team’s people. Check your connection.
          <button type="button" onClick={retry} className="text-accent hover:underline">
            Try again
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {sorted.map((p) => {
            const on = value.includes(p.accountId)
            return (
              <button
                key={p.accountId}
                type="button"
                onClick={() => toggle(p.accountId)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1 px-2.5 h-7 fb-t-label fb-press rounded-full ${
                  on
                    ? 'bg-[rgb(var(--accent))] text-white'
                    : 'bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                }`}
              >
                {on && <Icon name="check" size={12} />}
                {personName(p)}
                {p.accountId === selfId && <span className={on ? 'opacity-80' : 'text-[var(--ink-40)]'}>(you)</span>}
                {p.role === 'guest' && <span className={on ? 'opacity-80' : 'text-[var(--ink-40)]'}>· Guest</span>}
              </button>
            )
          })}
          {unknown.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => toggle(id)}
              aria-pressed
              title="Assigned, but not in this team’s people list"
              className="inline-flex items-center gap-1 px-2.5 h-7 fb-t-label fb-press rounded-full bg-[rgb(var(--accent))] text-white"
            >
              <Icon name="check" size={12} />
              Someone outside this workspace
            </button>
          ))}
        </div>
      )}
      {ready && !failed && others.length === 0 && (
        <div className="mt-1.5 text-[12px] text-[var(--ink-50)] flex items-center gap-2" data-testid="assignee-picker-nobody">
          Nobody else has joined this workspace yet. Invite someone to assign tasks to them.
          {/* The same destination as the workspace switcher's Manage organisation. */}
          <button type="button" onClick={goOrg} className="text-accent hover:underline" data-testid="assignee-picker-invite">
            Invite people
          </button>
        </div>
      )}
    </div>
  )
}
