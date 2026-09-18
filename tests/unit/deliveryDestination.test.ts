import { describe, expect, it } from 'vitest'
import { destinationOf, deliveryMessage } from '../../src/renderer/src/lib/deliveryDestination'
import type { ActionProposal } from '../../src/shared/types'

// Where a browsing run's results went.
//
// Reported as: a delivery that said "Created a ranked table of chicken soup
// recipes…" and gave no indication where, or link to it. The prose comes from
// the model, which writes it BEFORE anything is applied and so cannot know.

const ctx = (activeTaskId: string | null, titles: Record<string, string> = {}) => ({
  activeTaskId,
  deskTitle: (id: string) => titles[id] ?? null
})

const table = (id = 'p1'): ActionProposal =>
  ({ id, kind: 'create-table', title: 'Chicken soup recipes' }) as ActionProposal
const doc = (id = 'p2'): ActionProposal =>
  ({ id, kind: 'create-document', docType: 'sheet', title: 'Recipes' }) as ActionProposal
const desk = (id = 'p3'): ActionProposal =>
  ({ id, kind: 'create-task', title: 'Soup research' }) as ActionProposal

describe('destinationOf', () => {
  it('names the desk a table landed on', () => {
    // The exact reported case: a table, applied to whichever desk was last
    // active — which from a desk-less browser is one you were not looking at.
    const d = destinationOf([table()], new Map(), ctx('desk-9', { 'desk-9': 'Dinner planning' }))
    expect(d).toEqual({
      label: 'Dinner planning',
      icon: 'desk',
      view: { kind: 'task', taskId: 'desk-9' }
    })
  })

  it('prefers a desk the proposal named over the active one', () => {
    const p = { ...table(), deskId: 'desk-named' } as ActionProposal
    const d = destinationOf([p], new Map(), ctx('desk-active', { 'desk-named': 'Named desk' }))
    expect(d?.view).toEqual({ kind: 'task', taskId: 'desk-named' })
  })

  it('opens a document rather than the desk it sits on', () => {
    // "Open the sheet" beats "open the desk the sheet is on".
    const d = destinationOf([doc()], new Map([['p2', 'doc-1']]), ctx('desk-9'))
    expect(d?.view).toEqual({ kind: 'document', documentId: 'doc-1' })
    expect(d?.label).toBe('Recipes')
  })

  it('prefers a desk the delivery created for the purpose', () => {
    // Everything else it applied went onto that desk, so it is the best answer
    // available — better than the desk that merely happened to be active.
    const d = destinationOf([desk(), table()], new Map([['p3', 'desk-new']]), ctx('desk-old'))
    expect(d?.view).toEqual({ kind: 'task', taskId: 'desk-new' })
    expect(d?.label).toBe('Soup research')
  })

  it('offers ONE destination even when several things were applied', () => {
    // A button per proposal turns "where did it go" back into a puzzle.
    const many = [table('a'), table('b'), table('c')]
    const d = destinationOf(many, new Map(), ctx('desk-9', { 'desk-9': 'Desk' }))
    expect(d).not.toBeNull()
    expect(d?.view).toEqual({ kind: 'task', taskId: 'desk-9' })
  })

  it('falls back to a plain name when the desk title is unknown', () => {
    // Better an honest "the desk" than a blank button or a fabricated name.
    expect(destinationOf([table()], new Map(), ctx('desk-9'))?.label).toBe('the desk')
  })

  it('returns null rather than a guess when nothing has a place', () => {
    // No active desk and no desk created: there is genuinely nowhere to point.
    expect(destinationOf([table()], new Map(), ctx(null))).toBeNull()
    expect(destinationOf([], new Map(), ctx('desk-9'))).toBeNull()
    // A document whose id never resolved did not actually get created.
    expect(destinationOf([doc()], new Map(), ctx(null))).toBeNull()
  })
})

describe('deliveryMessage', () => {
  it('adds the destination the model could not know', () => {
    const d = destinationOf([table()], new Map(), ctx('d1', { d1: 'Dinner planning' }))
    expect(deliveryMessage('Created a ranked table of chicken soup recipes.', d)).toBe(
      'Created a ranked table of chicken soup recipes — on Dinner planning.'
    )
  })

  it('does not say the destination twice', () => {
    const d = destinationOf([table()], new Map(), ctx('d1', { d1: 'Dinner planning' }))
    const said = 'Added the table to Dinner planning.'
    expect(deliveryMessage(said, d)).toBe(said)
  })

  it('leaves the sentence alone when there is nowhere to point', () => {
    expect(deliveryMessage('Created a table.', null)).toBe('Created a table.')
  })

  it('still says something useful when the model said nothing', () => {
    const d = destinationOf([table()], new Map(), ctx('d1', { d1: 'Dinner planning' }))
    expect(deliveryMessage('', d)).toBe('Placed on Dinner planning.')
  })
})
