// Voice-note AI pipeline.
//
// Three stages, each callable independently from the renderer:
//
//   1. transcribeAudio(audioBytes, mimeType)
//      → POST to OpenAI /v1/audio/transcriptions (model "whisper-1"), returns
//        raw text. Requires the user to have set their OpenAI key in Settings.
//
//   2. processTranscript(transcript, mode)
//      → mode "full": returns transcript as-is (no AI call, no cost).
//      → mode "cleaned": Anthropic Haiku call that strips fillers,
//        false starts, and tangents while preserving the speaker's meaning.
//      → mode "summary": Anthropic Sonnet call that produces a tight 3-6
//        sentence summary plus a short bulleted action list.
//
//   3. extractActionsFromTranscript(transcript)
//      → Anthropic Sonnet call that proposes ActionProposal items (new
//        tasks, widgets, todo lists, pages) inferred from what the speaker
//        said. Returns [] when the transcript has no actionable content.
//
// Two design choices worth flagging:
//
//  - We never bundle whisper.cpp tonight. OpenAI Whisper API is the entire
//    transcription backend for v1. When local Whisper lands in a future
//    milestone, this module gets a second branch and the renderer chooses
//    via a settings toggle — no upstream change.
//
//  - Cleanup and summary use different models (Haiku vs Sonnet) on purpose.
//    Cleanup is mechanical and cheap; summary needs to understand structure
//    and reason about what to highlight. Defaulting both to Sonnet would
//    cost ~10× more for no quality gain on the cleanup case.

import { randomUUID } from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { getModelClient } from './modelClient'
import type { ActionProposal } from '@shared/types'
import { CREATE_TASK_DEFINITION, VOICE_WORK_ITEM_SHAPE } from './vocabulary'
import { normalizeIntentClass } from '@shared/workItems'
import { isWorkItemsEnabled } from '../workItemsPref'
import { resolveAnthropicKey, resolveOpenAIKey } from '../settingsStore'
import { transcribeLocal, type EngineSegment } from './localWhisper'
import { getTranscriptionProvider } from '../voiceProviderPref'
import { MODEL_HAIKU, MODEL_SONNET } from './modelRouting'

// Fourth processing mode joined the family when speaker diarisation
// landed: 'diarised' splits the transcript into "Speaker 1: …" /
// "Speaker 2: …" turns via a Claude post-process. It's NOT
// audio-based diarisation (no pyannote / Deepgram here) — it infers
// turn boundaries from conversational patterns in the transcript text.
// Good enough for one or two speakers in a meeting; not for crowds.
export type ProcessMode = 'full' | 'cleaned' | 'summary' | 'diarised'

// Which transcription engine to use. Cloud routes audio bytes to
// OpenAI Whisper API (paid, requires OpenAI key, fastest, multilingual);
// Local runs an ONNX Whisper tiny model in-process via
// @xenova/transformers (free, runs offline after first model download,
// CPU-bound, English-biased). The active provider is a user preference
// resolved per-call so a settings toggle propagates without restart.
export type TranscriptionProvider = 'cloud' | 'local'

export interface TranscribeResult {
  ok: true
  transcript: string
  durationSec: number | null
  language: string | null
  /** M2 — timestamped segments when the engine yields them (cloud always;
   *  local via return_timestamps). Null = engine gave text only. */
  segments: EngineSegment[] | null
}
export type { EngineSegment }

export interface TranscribeError {
  ok: false
  error: string
  // Helps the renderer surface "Set your OpenAI key in Settings" vs a
  // generic network/server error. Superset of localWhisper's reasons
  // ('decode' = renderer didn't pre-decode samples for the local provider;
  // 'model_load' = the local ONNX model failed to initialise) so a result
  // forwarded straight from transcribeLocal stays type-compatible.
  reason?: 'no_key' | 'network' | 'api' | 'unknown' | 'decode' | 'model_load'
}

