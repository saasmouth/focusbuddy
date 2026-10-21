import { useEffect, useMemo } from 'react'
import { parseAssigneeIds } from '@shared/workItems'
import { usePeopleStore, personName, type DirectoryPerson } from '../../lib/peopleDirectory'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
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

/** Load the active team's people once, for the picker and the avatars. */
export function useTeamPeople(): { people: DirectoryPerson[]; inTeam: boolean; attempted: boolean } {
  const orgId = useOrgStore((s) => s.activeOrgId)
  const people = usePeopleStore((s) => s.people)
  const attempted = usePeopleStore((s) => s.attempted)
  const load = usePeopleStore((s) => s.load)
  const inTeam = !!orgId && orgId !== PERSONAL_ORG_ID
  useEffect(() => {
    if (inTeam && !attempted) void load()
  }, [inTeam, attempted, load])
  return { people, inTeam, attempted }
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
  const { people, inTeam, attempted } = useTeamPeople()
  const sorted = useMemo(
    () =>
      [...people].sort(
        (a, b) => Number(a.role === 'guest') - Number(b.role === 'guest') || personName(a).localeCompare(personName(b))
      ),
    [people]
  )
  if (!inTeam) return null
  // Someone already assigned who is not in the loaded directory (left the
  // team, or the directory failed to load) stays listed, so saving never
  // silently drops them.
  const unknown = value.filter((id) => !people.some((p) => p.accountId === id))
  const toggle = (id: string): void =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="block mt-3" data-testid="assignee-picker">
      <span className="fb-t-caption text-[var(--ink-40)]">
        Assigned to <span className="text-[var(--ink-30)]">— it shows in each person’s Focus</span>
      </span>
      {attempted && people.length === 0 ? (
        <div className="mt-1 text-[12px] text-[var(--ink-50)]">
          Could not load this team’s people. Check your connection and try again.
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
    </div>
  )
}
