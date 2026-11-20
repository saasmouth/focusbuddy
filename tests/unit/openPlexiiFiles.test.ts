// Double-clicking a .plexii-* file (F3, 2026-11-20), the window's end
// (renderer/src/lib/openPlexiiFiles.ts): each file main read is brought in as a
// copy (the same import as Files › Import), put on the desk on screen, or opened
// when no desk is, and the person is told what happened in one notice.
import { describe, expect, it, vi } from 'vitest'
import { bringInOpenedFiles, type OpenFilesDeps } from '../../src/renderer/src/lib/openPlexiiFiles'

type Notice = { text: string; icon: string }
function deps(desk: string | null, over: Partial<OpenFilesDeps> = {}): OpenFilesDeps & { notices: Notice[]; log: string[] } {
  const notices: Notice[] = []
  const log: string[] = []
  return {
    notices,
    log,
    importText: vi.fn(async (text: string) => {
      const f = JSON.parse(text) as { title: string; docType?: string; kind?: string; bad?: string }
      if (f.bad) return { ok: false as const, error: f.bad }
      return f.docType
        ? { ok: true as const, kind: 'document' as const, document: { id: `doc-${f.title}`, docType: f.docType, title: f.title } }
        : { ok: true as const, kind: 'widget' as const, file: { id: `wf-${f.title}`, kind: f.kind!, title: f.title } }
    }),
    deskOnScreen: () => desk,
    placeWidgetFile: vi.fn(async (id: string, d: string) => {
      log.push(`place ${id} on ${d}`)
      return { id: `w-${id}` }
    }),
    placeDocument: vi.fn(async (doc: { id: string; docType: string; title: string }, d: string) => {
      log.push(`place ${doc.id} (${doc.docType}) on ${d}`)
      return { id: `w-${doc.id}` }
    }),
    open: vi.fn((id: string) => {
      log.push(`open ${id}`)
    }),
    notify: (n) => {
      notices.push({ text: n.text, icon: n.icon })
    },
    ...over
  }
}
const sheet = (title: string) => ({ id: `o-${title}`, name: `${title}.plexii-sheet`, at: 1, text: JSON.stringify({ title, docType: 'sheet' }) })
const sticky = (title: string) => ({ id: `o-${title}`, name: `${title}.plexii-sticky`, at: 1, text: JSON.stringify({ title, kind: 'sticky' }) })

describe('a file opened from Finder or Explorer', () => {
  it('with a desk on screen: a copy goes into Files and onto that desk (a document as its Office widget, a work widget as a linked instance)', async () => {
    const d = deps('desk-1')
    await bringInOpenedFiles([sheet('Budget'), sticky('Idea')], d)
    expect(d.log).toEqual(['place doc-Budget (sheet) on desk-1', 'place wf-Idea on desk-1'])
    expect(d.open).not.toHaveBeenCalled()
    expect(d.notices).toEqual([{ text: 'Opened 2 Plexii files. Copies are in Files and on this desk.', icon: 'check_circle' }])
  })

  it('one file, with a desk on screen, is named', async () => {
    const d = deps('desk-1')
    await bringInOpenedFiles([sheet('Budget')], d)
    expect(d.notices).toEqual([{ text: 'Opened “Budget”. A copy is in Files and on this desk.', icon: 'check_circle' }])
  })

  it('with no desk on screen: it is opened (the last one, when several), and its copy is in Files', async () => {
    const d = deps(null)
    await bringInOpenedFiles([sticky('Idea'), sheet('Budget')], d)
    expect(d.log).toEqual(['open doc-Budget'])
    expect(d.notices).toEqual([{ text: 'Opened 2 Plexii files. Copies are in Files.', icon: 'check_circle' }])
  })

  it('a file that could not be read or is not a Plexii file is named with the reason, and nothing is made from it', async () => {
    const d = deps('desk-1')
    await bringInOpenedFiles(
      [
        { id: 'o1', name: 'Gone.plexii-doc', at: 1, error: 'It isn’t there any more.' },
        { id: 'o2', name: 'Bad.plexii-sheet', at: 1, text: JSON.stringify({ title: 'x', bad: 'This file is damaged: its body is not a spreadsheet.' }) }
      ],
      d
    )
    expect(d.log).toEqual([])
    expect(d.notices).toEqual([
      {
        text: '“Gone.plexii-doc” could not be opened: It isn’t there any more. “Bad.plexii-sheet” could not be opened: This file is damaged: its body is not a spreadsheet.',
        icon: 'error'
      }
    ])
  })

  it('some opened and some not: one notice says both', async () => {
    const d = deps(null)
    await bringInOpenedFiles([sheet('Budget'), { id: 'o1', name: 'Gone.plexii-doc', at: 1, error: 'It isn’t there any more.' }], d)
    expect(d.log).toEqual(['open doc-Budget'])
    expect(d.notices).toEqual([{ text: 'Opened “Budget”. A copy is in Files. “Gone.plexii-doc” could not be opened: It isn’t there any more.', icon: 'warning' }])
  })

  it('an import that throws is a file that could not be opened, and the rest still come in', async () => {
    const d = deps('desk-1', {
      importText: vi.fn(async (text: string) => {
        if (text.includes('Boom')) throw new Error('database is locked')
        return { ok: true as const, kind: 'widget' as const, file: { id: 'wf-Idea', kind: 'sticky', title: 'Idea' } }
      })
    })
    await bringInOpenedFiles([sheet('Boom'), sticky('Idea')], d)
    expect(d.log).toEqual(['place wf-Idea on desk-1'])
    expect(d.notices[0]!.text).toBe('Opened “Idea”. A copy is in Files and on this desk. “Boom.plexii-sheet” could not be opened: database is locked.')
  })

  it('a copy that could not go on the desk is still in Files, and the notice says so', async () => {
    const d = deps('desk-1', { placeWidgetFile: vi.fn(async () => null) })
    await bringInOpenedFiles([sticky('Idea')], d)
    expect(d.notices).toEqual([{ text: 'Opened “Idea”. A copy is in Files; it could not be put on this desk.', icon: 'warning' }])
  })

  it('nothing handed over: nothing said', async () => {
    const d = deps('desk-1')
    await bringInOpenedFiles([], d)
    expect(d.notices).toEqual([])
  })
})
