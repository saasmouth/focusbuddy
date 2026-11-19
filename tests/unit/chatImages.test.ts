// Pictures attached in the assistant's composer, as model input
// (main/ai/chatImages.ts, main/ai/creditMode.minimumCostCredits,
// renderer/src/lib/composerAttachments.ts).
import { describe, it, expect } from 'vitest'
import { imageBlocks, withImagesOnLastUser, ChatImageError, MAX_CHAT_IMAGES, imageTokenCeiling, imageTokens, pictureSize, requestImageTokens } from '../../src/main/ai/chatImages'
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

/** A picture's base64 whose header says width × height, padded to `bytes` with filler (only the header is read). */
function pngOf(width: number, height: number, bytes = 64): string {
  const head = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(head, 0)
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - 33), 0x41)]).toString('base64')
}
const imageBody = (model: string, data: string): Record<string, unknown> => ({
  model,
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'hello' }] }]
})
const textBody = (model: string, text = 'hello'): Record<string, unknown> => ({ model, system: 'sys', messages: [{ role: 'user', content: text }] })
/** Credits per input token on this model, as minimumCostCredits prices text (6 characters a token). */
const perToken = (model: string): number => (minimumCostCredits(textBody(model, 'x'.repeat(600_000))) - minimumCostCredits(textBody(model, ''))) / 100_000

describe('what a picture costs, by model (as the signal server prices it)', () => {
  it("each model's ceiling: 1,568 tokens before Claude 4.7, 4,784 from it, and the most when unsure", () => {
    expect(imageTokenCeiling('claude-haiku-4-5')).toBe(1568)
    expect(imageTokenCeiling('claude-sonnet-4-6')).toBe(1568)
    expect(imageTokenCeiling('claude-opus-4-6')).toBe(1568)
    expect(imageTokenCeiling('claude-opus-4-7')).toBe(4784)
    expect(imageTokenCeiling('claude-sonnet-5-5')).toBe(4784)
    expect(imageTokenCeiling('claude-haiku-5-5')).toBe(4784)
    expect(imageTokenCeiling('claude-opus-5')).toBe(4784)
    expect(imageTokenCeiling('something-new')).toBe(4784)
  })
  it('a picture costs its 28 px patches after the model shrinks it, up to the ceiling', () => {
    // The composer's own size: a 1568 × 882 screenshot.
    expect(imageTokens(1568, 882, 'claude-sonnet-5-5')).toBe(56 * 32)
    expect(imageTokens(1568, 882, 'claude-sonnet-4-6')).toBe(1568)
    expect(imageTokens(100, 50, 'claude-haiku-4-5')).toBe(4 * 2)
    // Past 2,576 px it is shrunk first, then capped.
    expect(imageTokens(4000, 4000, 'claude-opus-5-5')).toBe(4784)
    expect(imageTokens(0, 0, 'claude-sonnet-4-6')).toBe(1568)
  })
  it('reads the size from PNG, JPEG, GIF and WebP headers', () => {
    expect(pictureSize(Buffer.from(pngOf(1568, 882), 'base64'))).toEqual({ width: 1568, height: 882 })
    const gif = Buffer.from('474946383961' + '2003' + '5802' + '0000', 'hex') // 800 × 600
    expect(pictureSize(gif)).toEqual({ width: 800, height: 600 })
    // JPEG: SOI, an APP0 segment, then SOF0 with height 480, width 640.
    const jpeg = Buffer.from('ffd8' + 'ffe0' + '0010' + '4a46494600010100000100010000' + 'ffc0' + '0011' + '08' + '01e0' + '0280' + '03' + '012200022201031101', 'hex')
    expect(pictureSize(jpeg)).toEqual({ width: 640, height: 480 })
    const webpX = Buffer.alloc(30)
    webpX.write('RIFF', 0, 'latin1')
    webpX.write('WEBPVP8X', 8, 'latin1')
    webpX.writeUIntLE(1023, 24, 3) // width - 1
    webpX.writeUIntLE(767, 27, 3) // height - 1
    expect(pictureSize(webpX)).toEqual({ width: 1024, height: 768 })
    expect(pictureSize(Buffer.from('not a picture'))).toBeNull()
  })
  it("a request's pictures, wherever they sit; an unreadable one at the ceiling", () => {
    expect(requestImageTokens(imageBody('claude-sonnet-5-5', pngOf(1568, 882)))).toBe(1792)
    expect(requestImageTokens(imageBody('claude-sonnet-4-6', pngOf(1568, 882)))).toBe(1568)
    expect(requestImageTokens(imageBody('claude-sonnet-5-5', 'QUFBQQ=='))).toBe(4784)
    const inToolResult = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngOf(280, 280) } }] }] }] }
    expect(requestImageTokens(inToolResult)).toBe(100)
  })
})

describe('the credits floor counts a picture fairly', () => {
  it('a picture costs its tokens on the model, not its base64 as text', () => {
    const model = 'claude-sonnet-5-5'
    // A 1568 × 882 screenshot of ~1 MB: 1,792 tokens, not ~1.4M characters of text.
    const shot = pngOf(1568, 882, 1_050_000)
    const extra = minimumCostCredits(imageBody(model, shot)) - minimumCostCredits(textBody(model))
    const tokens = extra / perToken(model)
    expect(tokens).toBeGreaterThanOrEqual(1792)
    expect(tokens).toBeLessThan(1792 + 30) // the block's own few characters
  })
  it('an older model is charged its smaller ceiling, so the app and the server agree', () => {
    const model = 'claude-sonnet-4-6'
    const extra = minimumCostCredits(imageBody(model, pngOf(1568, 882, 4096))) - minimumCostCredits(textBody(model))
    const tokens = extra / perToken(model)
    expect(tokens).toBeGreaterThanOrEqual(1568)
    expect(tokens).toBeLessThan(1568 + 30)
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
