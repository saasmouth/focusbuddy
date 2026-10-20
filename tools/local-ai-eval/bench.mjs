// Raw engine benchmark for a GGUF model through node-llama-cpp, the same runtime
// the app ships. Measures what a user feels, on THIS machine:
//
//   load       wall time from loadModel() to a ready context (cold page cache
//              is not forced; run twice and report the second if you want warm)
//   prefill    prompt-processing throughput over a ~N-token real document
//   ttft       time to first generated token after that prompt
//   gen        steady generation throughput (tokens / second)
//   reuse      ttft for a SECOND request that shares the long prefix, which is
//              what a follow-up chat turn looks like (KV-cache reuse)
//   memory     process RSS delta and, on unified-memory Macs, the GPU-visible
//              allocation reported by llama.cpp
//
// Usage:
//   node tools/local-ai-eval/bench.mjs <model.gguf> [--ctx 16384] [--kv f16|q8_0]
//                                       [--prefill-tokens 6000] [--out results.json]
//
// Nothing here is estimated: every number printed is read from a clock or from
// the engine. A run that fails prints the error and exits non-zero.
import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const args = process.argv.slice(2)
const modelPath = args.find((a) => !a.startsWith('--'))
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
if (!modelPath) {
  console.error('usage: bench.mjs <model.gguf> [--ctx N] [--prefill-tokens N] [--out file]')
  process.exit(2)
}
const ctxSize = Number(opt('ctx', '16384'))
const prefillTarget = Number(opt('prefill-tokens', '6000'))
const outFile = opt('out', null)
const kv = opt('kv', 'f16')

// A real long document from this repository, so the prefill text is ordinary
// English prose and markdown rather than a synthetic repeat that tokenises
// unusually well.
function longDocument() {
  const docsDir = join(root, 'docs')
  let text = ''
  for (const f of readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort()) {
    text += readFileSync(join(docsDir, f), 'utf8') + '\n\n'
    if (text.length > 200_000) break
  }
  return text
}

const mb = (n) => Math.round(n / 1024 / 1024)

const { getLlama, LlamaChatSession, resolveChatWrapper } = await import('node-llama-cpp')

const rss0 = process.memoryUsage().rss
const t0 = performance.now()
const llama = await getLlama({ gpu: 'auto', build: 'never', progressLogs: false, logLevel: 'error' })
const tLlama = performance.now()
const vram0 = await llama.getVramState()
const model = await llama.loadModel({ modelPath })
const context = await model.createContext({
  contextSize: ctxSize,
  flashAttention: true,
  ...(kv === 'q8_0' ? { experimentalKvCacheKeyType: 'Q8_0', experimentalKvCacheValueType: 'Q8_0' } : {})
})
const tLoaded = performance.now()
const vram1 = await llama.getVramState()
const rss1 = process.memoryUsage().rss

// Build a prompt of roughly prefillTarget tokens from the real document.
const doc = longDocument()
let lo = 1000
let hi = doc.length
let chunk = doc.slice(0, hi)
while (lo < hi - 200) {
  const mid = Math.floor((lo + hi) / 2)
  const n = model.tokenize(doc.slice(0, mid)).length
  if (n > prefillTarget) hi = mid
  else lo = mid
}
chunk = doc.slice(0, lo)
const promptTokens = model.tokenize(chunk).length

const sequence = context.getSequence()
// The same chat template settings the app uses (src/main/ai/local/engineCore.ts).
const chatWrapper = resolveChatWrapper({
  fileInfo: model.fileInfo,
  tokenizer: model.tokenizer,
  customWrapperSettings: { qwen: { thoughts: 'discourage' }, gemma4: { reasoning: false } }
})
const session = new LlamaChatSession({
  contextSequence: sequence,
  chatWrapper,
  systemPrompt: 'You are a concise assistant. Answer in plain prose.'
})

async function timedPrompt(text, maxTokens) {
  let first = 0
  let chunks = 0
  const start = performance.now()
  const res = await session.promptWithMeta(text, {
    maxTokens,
    temperature: 0,
    budgets: { thoughtTokens: 0 },
    onTextChunk: () => {
      if (!first) first = performance.now()
      chunks++
    }
  })
  const end = performance.now()
  const outText = res.response.filter((x) => typeof x === 'string').join('')
  const outTokens = model.tokenize(outText).length
  return { ttftMs: first ? first - start : null, totalMs: end - start, genMs: first ? end - first : null, outTokens, text: outText }
}

const q1 =
  `Here is a document:\n"""\n${chunk}\n"""\n\n` +
  'In two sentences, what is this document about? Then list three specific things it says.'
const r1 = await timedPrompt(q1, 256)
// Follow-up turn: the long prefix is already in the KV cache.
const r2 = await timedPrompt('Now give one more specific detail from the document, in one sentence.', 128)
// Pure generation throughput: a request whose output dwarfs its prompt.
session.resetChatHistory()
const r3 = await timedPrompt('Write about 300 words on how to plan a small product launch, as numbered steps.', 512)

const rss2 = process.memoryUsage().rss
const vram2 = await llama.getVramState()

const result = {
  model: basename(modelPath),
  diskBytes: statSync(modelPath).size,
  machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), platform: `${process.platform}-${process.arch}` },
  runtime: { nodeLlamaCpp: JSON.parse(readFileSync(join(root, 'node_modules/node-llama-cpp/package.json'), 'utf8')).version, gpu: llama.gpu, node: process.version },
  contextSize: context.contextSize,
  kvCache: kv,
  timings: {
    getLlamaMs: Math.round(tLlama - t0),
    loadMs: Math.round(tLoaded - tLlama),
    prefillPromptTokens: promptTokens,
    prefillTtftMs: r1.ttftMs && Math.round(r1.ttftMs),
    prefillTokPerSec: r1.ttftMs ? Math.round(promptTokens / (r1.ttftMs / 1000)) : null,
    followupTtftMs: r2.ttftMs && Math.round(r2.ttftMs),
    genTokens: r3.outTokens,
    genTokPerSec: r3.genMs ? +(r3.outTokens / (r3.genMs / 1000)).toFixed(1) : null,
    shortTtftMs: r3.ttftMs && Math.round(r3.ttftMs)
  },
  memory: {
    rssBeforeMB: mb(rss0),
    rssAfterLoadMB: mb(rss1),
    rssAfterRunMB: mb(rss2),
    gpuUsedBeforeMB: mb(vram0.used),
    gpuUsedAfterLoadMB: mb(vram1.used),
    gpuUsedAfterRunMB: mb(vram2.used),
    unifiedMemory: (vram0.unifiedSize ?? 0) > 0
  },
  samples: { summary: r1.text.slice(0, 400), followup: r2.text.slice(0, 200) }
}
console.log(JSON.stringify(result, null, 2))
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n')
await context.dispose()
await model.dispose()
await llama.dispose()
