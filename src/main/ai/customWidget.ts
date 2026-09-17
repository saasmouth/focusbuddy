// Custom widget generation -- the user describes a tool in plain language and the
// model writes it.
//
// What comes back is a self-contained HTML fragment: markup, styles and logic in
// one piece, with no build step, no imports and no external assets. It runs in
// the sandbox described in @shared/customWidgetSandbox, which is also where the
// `plexi` bridge the prompt below refers to is defined and injected. The model is
// told about the bridge but is never trusted to include it.
//
// Two operations, one code path: `generate` writes a widget from a description,
// `refine` rewrites an existing one against an instruction. Refine passes the
// current source in full rather than asking for a patch -- these documents are
// small, and a whole-file rewrite cannot produce the half-applied diff that
// leaves a user's working widget broken.

import { getModelClient } from './modelClient'
import { resolveAnthropicKey } from '../settingsStore'
import {resolveModel, MODEL_HAIKU} from './modelRouting'
import { CUSTOM_WIDGET_MAX_CODE_BYTES } from '@shared/types'

export interface GenerateCustomWidgetInput {
  // What the user typed. Passed through verbatim.
  spec: string
  // Present for a refine: the document being changed.
  currentCode?: string
  // Whether this widget is allowed to reach the network. Changes what the model
  // is told it may use, so an offline widget is never written against fetch().
  net?: boolean
  // The widget's size on the desk, so the layout is written for the space it
  // will actually occupy rather than for an imaginary full page.
  width?: number
  height?: number
}

export type GenerateCustomWidgetResult =
  | { ok: true; code: string; model: string }
  | { ok: false; error: string; needsKey?: boolean }

/** Strip a markdown fence if the model wrapped its answer in one. */
function unfence(raw: string): string {
  const t = raw.trim()
  const fence = /^```(?:html|xml|markup)?\s*\n([\s\S]*?)\n?```$/i.exec(t)
  return fence ? fence[1].trim() : t
}

function systemPrompt(net: boolean, w: number, h: number): string {
  return [
    'You write single-file widgets for a desktop canvas app called PlexiDesk.',
    '',
    'Output ONLY the widget source. No preamble, no explanation, no markdown fence.',
    '',
    '## What you are writing',
    'One self-contained HTML fragment: markup, a <style> block and a <script> block.',
    'It is injected into a prepared document, so do NOT write <!doctype>, <html>,',
    '<head> or <body> tags — start directly with your own markup.',
    '',
    `## The space you have`,
    `The widget renders at roughly ${w}x${h} CSS pixels and the user can resize it.`,
    'Design for that size. Make it responsive with flexbox or grid — never assume a',
    'fixed viewport, and never let content overflow horizontally.',
    '',
    '## Hard constraints',
    '- No external resources of any kind: no <script src>, no <link rel=stylesheet>,',
    '  no web fonts, no CDN, no images by URL. Everything inline. A data: URI or an',
    '  inline <svg> is the way to draw something.',
    '- No localStorage, sessionStorage, cookies or IndexedDB. They throw here: the',
    '  widget runs on an opaque origin. Use the plexi state API below instead.',
    '- No access to the host app or its internals. You cannot reach the user\'s',
    '  files, desks or other widgets EXCEPT through plexi.getInputs() below, which',
    '  returns only what the user has explicitly wired into this widget. Do not',
    '  write code that tries to reach anything else — it will fail.',
    net
      ? '- Network: ALLOWED. You may fetch() public https endpoints. Handle failure\n  visibly — show the error in the widget, never a blank panel. Never send the\n  user\'s entered data anywhere the task did not explicitly ask for.'
      : '- Network: FORBIDDEN and blocked by policy. No fetch, no XHR, no WebSocket.\n  If the request seems to need live data, build it to work on data the user\n  enters or on values they can edit, and say so in the UI.',
    '',
    '## The host API (already present as window.plexi — never redefine it)',
    '- plexi.getState() -> object. This widget\'s saved data. Returns {} the first',
    '  time. Read it on load and render from it so the widget remembers.',
    '- plexi.setState(obj) -> saves. Call it whenever the user changes something.',
    '  Writes are debounced for you, so calling it on every keystroke is fine.',
    '  Objects only — not arrays, not primitives. Wrap a list: {items: [...]}.',
    '- plexi.setTitle(str) — renames the widget header.',
    '- plexi.requestHeight(px) — ask the desk to resize this widget vertically.',
    '- plexi.reportError(msg) — surface a failure to the user.',
    '',
    '### Reading what is wired into this widget',
    '- plexi.getInputs() -> array. The widgets the user has connected TO this one.',
    '  Each: {id, kind, title, text} and, when it is a table, also',
    '  {table: {id, columns: [{id, label, type}], rows: [{id, cells}]}}.',
    '  A cell is keyed by COLUMN ID, not by label. Compute over rows directly —',
    '  totals, filters, charts — rather than parsing text.',
    '- plexi.onInput(fn) -> unsubscribe. fn(inputs) fires whenever a wired source',
    '  changes. Re-render from it so the widget is LIVE, not a snapshot.',
    '- Inputs arrive by TWO routes and look identical: a wire the user drew on the',
    '  canvas, and anything they @ mentioned in the description of this widget.',
    '  Each carries `via: "wire" | "mention"` if you want to say where it came from.',
    '- The list is EMPTY until they do one of those. Say so in the empty state —',
    '  "wire in a table, or @ mention one, to begin" — never invent rows to fill space.',
    '',
    '### Doing things in the app',
    '- plexi.act(action) -> Promise<{ok} | {ok:false, reason}>. ALWAYS await it and',
    '  show the reason on failure; it can legitimately be refused.',
    '  Allowed actions, and nothing else:',
    '    {kind:"add-table-row", tableId, cells:{<columnId>: value}}',
    '    {kind:"set-cell", tableId, rowId, cells:{<columnId>: value}}',
    '    {kind:"create-knowledge-entry", title, body, tags?}',
    '    {kind:"open-url", url}  (http/https only)',
    '- tableId and rowId MUST come from plexi.getInputs(). A table that was neither',
    '  wired in nor @ mentioned is refused — this widget can only change what the',
    '  user pointed it at.',
    '- The user may not have granted write access, in which case each action is',
    '  put to them for approval. Never assume it succeeded; check the result.',
    '',
    '## Style',
    'These CSS variables are defined and follow the user\'s light/dark theme. Use',
    'them rather than hardcoded colours, or the widget will look wrong in one theme:',
    '  --plexi-bg  --plexi-fg  --plexi-muted  --plexi-border  --plexi-accent  --plexi-surface',
    'Aim for calm and dense: 12–13px text, generous hit targets, clear hierarchy, no',
    'decorative gradients. It should look like a native part of a quiet workspace.',
    'The body already has 12px of padding — do not add your own to <body>, and do',
    'not remove it.',
    '',
    '## Quality bar',
    '- It must WORK on first render, with no console errors.',
    '- Handle the empty state: what the widget looks like before any data exists.',
    '- Label controls. An unlabelled icon button is a puzzle, not an interface.',
    '- Keyboard: inputs reachable by Tab, Enter submits where that is natural.',
    '- If the user asks for something needing data you do not have, build the real',
    '  structure with honest empty states and let them enter it. Never invent',
    '  plausible-looking sample numbers and present them as real.'
  ].join('\n')
}