/**
 * Audio input contract: callers MUST pass `bytes` + `mimeType` for the
 * cloud branch, and SHOULD pass `samples` + `sampleRate` for the local
 * branch. The renderer pre-decodes via Web Audio API when it knows the
 * user is on the local provider (cheap; AudioContext exists in
 * Chromium). For cloud, raw compressed bytes are 5-10x smaller over
 * IPC than the equivalent Float32Array, so we keep that path raw.
 *
 * When the local provider is active and the renderer DIDN'T pre-decode
 * (e.g. older renderer talking to newer main), we return a clear error
 * rather than silently fall back to cloud — cloud might not have a
 * key and either way silent provider switching is a confusing UX.
 */
export interface TranscribeInput {
  bytes?: Uint8Array
  mimeType?: string
  samples?: Float32Array
  sampleRate?: number
  /** M2 (CR-11) — force an engine; meetings force 'local'. */
  forceProvider?: TranscriptionProvider
}

/** M2 (CR-11) — a caller may FORCE a provider. Meetings force 'local': you
 *  cannot ask four people to consent to a local-first recording and then
 *  ship their voices to a third party they were never told about. There is
 *  deliberately NO cloud fallback on that path — failing honestly beats a
 *  silent second disclosure. */
export async function transcribeAudio(
  input: TranscribeInput
): Promise<TranscribeResult | TranscribeError> {
  const provider = input.forceProvider ?? getTranscriptionProvider()
  if (provider === 'local') {
    if (!input.samples || !input.sampleRate) {
      return {
        ok: false,
        error:
          'Local Whisper provider needs pre-decoded audio samples. The renderer should decode via AudioContext({sampleRate: 16000}) and pass samples + sampleRate.',
        reason: 'decode'
      }
    }
    return transcribeLocal(input.samples, input.sampleRate)
  }
  if (!input.bytes || !input.mimeType) {
    return {
      ok: false,
      error: 'Cloud transcription needs raw audio bytes + mimeType.',
      reason: 'unknown'
    }
  }
  return transcribeCloud(input.bytes, input.mimeType)
}

