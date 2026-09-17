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
    '- No access to the host app, its data, or other widgets. You cannot read the',
    '  user\'s files, desks or notes. Do not write code that tries.',
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
    '## Style',
    'These CSS variables are defined and follow the user\'s light/dark theme. Use',
    'them rather than hardcoded colours, or the widget will look wrong in one theme:',
    '  --plexi-bg  --plexi-fg  --plexi-muted  --plexi-border  --plexi-accent  --plexi-surface',
    'Aim for calm and dense: 12–13px text, generous hit targets, clear hierarchy, no',
    'decorative gradients. It should look like a native part of a quiet workspace.',
    'Give the body 12–14px of padding yourself.',
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
      max_tokens: 8000,
      system: systemPrompt(net, width, height),
      messages: [{ role: 'user', content: userMsg }]
    })
    const parts: string[] = []
    for (const block of resp.content) {
      if (block.type === 'text') parts.push(block.text)
    }
    code = unfence(parts.join('\n'))
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
