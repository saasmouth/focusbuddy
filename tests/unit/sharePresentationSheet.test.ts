// The sender's side: what the share sheet remembers per desk and sends with a
// link (components/share/sharePresentationChoices.ts) -- and the visitor's side
// of the same promise, the per-link record that brings the presentation back
// on a return visit without fetching the bundle again (web/api/shareVersion.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import {
  choiceOptions,
  defaultShareView,
  describeSitesOmitted,
  loadChoices,
  presentationRequest,
  presentationSummary,
  saveChoices,
  selectedChoice,
  shownFor
} from '../../src/renderer/src/components/share/sharePresentationChoices'
import { linkRecord, readLinkRecords, recordAdopted, recordUnpacked } from '../../src/web/api/shareVersion'
import { rememberColumnsConfig, rememberDeskView } from '../../src/renderer/src/lib/deskLocalPrefs'

beforeEach(() => localStorage.clear())

describe('what the sheet remembers', () => {
  it('a desk never shared opens in the view the sender is using, only that view', () => {
    expect(loadChoices('d', 'workcentre')).toEqual({ view: 'workcentre', lockView: true, sites: {} })
    // A data view (list, table…) is not a link view: Canvas.
    expect(loadChoices('d', 'table').view).toBe('canvas')
    expect(defaultShareView(undefined)).toBe('canvas')
  })

  it('keeps each desk’s choices apart, and drops anything it does not recognise', () => {
    saveChoices('a', { view: 'columns', lockView: false, sites: { w1: 'link', w2: 'auto' } })
    expect(loadChoices('a', 'canvas')).toEqual({ view: 'columns', lockView: false, sites: { w1: 'link' } })
    expect(loadChoices('b', 'canvas').view).toBe('canvas')
    localStorage.setItem('fb.sharePresentation.v1.c', JSON.stringify({ view: 'kanban', lockView: 'yes', sites: { w: 'teleport' } }))
    expect(loadChoices('c', 'workcentre')).toEqual({ view: 'workcentre', lockView: true, sites: {} })
    localStorage.setItem('fb.sharePresentation.v1.e', '{not json')
    expect(loadChoices('e', 'columns').view).toBe('columns')
  })
})

describe('the request a link is made with', () => {
  const ctx = { accountId: 'acc_1', cloudAppUrl: 'https://plexiidesk.com/share' }

  it('carries the view, lock, websites, the share origin and whose layouts these are', () => {
    rememberColumnsConfig('desk', { groupBy: 'kind', columns: [], assign: {}, order: {} })
    const r = presentationRequest('task', 'desk', { view: 'workcentre', lockView: true, sites: { w: 'picture' } }, ctx)
    expect(r).toEqual({
      view: 'workcentre',
      lockView: true,
      sites: { w: 'picture' },
      embedderOrigin: 'https://plexiidesk.com',
      layoutUserId: 'acc_1',
      columns: { groupBy: 'kind', columns: [], assign: {}, order: {} }
    })
  })

  it("is keyed 'local' signed out, leaves out a lock that is off and a Columns setup never made", () => {
    const r = presentationRequest('task', 'desk', { view: 'canvas', lockView: false, sites: {} }, { accountId: null, cloudAppUrl: '' })
    expect(r.layoutUserId).toBe('local')
    expect(r.embedderOrigin).toBe('')
    expect('lockView' in r).toBe(false)
    expect('columns' in r).toBe(false)
  })

  it('a room sends websites only: it opens on its first desk, so it has no view to choose', () => {
    const r = presentationRequest('folder', 'room', { view: 'columns', lockView: true, sites: { w: 'link' } }, ctx)
    expect(r.view).toBeUndefined()
    expect(r.lockView).toBeUndefined()
    expect(r.sites).toEqual({ w: 'link' })
  })
})

describe('how a choice reads in the sheet', () => {
  it('follows the same fall-backs as the main process', () => {
    expect(shownFor('auto', ['embed', 'picture', 'link'])).toBe('embed')
    expect(shownFor('live', ['picture', 'link'])).toBe('picture')
    expect(shownFor('picture', ['live', 'link'])).toBe('link')
    expect(selectedChoice('auto', ['live', 'picture', 'link'])).toBe('live')
    expect(selectedChoice('picture', ['link'])).toBe('link')
    expect(choiceOptions(['embed', 'picture', 'link']).map((o) => o.choice)).toEqual(['live', 'picture', 'link'])
    expect(choiceOptions(['link']).map((o) => o.choice)).toEqual(['link'])
  })

  it('sums up a link for the update confirmation, and names what went without a picture', () => {
    const line = presentationSummary('task', { view: 'workcentre', lockView: true, sites: { c: 'link' } }, [
      { widgetId: 'a', options: ['embed', 'picture', 'link'] },
      { widgetId: 'b', options: ['picture', 'link'] },
      { widgetId: 'c', options: ['picture', 'link'] },
      { widgetId: 'd', options: null }
    ])
    expect(line).toBe('Opens in Workcentre only; websites 1 live, 1 as pictures, 1 as links.')
    expect(describeSitesOmitted([{ host: 'reuters.com', why: 'reuters.com asked for a human check, so no picture could be taken.' }])).toBe(
      'Shown as a link instead of a picture: reuters.com asked for a human check, so no picture could be taken.'
    )
    expect(describeSitesOmitted([])).toBe('')
  })
})

describe('the visitor’s record of a link', () => {
  const offer = { title: 'Desk', expiresAt: null, updatedAt: 5, sizeBytes: 10, rootId: 'desk' }
  const p = { view: 'workcentre' as const, lockView: true, sites: { w: { url: 'https://finviz.com/', show: 'link' as const } } }

  it('keeps the presentation the copy was unpacked with, read back as untrusted', () => {
    recordUnpacked('tokA', 5, offer, p)
    expect(linkRecord('tokA')?.presentation).toEqual(p)
    // Tampered storage is read through the same filter as a bundle.
    const all = JSON.parse(localStorage.getItem('fb.share.links') ?? '{}')
    all.tokA.presentation.view = 'kanban'
    all.tokA.presentation.sites.w.url = 'javascript:alert(1)'
    localStorage.setItem('fb.share.links', JSON.stringify(all))
    expect(readLinkRecords().tokA.presentation).toBeNull()
  })

  it('another link to the same desk is presented as the rows now are', () => {
    recordUnpacked('tokA', 5, offer, null)
    recordUnpacked('tokB', 6, offer, p)
    expect(linkRecord('tokA')?.presentation).toEqual(p)
    // A link first opened onto a desk already here borrows its sibling's.
    recordAdopted('tokC', offer, true)
    expect(linkRecord('tokC')?.presentation).toEqual(p)
  })

  it('a record made before links carried a presentation reads as none', () => {
    localStorage.setItem('fb.share.links', JSON.stringify({ old: { version: 1, declined: null, edited: false, rootId: 'desk', offer } }))
    expect(linkRecord('old')?.presentation).toBeNull()
  })
})

describe('the sender’s setup, adopted while the desk is unpacked', () => {
  it('becomes this browser’s last-used view and Columns setup for the desk, beside other desks', () => {
    localStorage.setItem('fb.deskView.v1', JSON.stringify({ other: 'columns' }))
    rememberDeskView('desk', 'workcentre')
    rememberColumnsConfig('desk', { groupBy: 'kind' })
    expect(JSON.parse(localStorage.getItem('fb.deskView.v1')!)).toEqual({ other: 'columns', desk: 'workcentre' })
    expect(JSON.parse(localStorage.getItem('fb.deskColumns.v1.desk')!)).toEqual({ groupBy: 'kind' })
  })
})
