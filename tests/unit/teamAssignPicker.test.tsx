// Owner report (4.3.40): "I can't seem to assign a task." In a team workspace.
//
// Two causes, both checked here on a real mount of the picker:
//   1. The people directory was loaded once per session. Most launches load it
//      in Personal (the chat panel and capture console ask at start-up), so it
//      came back empty and was never reloaded after switching to the team: the
//      picker said "Could not load this team's people" for a list that loaded
//      fine, and offered nobody.
//   2. A team with nobody else in it yet looked broken. It now says so, and
//      how to change it.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getOrg = vi.fn()
vi.mock('../../src/renderer/src/lib/orgsClient', () => ({ getOrg: (...a: unknown[]) => getOrg(...a) }))
vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import { AssigneePicker } from '../../src/renderer/src/components/attention/Assignees'
import { usePeopleStore, personName } from '../../src/renderer/src/lib/peopleDirectory'
import { useOrgStore, PERSONAL_ORG_ID } from '../../src/renderer/src/stores/org'
import { useAccountStore } from '../../src/renderer/src/stores/account'

const member = (accountId: string, firstName: string, role = 'member') => ({
  accountId,
  handle: firstName.toLowerCase(),
  firstName,
  lastName: null,
  email: `${firstName.toLowerCase()}@example.test`,
  role
})

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { people: { setDirectory: vi.fn(async () => {}) } }
  getOrg.mockReset()
  useAccountStore.setState({ sessionToken: 'tok', account: { id: 'me', email: 'me@example.test', handle: 'me', firstName: 'Mia' } as never })
  useOrgStore.setState({ activeOrgId: PERSONAL_ORG_ID })
  usePeopleStore.setState({ people: [], attempted: false, loadedFor: null, failed: false, loading: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async (value: string[] = [], onChange = vi.fn()): Promise<void> => {
  await act(async () => {
    root.render(<AssigneePicker value={value} onChange={onChange} />)
  })
  await flush()
}
const text = (): string => host.textContent ?? ''

describe('the people directory follows the workspace', () => {
  it('a list loaded in Personal is reloaded for the team instead of reading as a failure', async () => {
    // Start-up: something loads the directory while still in Personal.
    await usePeopleStore.getState().load()
    expect(usePeopleStore.getState().attempted).toBe(true)
    expect(getOrg).not.toHaveBeenCalled()

    getOrg.mockResolvedValue({ members: [member('me', 'Mia', 'owner'), member('a2', 'Ana')] })
    await act(async () => { useOrgStore.setState({ activeOrgId: 'org_team' }) })
    await flush()
    expect(getOrg).toHaveBeenCalledWith('tok', 'org_team')
    expect(usePeopleStore.getState().loadedFor).toBe('org_team')
    expect(usePeopleStore.getState().people.map((p) => p.accountId)).toEqual(['me', 'a2'])
  })

  it('drops an answer for a workspace the person has already left', async () => {
    let resolveA: (v: unknown) => void = () => {}
    getOrg.mockImplementationOnce(() => new Promise((r) => { resolveA = r }))
    useOrgStore.setState({ activeOrgId: 'org_a' })
    usePeopleStore.setState({ people: [], attempted: false, loadedFor: null, failed: false, loading: false })
    const pending = usePeopleStore.getState().load()
    getOrg.mockResolvedValueOnce({ members: [member('b1', 'Bea')] })
    await act(async () => { useOrgStore.setState({ activeOrgId: 'org_b' }) })
    resolveA({ members: [member('a1', 'Al')] })
    await pending
    await flush()
    expect(usePeopleStore.getState().loadedFor).toBe('org_b')
    expect(usePeopleStore.getState().people.map((p) => p.accountId)).toEqual(['b1'])
  })

  it('tells a failed request from a team that loaded', async () => {
    useOrgStore.setState({ activeOrgId: 'org_x' })
    getOrg.mockResolvedValueOnce(null)
    await usePeopleStore.getState().load()
    expect(usePeopleStore.getState().failed).toBe(true)
    getOrg.mockResolvedValueOnce({ members: [member('me', 'Mia', 'owner')] })
    await usePeopleStore.getState().load()
    expect(usePeopleStore.getState().failed).toBe(false)
  })
})

describe('the Assigned to picker in a team workspace', () => {
  it('lists the joined people, you first, guests labelled, and saves the pick', async () => {
    getOrg.mockResolvedValue({ members: [member('g1', 'Gus', 'guest'), member('a2', 'Ana'), member('me', 'Mia', 'owner')] })
    useOrgStore.setState({ activeOrgId: 'org_team' })
    const onChange = vi.fn()
    await mount([], onChange)
    const chips = [...host.querySelectorAll('[data-testid="assignee-picker"] button[aria-pressed]')].map((b) => b.textContent)
    expect(chips).toEqual(['Mia(you)', 'Ana', 'Gus· Guest'])
    expect(host.querySelector('[data-testid="assignee-picker-nobody"]')).toBeNull()
    const ana = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Ana')!
    await act(async () => { ana.click() })
    expect(onChange).toHaveBeenCalledWith(['a2'])
  })

  it('with nobody else joined, says so and offers the invite', async () => {
    getOrg.mockResolvedValue({ members: [member('me', 'Mia', 'owner')] })
    useOrgStore.setState({ activeOrgId: 'org_solo' })
    await mount()
    expect(text()).toContain('Invite someone to assign tasks to them.')
    expect(host.querySelector('[data-testid="assignee-picker-invite"]')).not.toBeNull()
    expect(text()).not.toContain('Could not load')
  })

  it('after a Personal start-up load, opening it in the team shows the team, not an error', async () => {
    await usePeopleStore.getState().load() // Personal, at start-up
    getOrg.mockResolvedValue({ members: [member('me', 'Mia', 'owner'), member('a2', 'Ana')] })
    await act(async () => { useOrgStore.setState({ activeOrgId: 'org_team' }) })
    await mount()
    expect(text()).toContain('Ana')
    expect(text()).not.toContain('Could not load')
  })

  it('a failed load says so with a retry, and is not the nobody-yet message', async () => {
    getOrg.mockResolvedValue(null)
    useOrgStore.setState({ activeOrgId: 'org_down' })
    await mount()
    expect(host.querySelector('[data-testid="assignee-picker-failed"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="assignee-picker-nobody"]')).toBeNull()
  })

  it('is not shown in Personal', async () => {
    await mount()
    expect(host.querySelector('[data-testid="assignee-picker"]')).toBeNull()
  })
})

describe('a person with no name of their own', () => {
  it('reads as their address, not the server placeholder, so two of them never look like one', () => {
    const p = (handle: string, email: string | null, firstName: string | null = null) =>
      ({ accountId: 'x', handle, firstName, lastName: null, email, role: 'member' })
    expect(personName(p('Someone', 'ana@example.test'))).toBe('ana@example.test')
    expect(personName(p('ana', 'ana@example.test'))).toBe('ana')
    expect(personName(p('Someone', 'ana@example.test', 'Ana'))).toBe('Ana')
    expect(personName(p('Someone', null))).toBe('Someone')
  })
})
