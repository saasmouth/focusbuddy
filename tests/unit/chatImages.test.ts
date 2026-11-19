// Pictures attached in the assistant's composer, as model input
// (main/ai/chatImages.ts, main/ai/creditMode.minimumCostCredits,
// renderer/src/lib/composerAttachments.ts).
import { describe, it, expect } from 'vitest'
import { imageBlocks, withImagesOnLastUser, ChatImageError, MAX_CHAT_IMAGES } from '../../src/main/ai/chatImages'
import { minimumCostCredits } from '../../src/main/ai/creditMode'
import { toOpenAIRequest } from '../../src/main/ai/local/openaiClient'
import { flattenRequest } from '../../src/main/ai/local/localClient'
import { attachedNote, classifyFile, picturesFit, refusalFor, MAX_TOTAL_IMAGE_CHARS, type ComposerAttachment } from '../../src/renderer/src/lib/composerAttachments'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANBAEB/1vLnwAAAABJRU5ErkJggg=='

describe('image blocks', () => {
  it('a picture becomes an Anthropic image block', () => {
    expect(imageBlocks([{ mediaType: 'image/png', data: PNG, name: 'shot.png' }])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
    ])
    expect(imageBlocks(undefined)).toEqual([])
  })
  it('refuses by name: a kind the model cannot read, garbage, too many', () => {
    expect(() => imageBlocks([{ mediaType: 'image/bmp' as never, data: PNG, name: 'old.bmp' }])).toThrow(/“old.bmp” is not a picture/)
    expect(() => imageBlocks([{ mediaType: 'image/png', data: 'not base64!', name: 'x.png' }])).toThrow(ChatImageError)
    const many = Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => ({ mediaType: 'image/png' as const, data: PNG }))
    expect(() => imageBlocks(many)).toThrow(/At most 5 pictures/)
  })
  it('the pictures ride on the LAST user turn, before its text; others are untouched', () => {
    const blocks = imageBlocks([{ mediaType: 'image/jpeg', data: PNG }])
    const msgs = withImagesOnLastUser(
      [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'what is in this?' }
      ],
      blocks
    )
    expect(msgs[0]).toEqual({ role: 'user', content: 'earlier' })
    expect(msgs[2]).toEqual({ role: 'user', content: [blocks[0], { type: 'text', text: 'what is in this?' }] })
    expect(withImagesOnLastUser([{ role: 'user', content: 'x' }], [])).toEqual([{ role: 'user', content: 'x' }])
  })
})

describe('the credits floor counts a picture fairly', () => {
  it('base64 bytes are not counted as text, so an affordable picture is not refused', () => {
    const big = 'A'.repeat(1_400_000)
    const text = { model: 'claude-sonnet-5-5', system: 'sys', messages: [{ role: 'user', content: 'hello' }] }
    const withPicture = {
      ...text,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }, { type: 'text', text: 'hello' }] }]
    }
    // Within a few credits of the text alone, not ~1.4M characters dearer.
    expect(minimumCostCredits(withPicture) - minimumCostCredits(text)).toBeLessThan(0.05)
    expect(minimumCostCredits(withPicture)).toBeGreaterThan(0)
  })
})

describe('composer attachments', () => {
  it('sorts files into pictures, documents and the rest', () => {
    expect(classifyFile({ name: 'shot.png', type: 'image/png' })).toBe('image')
    expect(classifyFile({ name: 'IMG_1.HEIC', type: '' })).toBe('image')
    expect(classifyFile({ name: 'Q3 report.pdf', type: 'application/pdf' })).toBe('file')
    expect(classifyFile({ name: 'notes.md', type: '' })).toBe('file')
    expect(classifyFile({ name: 'app.zip', type: 'application/zip' })).toBe('unsupported')
  })
  it('refuses by name what cannot go, and past five of a kind', () => {
    expect(refusalFor({ name: 'app.zip', type: 'application/zip' }, [])).toMatch(/cannot read “app.zip”/)
    const five: ComposerAttachment[] = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, kind: 'image' as const, name: `${i}.png`, status: 'reading' as const }))
    expect(refusalFor({ name: '6.png', type: 'image/png' }, five)).toMatch(/At most 5 pictures/)
    expect(refusalFor({ name: 'a.txt', type: 'text/plain' }, five)).toBeNull()
  })
  it('pictures that together would be too large for one request are refused', () => {
    const half = 'A'.repeat(MAX_TOTAL_IMAGE_CHARS / 2)
    const one: ComposerAttachment = { id: 'a', kind: 'image', name: 'a.png', status: 'ready', image: { mediaType: 'image/png', data: half }, thumb: '' }
    expect(picturesFit([one], { mediaType: 'image/png', data: half })).toBe(true)
    expect(picturesFit([one], { mediaType: 'image/png', data: half + 'A' })).toBe(false)
  })
  it('the message says what went with it', () => {
    expect(attachedNote(['shot.png', 'Q3 report.pdf'])).toBe('(Attached: shot.png, Q3 report.pdf)')
    expect(attachedNote([])).toBe('')
  })
})

describe('each AI source with a picture attached', () => {
  const asSent = () => ({
    max_tokens: 200,
    messages: withImagesOnLastUser([{ role: 'user', content: 'what is in this?' }], imageBlocks([{ mediaType: 'image/png', data: PNG, name: 'shot.png' }]))
  })
  it('an OpenAI key gets it as an image_url part beside the question', () => {
    const msgs = toOpenAIRequest(asSent(), 'gpt-standard', false).messages as Array<{ content: unknown }>
    expect(msgs[msgs.length - 1].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      { type: 'text', text: 'what is in this?' }
    ])
  })
  it('Local refuses it by name (the router then asks before using the cloud), never dropping it', () => {
    expect(() => flattenRequest(asSent())).toThrow(/images/)
  })
})