// A rich widget is a whole small application: markup, then a stylesheet, then
// its behaviour. 8000 did not fit one. This is per REQUEST, not per widget --
// a generation that runs out is continued rather than refused, so the real
// ceiling is this times the number of rounds below.
const GENERATION_TOKENS = 16000

// How many times a generation may be continued. Two extra rounds is ~48k tokens
// of document, far beyond the 200k byte cap a widget may occupy, so hitting this
// means something is wrong with the request rather than merely large.
const MAX_CONTINUATIONS = 2

export async function generateCustomWidget(
  input: GenerateCustomWidgetInput
): Promise<GenerateCustomWidgetResult> {
  const spec = (input?.spec ?? '').trim()
  if (!spec) return { ok: false, error: 'Describe the widget you want first.' }

  const key = resolveAnthropicKey()
  if (!key) {
    return {
      ok: false,
      error: 'Add an Anthropic API key in Settings to build custom widgets.',
      needsKey: true
    }
  }

  const net = input.net === true
  const width = Math.max(120, Math.round(input.width ?? 420))
  const height = Math.max(120, Math.round(input.height ?? 360))
  const model = resolveModel('custom_widget')
  const current = (input.currentCode ?? '').trim()

  const userMsg = current
    ? [
        'Here is the current widget source:',
        '',
        current,
        '',
        '---',
        '',
        'Change it as follows:',
        spec,
        '',
        'Return the COMPLETE updated source, not a diff. Keep everything that still',
        'works and preserve the shape of any data already saved through',
        'plexi.setState — the user has real data in this widget and a rename of a',
        'state key would lose it.'
      ].join('\n')
    : [
        'Build this widget:',
        '',
        spec,
        '',
        'Return the source now.'
      ].join('\n')

  let code: string
  try {
    const client = getModelClient(key)
    const resp = await client.messages.create({
      model,
      max_tokens: GENERATION_TOKENS,
      system: systemPrompt(net, width, height),
      messages: [{ role: 'user', content: userMsg }]
    })
    const textOf = (r: { content: Array<{ type: string } & Record<string, unknown>> }): string => {
      const parts: string[] = []
      for (const block of r.content) {
        if (block.type === 'text') parts.push(String(block.text ?? ''))
      }
      return parts.join('\n')
    }

    let raw = textOf(resp as never)
    let stop = resp.stop_reason as string

    // A widget is written in one order -- markup, then styles, then behaviour --
    // so a cut at the token ceiling lands after the markup and before either of
    // the other two, and what lands is unstyled markup that does nothing.
    //
    // Refusing that was honest but left a broken widget broken forever: every
    // rebuild of a spec that is simply BIG hit the same ceiling and refused
    // again. So finish it instead. The model is handed what it has written so
    // far and asked to continue from the exact character it stopped on.
    for (let round = 0; round < MAX_CONTINUATIONS && stop === 'max_tokens'; round++) {
      const more = await client.messages.create({
        model,
        max_tokens: GENERATION_TOKENS,
        system: systemPrompt(net, width, height),
        messages: [
          { role: 'user', content: userMsg },
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content:
              'You stopped mid-way. Continue from EXACTLY where you left off — your next ' +
              'character is the one that follows your last one. Do not repeat anything, do not ' +
              'start over, do not add a preamble or a code fence, and do not apologise. If you ' +
              'were part-way through a tag, an attribute or a CSS rule, finish that first.'
          }
        ]
      })
      raw += textOf(more as never)
      stop = more.stop_reason as string
    }

    if (stop === 'max_tokens') {
      // Still unfinished after continuing. Now it genuinely is too big, and
      // saying so beats writing a third of an application to the desk.
      return {
        ok: false,
        error:
          'That widget is bigger than I can finish, even continuing. Ask for a smaller ' +
          'version — the core of it first — and then refine to add the rest.'
      }
    }
    code = unfence(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.length > 240 ? msg.slice(0, 240) + '…' : msg }
  }

  if (!code) return { ok: false, error: 'The model returned an empty widget.' }
  if (!/<[a-z!/]/i.test(code)) {
    // Prose rather than markup means the model refused or misread the task.
    // Surfacing that beats rendering a paragraph of apology as a "widget".
    return {
      ok: false,
      error: 'The model replied with text instead of a widget. Try describing it more concretely.'
    }
  }
  // Independent of stop_reason, because a provider that does not report one is
  // not a reason to hand somebody a half-written document. An odd number of
  // angle brackets after the last complete tag means it stopped inside one.
  const lastClose = code.lastIndexOf('>')
  if (lastClose < code.length - 1 && code.slice(lastClose + 1).includes('<')) {
    return {
      ok: false,
      error: 'That widget came back unfinished, so it has not been saved. Try asking for something simpler.'
    }
  }
  if (Buffer.byteLength(code, 'utf8') > CUSTOM_WIDGET_MAX_CODE_BYTES) {
    return { ok: false, error: 'The generated widget was too large. Ask for something simpler.' }
  }

  return { ok: true, code, model }
}

