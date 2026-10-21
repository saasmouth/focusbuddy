// "Add … to desk", PlexiiAssist and AI Assist from the web page right-click
// menu (4.3.41): what each clicked thing becomes, where it lands, and the
// shared AI action catalogue the native menu and the work widget menu read.
import { describe, it, expect } from 'vitest'
import { widgetDraftFor, placeBesideExisting, STICKY_MAX_CHARS, type AddToDeskCommand } from '../../src/renderer/src/lib/addToDesk'
import { askAboutPrompt } from '../../src/renderer/src/components/browser/WebMenuCommandHost'
import { resolveAiCommand, AI_DIRECT_ACTIONS, WEB_SELECTION_AI_ACTIONS, aiTextAction } from '../../src/shared/aiTextActions'

const cmd = (o: Partial<AddToDeskCommand>): AddToDeskCommand => ({
  command: 'add-to-desk',
  target: 'selection',
  desk: 'd1',
  pageUrl: 'https://example.com/article',
  pageTitle: 'An article',
  ...o
})

describe('what a clicked thing becomes on the desk', () => {
  it('short selected text: a sticky with just the words', () => {
    expect(widgetDraftFor(cmd({ text: '  The key line.  ' }))).toEqual({ kind: 'sticky', title: '', content: 'The key line.', noun: 'selection' })
  })
  it('longer text: a note that keeps where it came from', () => {
    const text = 'x'.repeat(STICKY_MAX_CHARS + 1)
    const d = widgetDraftFor(cmd({ text }))!
    expect(d.kind).toBe('note')
    expect(d.title).toBe('An article')
    expect(d.content).toBe(`${text}\n\nFrom [An article](https://example.com/article)`)
    // Paragraphs make a note even when short.
    expect(widgetDraftFor(cmd({ text: 'One.\n\nTwo.' }))!.kind).toBe('note')
  })
  it('an image, a video with an address, a link, a page', () => {
    expect(widgetDraftFor(cmd({ target: 'image', url: 'https://cdn.example.com/a.png' }))).toMatchObject({ kind: 'image', content: 'https://cdn.example.com/a.png' })
    expect(widgetDraftFor(cmd({ target: 'video', url: 'https://cdn.example.com/v.mp4' }))).toMatchObject({ kind: 'video', content: 'https://cdn.example.com/v.mp4' })
    expect(widgetDraftFor(cmd({ target: 'link', url: 'https://other.example.com/' }))).toMatchObject({ kind: 'webview', content: 'https://other.example.com/', title: 'other.example.com' })
    expect(widgetDraftFor(cmd({ target: 'page', url: 'https://example.com/article' }))).toMatchObject({ kind: 'webview', title: 'An article' })
  })
  it('a streamed video (no address): the page that plays it, as a browser work widget', () => {
    expect(widgetDraftFor(cmd({ target: 'video', url: undefined }))).toMatchObject({ kind: 'webview', content: 'https://example.com/article', noun: 'video' })
  })
  it('nothing to add is nothing, never an empty work widget', () => {
    expect(widgetDraftFor(cmd({ text: '   ' }))).toBeNull()
    expect(widgetDraftFor(cmd({ target: 'image' }))).toBeNull()
  })
})

describe('where it lands on a desk that is not on screen', () => {
  it('to the right of what is already there; an empty desk gets the top left', () => {
    expect(placeBesideExisting([])).toEqual({ x: 80, y: 80 })
    expect(placeBesideExisting([{ x: 0, y: 50, width: 300, height: 200 }, { x: 400, y: 10, width: 100, height: 100 }])).toEqual({ x: 540, y: 10 })
  })
})

describe('Ask PlexiiAssist about this', () => {
  it('quotes the passage and names its page, leaving room for the question', () => {
    const p = askAboutPrompt('Line one\nLine two', 'An article', 'https://example.com/a')
    expect(p).toBe('About this passage (from An article, https://example.com/a):\n\n> Line one\n> Line two\n\n')
  })
})

describe('the AI actions are one catalogue', () => {
  it('the web menu offers known actions only, with the work widget menu\'s words', () => {
    for (const id of WEB_SELECTION_AI_ACTIONS) expect(aiTextAction(id)).not.toBeNull()
    expect(resolveAiCommand('summarise')).toEqual({ label: 'Summarise', instruction: AI_DIRECT_ACTIONS.find((a) => a.id === 'summarise')!.instruction, awaitInput: false })
    expect(resolveAiCommand('explain')?.instruction).toMatch(/do not add facts/i)
    expect(resolveAiCommand('translate:French')?.label).toBe('Translate to French')
    expect(resolveAiCommand('tone:Formal')?.instruction).toMatch(/formal tone/)
    expect(resolveAiCommand('custom')).toMatchObject({ awaitInput: true, instruction: '' })
    expect(resolveAiCommand('translate:Klingon')).toBeNull()
    expect(resolveAiCommand('delete-everything')).toBeNull()
  })
})