async function transcribeCloud(
  audioBytes: Uint8Array,
  mimeType: string
): Promise<TranscribeResult | TranscribeError> {
  const key = resolveOpenAIKey()
  if (!key) {
    return {
      ok: false,
      error: 'No OpenAI key set. Add one in Settings → AI · API keys, or switch to Local in Voice settings.',
      reason: 'no_key'
    }
  }

  // OpenAI's API expects multipart/form-data with an audio file. We
  // build the form manually (no form-data dep) since Node 20+ has a
  // native FormData + Blob.
  const ext = guessExtension(mimeType)
  // Copy into a fresh ArrayBuffer-backed view: a bare Uint8Array is typed
  // Uint8Array<ArrayBufferLike>, which (since ArrayBufferLike may be a
  // SharedArrayBuffer) isn't a valid BlobPart under lib.dom's stricter typing.
  const blob = new Blob([new Uint8Array(audioBytes)], { type: mimeType })
  const form = new FormData()
  form.append('file', blob, `voice-note.${ext}`)
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  // No language hint — Whisper auto-detects, which is the right default
  // for a global app; we surface the detected language back to the UI.

  // 90-second wall-clock cap so a stuck fetch can't leave the widget
  // pinned in 'transcribing' forever. Whisper API normally responds in
  // ~3s for short clips, ~30s for long. 90s is generous but not
  // infinite — past that the user should see an error and retry.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  // Log to main-process stderr so a user running with --enable-logging
  // (or the dev console) can see what's happening when the widget
  // appears stuck. Cheap to do, invaluable for diagnosis.
  // eslint-disable-next-line no-console
  console.log(
    `[voiceNote] cloud transcribe: ${audioBytes.byteLength} bytes, mime=${mimeType}`
  )
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      const short = txt.length > 240 ? txt.slice(0, 240) + '…' : txt
      // eslint-disable-next-line no-console
      console.error(`[voiceNote] Whisper ${res.status}: ${short}`)
      return {
        ok: false,
        error: `Whisper ${res.status}${short ? ' · ' + short : ''}`,
        reason: 'api'
      }
    }
    const body = (await res.json()) as {
      text?: string
      duration?: number
      language?: string
      // verbose_json has ALWAYS carried these; the old parser threw them away.
      segments?: Array<{ start?: number; end?: number; text?: string; avg_logprob?: number }>
    }
    if (typeof body.text !== 'string') {
      return { ok: false, error: 'Whisper returned no text.', reason: 'api' }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[voiceNote] cloud transcribe ok: ${body.text.length} chars, lang=${body.language ?? '?'}`
    )
    const segments: EngineSegment[] = Array.isArray(body.segments)
      ? body.segments
          .filter((s) => typeof s.text === 'string' && s.text.trim())
          .map((s) => ({
            startMs: Math.max(0, Math.round((s.start ?? 0) * 1000)),
            endMs: Math.round((s.end ?? 0) * 1000),
            text: (s.text as string).trim(),
            // Whisper's avg_logprob → a 0..1 confidence. exp() of a mean
            // token logprob is the standard, honest reading of what the
            // engine itself believes about this span.
            confidence:
              typeof s.avg_logprob === 'number'
                ? Math.max(0, Math.min(1, Math.exp(s.avg_logprob)))
                : null
          }))
      : []
    return {
      ok: true,
      transcript: body.text.trim(),
      durationSec: typeof body.duration === 'number' ? body.duration : null,
      language: typeof body.language === 'string' ? body.language : null,
      segments: segments.length ? segments : null
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    // eslint-disable-next-line no-console
    console.error('[voiceNote] cloud transcribe failed:', err)
    return {
      ok: false,
      error: aborted
        ? 'Whisper request timed out after 90s. Network slow or OpenAI degraded — try again.'
        : err instanceof Error
          ? err.message
          : String(err),
      reason: 'network'
    }
  } finally {
    clearTimeout(timeout)
  }
}

function guessExtension(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm' // browser MediaRecorder default
}

export interface ProcessResult {
  ok: true
  mode: ProcessMode
  text: string
}

export interface ProcessError {
  ok: false
  error: string
  reason?: 'no_key' | 'api' | 'unknown'
}

export async function processTranscript(
  transcript: string,
  mode: ProcessMode
): Promise<ProcessResult | ProcessError> {
  if (mode === 'full') {
    return { ok: true, mode, text: transcript }
  }
  const key = resolveAnthropicKey()
  if (!key) {
    return {
      ok: false,
      error: 'No Anthropic key set. Add one in Settings → AI · API keys.',
      reason: 'no_key'
    }
  }
  const client = getModelClient(key)
  try {
    if (mode === 'cleaned') {
      const resp = await client.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 2048,
        system:
          'You are a transcript editor. Take a raw spoken transcript and return a cleaned version that:\n' +
          '- removes filler words ("um", "uh", "like", "you know")\n' +
          '- removes false starts and repeated phrases\n' +
          '- preserves the speaker\'s meaning, tone, and ordering\n' +
          '- adds light punctuation and paragraph breaks where natural\n' +
          'Return ONLY the cleaned transcript. No preamble, no commentary, no markdown headings.',
        messages: [{ role: 'user', content: transcript }]
      })
      return { ok: true, mode, text: extractTextBlocks(resp) }
    }
    if (mode === 'diarised') {
      // Conversational-pattern diarisation. We are NOT using audio
      // features (no pyannote / Deepgram in v1) — we ask Claude to
      // infer turn boundaries from textual cues: questions answered
      // by a different voice, name mentions ("Sarah, what do you
      // think?"), pronoun shifts, topic pivots that read as a
      // response rather than a continuation.
      //
      // Sonnet for this — Haiku is too eager to over-split and
      // under-names speakers. Sonnet's better at "is this one person
      // monologuing or two people swapping" judgements.
      const resp = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 2048,
        system:
          'You are a transcript diariser. The input is a raw spoken transcript with no speaker labels. Output it with speaker turn labels inferred from conversational patterns.\n' +
          '\n' +
          'Rules:\n' +
          '- Detect 1 to 4 distinct speakers.\n' +
          '- If only one speaker appears to be talking throughout, return the transcript prefixed with "Speaker 1: " and that\'s it — do NOT split a monologue into fake turns.\n' +
          '- Otherwise, prefix each turn with "Speaker N: " (N is 1, 2, 3, or 4) followed by that speaker\'s contiguous remark.\n' +
          '- Put each turn on its own paragraph with a blank line between turns.\n' +
          '- Use textual cues only: question-answer pairs across pronoun shifts, name mentions, replies that begin with "Yeah / Right / Well", topic pivots that read as a response.\n' +
          '- If a name is mentioned ("Sarah said X" / "thanks Mike"), you may keep the numeric label — do not invent first-name labels.\n' +
          '- Light filler cleanup ("um", "uh") is fine but do not paraphrase.\n' +
          '\n' +
          'Return ONLY the diarised transcript. No preamble, no commentary, no markdown.',
        messages: [{ role: 'user', content: transcript }]
      })
      return { ok: true, mode, text: extractTextBlocks(resp) }
    }
    // mode === 'summary'
    const resp = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      system:
        'You summarize spoken voice notes. Return:\n' +
        '- a 3-6 sentence summary paragraph\n' +
        '- a blank line\n' +
        '- a "Key points:" bulleted list (3-7 bullets, "- " prefix)\n' +
        'No preamble. No outro. No headings other than "Key points:".',
      messages: [{ role: 'user', content: transcript }]
    })
    return { ok: true, mode, text: extractTextBlocks(resp) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg,
      reason: 'api'
    }
  }
}

export interface ExtractResult {
  ok: true
  proposals: ActionProposal[]
}

export interface ExtractError {
  ok: false
  error: string
  reason?: 'no_key' | 'api' | 'parse'
}

export async function extractActionsFromTranscript(
  transcript: string
): Promise<ExtractResult | ExtractError> {
  const key = resolveAnthropicKey()
  if (!key) {
    return {
      ok: false,
      error: 'No Anthropic key set. Add one in Settings → AI · API keys.',
      reason: 'no_key'
    }
  }
  const client = getModelClient(key)

  // We constrain Claude's output via a tight schema description in the
  // system prompt + explicit tool-style JSON. Keeping it text-mode (not
  // a real tool call) sidesteps the schema-validation roundtrip the SDK
  // would otherwise add; the parser below is defensive against any
  // surrounding prose anyway.
  const SYSTEM =
    'You read a voice-note transcript and propose concrete actions to add to a personal desk workspace.\n' +
    '\n' +
    'Return a JSON array of action objects. Each action MUST be one of these shapes:\n' +
    '\n' +
    '{"kind":"create-task","title":"…","notes":"…","reason":"…"}  (' +
    CREATE_TASK_DEFINITION +
    ')\n' +
    // Δ13 (S5): "remind me to call Bob" is the canonical work-item utterance —
    // the shape appears the moment the capability is on, never before.
    (isWorkItemsEnabled() ? VOICE_WORK_ITEM_SHAPE : '') +
    '{"kind":"create-todo-list","title":"…","items":["…","…"],"reason":"…"}\n' +
    '{"kind":"create-widget","widgetKind":"sticky"|"note"|"markdown"|"page","title":"…","content":"…","reason":"…"}\n' +
    '{"kind":"create-page","title":"…","content":"…","reason":"…"}\n' +
    '\n' +
    'Rules:\n' +
    '- Return ONLY the JSON array. No prose, no markdown fences.\n' +
    '- If the transcript has no actionable content, return [].\n' +
    '- Prefer one well-scoped action over many tiny ones. Cap at 8 items.\n' +
    '- "reason" is a one-line justification grounded in the transcript.\n' +
    '- For create-page content, write plain text — the apply layer wraps it as Tiptap.\n' +
    '- Skip anything that\'s pure reminiscence or vent — only propose for things the speaker clearly wants done.'

  try {
    const resp = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: transcript }]
    })
    const text = extractTextBlocks(resp).trim()
    const parsed = safeParseProposals(text)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, reason: 'parse' }
    }
    return { ok: true, proposals: parsed.proposals }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg,
      reason: 'api'
    }
  }
}

// Pull a single text string out of an Anthropic message response. Most
// responses are a single text block but we defensively concatenate all
// text blocks just in case.
function extractTextBlocks(resp: Anthropic.Message): string {
  const out: string[] = []
  for (const block of resp.content) {
    if (block.type === 'text') out.push(block.text)
  }
  return out.join('\n').trim()
}

// Parse the model's JSON array output. Tolerant of leading/trailing prose
// or accidental markdown fences ("```json … ```"). Filters items to a
// strict allowlist before returning so a hallucinated kind can't break
// downstream applyProposal.
type ParseOk = { ok: true; proposals: ActionProposal[] }
type ParseErr = { ok: false; error: string }
function safeParseProposals(raw: string): ParseOk | ParseErr {
  if (!raw) return { ok: true, proposals: [] }
  // Strip markdown fence if Claude added one despite instructions.
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  // If there's surrounding prose, grab the first [...] block.
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    return { ok: true, proposals: [] }
  }
  const slice = cleaned.slice(start, end + 1)
  let arr: unknown
  try {
    arr = JSON.parse(slice)
  } catch (err) {
    return {
      ok: false,
      error: `Could not parse proposals JSON: ${(err as Error).message}`
    }
  }
  if (!Array.isArray(arr)) return { ok: true, proposals: [] }

  const proposals: ActionProposal[] = []
  for (const item of arr.slice(0, 8)) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    const kind = obj.kind
    const id = randomUUID()
    if (kind === 'create-work-item' && typeof obj.title === 'string') {
      // Reserved Attention-layer kind (S0): parsed everywhere, executes nowhere
      // until the work-items capability ships.
      proposals.push({
        id,
        kind: 'create-work-item',
        title: obj.title,
        notes: typeof obj.notes === 'string' ? obj.notes : undefined,
        intentClass: normalizeIntentClass(obj.intentClass),
        reason: typeof obj.reason === 'string' ? obj.reason : undefined
      })
    } else if (kind === 'create-task' && typeof obj.title === 'string') {
      proposals.push({
        id,
        kind: 'create-task',
        title: obj.title,
        notes: typeof obj.notes === 'string' ? obj.notes : undefined,
        parentId: typeof obj.parentId === 'string' ? obj.parentId : undefined,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined
      })
    } else if (
      kind === 'create-todo-list' &&
      typeof obj.title === 'string' &&
      Array.isArray(obj.items)
    ) {
      const items = obj.items.filter((x): x is string => typeof x === 'string')
      proposals.push({
        id,
        kind: 'create-todo-list',
        title: obj.title,
        items,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined
      })
    } else if (
      kind === 'create-widget' &&
      typeof obj.widgetKind === 'string' &&
      ['sticky', 'note', 'markdown', 'page'].includes(obj.widgetKind)
    ) {
      proposals.push({
        id,
        kind: 'create-widget',
        widgetKind: obj.widgetKind as 'sticky' | 'note' | 'markdown' | 'page',
        title: typeof obj.title === 'string' ? obj.title : undefined,
        content: typeof obj.content === 'string' ? obj.content : undefined,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined
      })
    } else if (
      kind === 'create-page' &&
      typeof obj.title === 'string' &&
      typeof obj.content === 'string'
    ) {
      proposals.push({
        id,
        kind: 'create-page',
        title: obj.title,
        // The page widget consumes serialized Tiptap JSON. For
        // plain-text we wrap each non-empty line in a paragraph node.
        content: plainTextToTiptapJson(obj.content),
        reason: typeof obj.reason === 'string' ? obj.reason : undefined
      })
    }
    // Silently drop anything else — the model knows the allowlist but we
    // don't trust it to never improvise.
  }
  return { ok: true, proposals }
}

function plainTextToTiptapJson(text: string): string {
  const lines = text.split('\n').map((l) => l.trim())
  const paragraphs = lines
    .filter((l) => l.length > 0)
    .map((l) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: l }]
    }))
  return JSON.stringify({ type: 'doc', content: paragraphs })
}