/** Suggest a short name and a Material Symbols icon for a finished widget, so
 *  saving it to the library does not start with an empty "Name" field. Best
 *  effort: a failure here returns a usable fallback rather than blocking a save. */
export async function nameCustomWidget(input: {
  spec: string
}): Promise<{ name: string; icon: string }> {
  const fallbackName = (input?.spec ?? '').trim().split(/\s+/).slice(0, 4).join(' ') || 'Custom widget'
  const key = resolveAnthropicKey()
  if (!key) return { name: fallbackName, icon: 'widgets' }

  try {
    const client = getModelClient(key)
    const resp = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 120,
      system:
        'Name a small desktop widget from its description. Reply with exactly one line ' +
        'of JSON: {"name":"...","icon":"..."}. name is 1-3 words, title case, no quotes ' +
        'around it, naming the tool rather than describing it. icon is a valid Material ' +
        'Symbols outlined icon name in snake_case (e.g. calculate, timer, checklist, ' +
        'palette, currency_exchange). No other output.',
      messages: [{ role: 'user', content: input.spec }]
    })
    const text = resp.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    const m = /\{[\s\S]*\}/.exec(text)
    if (m) {
      const parsed = JSON.parse(m[0]) as { name?: unknown; icon?: unknown }
      const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallbackName
      const icon =
        typeof parsed.icon === 'string' && /^[a-z0-9_]+$/.test(parsed.icon.trim())
          ? parsed.icon.trim()
          : 'widgets'
      return { name: name.slice(0, 60), icon }
    }
  } catch {
    // Naming is a convenience. Never let it be the reason a save fails.
  }
  return { name: fallbackName, icon: 'widgets' }
}
