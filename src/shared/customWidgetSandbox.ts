// The sandbox that AI-built widgets run inside.
//
// The premise of the custom widget is that there is no limit on what the user can
// ask for. That freedom is about what a widget can BE -- any layout, any
// interaction, any logic the model can write -- and deliberately not about what it
// can REACH. Generated code is code nobody reviewed, so it is treated as hostile
// and given an execution context where being hostile buys it nothing.
//
// The boundary has three parts, and all three are applied HERE rather than asked
// of the model, because a security control the model has to remember to include
// is not a control at all:
//
//   1. The iframe carries sandbox="allow-scripts" WITHOUT allow-same-origin.
//      That combination puts the document on a unique opaque origin. It cannot
//      read this app's localStorage / IndexedDB / cookies, cannot reach
//      window.api or any ipcRenderer bridge, cannot read the parent DOM, and
//      cannot navigate the top frame. (See SANDBOX_ATTR -- the two tokens must
//      never both be present, which sandboxAttrIsSafe() asserts.)
//
//   2. A Content-Security-Policy meta element injected as the first thing in
//      <head>, before any markup the model produced. Network egress is denied
//      outright unless the user turned it on for this specific widget.
//
//   3. A host bridge, injected the same way, which is the ONLY channel between
//      the widget and the app. It speaks postMessage and carries exactly three
//      things: persisted state, a title, and a requested height.
//
// Everything below is pure string composition with no DOM and no React, so the
// boundary can be unit-tested directly rather than inferred from a rendered tree.

/** The iframe sandbox tokens. allow-same-origin is absent on purpose and adding
 *  it would collapse the entire boundary -- the widget would run in the app's own
 *  origin with access to its storage. */
export const SANDBOX_ATTR = 'allow-scripts'

/** Guards the one mistake that silently removes every protection here. */
export function sandboxAttrIsSafe(attr: string): boolean {
  const tokens = attr.split(/\s+/).filter(Boolean)
  return tokens.includes('allow-scripts') && !tokens.includes('allow-same-origin')
}

/** CSP for the generated document.
 *
 *  Offline (the default): no network at all. 'unsafe-inline' and 'unsafe-eval' are
 *  granted for scripts and styles because the whole document IS inline -- that is
 *  what self-contained means -- and because the opaque origin is what actually
 *  contains this code, not the script-src list. With connect-src 'none' there is
 *  nowhere for inline script to send anything.
 *
 *  Online (opt-in per widget): outbound https is permitted so a widget can call a
 *  real API. This is a genuine widening -- a widget that can fetch can also post
 *  what the user typed into it somewhere -- which is why it is off unless asked
 *  for, and why the UI labels it plainly. */
export function cspFor(net: boolean): string {
  const parts = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    net ? "img-src data: blob: https:" : "img-src data: blob:",
    net ? "media-src data: blob: https:" : "media-src data: blob:",
    net ? "connect-src https:" : "connect-src 'none'",
    // No <frame>/<iframe> of its own, no plugins, and it can never break out to
    // become the top-level page.
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ]
  return parts.join('; ')
}

/** The bridge injected into every generated widget.
 *
 *  Written as a plain string (not a bundled module) because it has to execute
 *  inside a document that has no module loader, no network and no shared origin
 *  with us. Kept deliberately small: every capability added here is a capability
 *  granted to unreviewed code. */
function bridgeScript(initialState: string, initialInputs: string): string {
  return `<script>(function(){
  "use strict";
  // The host's copy of this widget's saved data, inlined at compose time so the
  // widget can render its remembered state on the very first frame with no
  // round-trip and no loading flash.
  var state = ${initialState};
  // Resolved host-side from the wires drawn into this widget. Inlined at compose
  // time so a widget renders real data on its first frame.
  var inputs = ${initialInputs};
  var inputListeners = [];
  var actPending = {};
  var actSeq = 0;
  var pending = null;
  function post(type, payload) {
    try { parent.postMessage({ __plexi: 1, type: type, payload: payload }, '*'); } catch (e) {}
  }
  // Coalesce writes. A widget that calls setState on every keystroke should cost
  // one database write per idle moment, not one per character.
  function flush() {
    pending = null;
    post('state', state);
  }
  var plexi = {
    /** This widget's saved data. Returns a copy: mutating it does nothing until
     *  setState is called, which keeps "what is saved" unambiguous. */
    getState: function () {
      try { return JSON.parse(JSON.stringify(state)); } catch (e) { return {}; }
    },
    /** Persist this widget's data. Survives restarts and rides the same sync as
     *  the rest of the desk. Objects only, and bounded host-side. */
    setState: function (next) {
      if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
      state = next;
      if (pending) clearTimeout(pending);
      pending = setTimeout(flush, 250);
      return true;
    },
    /** Rename the widget's header from inside the widget. */
    setTitle: function (t) {
      if (typeof t === 'string' && t.trim()) post('title', t.trim().slice(0, 120));
    },
    /** Ask the desk to make this widget taller or shorter to fit its content. */
    requestHeight: function (px) {
      var n = Number(px);
      if (isFinite(n) && n > 0) post('height', Math.min(Math.round(n), 4000));
    },
    /** Report a failure the user should see, instead of failing silently inside
     *  a frame whose console nobody is reading. */
    reportError: function (msg) {
      post('error', String(msg == null ? 'Unknown error' : msg).slice(0, 500));
    },
    /** The widgets the user has wired INTO this one, resolved by the host.
     *
     *  A snapshot, not a query: a widget sees exactly what the person chose to
     *  connect and has no way to ask for anything else. Tables arrive with their
     *  columns and rows intact rather than flattened to text, which is what lets
     *  a widget actually compute over desk data. */
    getInputs: function () {
      try { return JSON.parse(JSON.stringify(inputs)); } catch (e) { return []; }
    },
    /** Called whenever a wired-in source changes, so a widget can be live
     *  rather than a snapshot of whenever it happened to load. */
    onInput: function (fn) {
      if (typeof fn === 'function') inputListeners.push(fn);
      return function () {
        var i = inputListeners.indexOf(fn);
        if (i >= 0) inputListeners.splice(i, 1);
      };
    },
    /** Ask the host to do something. The host decides: the verb must be one it
     *  allows, the target must be wired into this widget, and unless the user
     *  has switched this widget's write access on it is proposed for approval
     *  rather than run. Resolves to {ok} or {ok:false, reason}. */
    act: function (action) {
      var id = 'a' + (++actSeq);
      post('act', { id: id, action: action });
      return new Promise(function (resolve) {
        actPending[id] = resolve;
        // Never leave a caller awaiting forever if the host goes away.
        setTimeout(function () {
          if (actPending[id]) {
            delete actPending[id];
            resolve({ ok: false, reason: 'The desk did not answer.' });
          }
        }, 30000);
      });
    }
  };
  try { Object.freeze(plexi); } catch (e) {}
  window.plexi = plexi;

  // The host talks back on the same channel: the result of an act(), and fresh
  // inputs when a wired source changes. Anything else is ignored -- this frame
  // takes no instruction from anyone.
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.__plexiHost !== 1) return;
    if (d.type === 'act-result' && d.id && actPending[d.id]) {
      var resolve = actPending[d.id];
      delete actPending[d.id];
      try { resolve(d.payload); } catch (err) {}
      return;
    }
    if (d.type === 'inputs') {
      inputs = d.payload || [];
      for (var i = 0; i < inputListeners.length; i++) {
        try { inputListeners[i](plexi.getInputs()); } catch (err) {}
      }
    }
  });

  // Surface real failures to the host. Generated code that throws on load would
  // otherwise render as an empty rectangle with no explanation.
  window.addEventListener('error', function (e) {
    post('error', (e && e.message ? e.message : 'Script error') +
      (e && e.lineno ? ' (line ' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post('error', 'Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)));
  });

  // Auto-report height once the document settles, so most widgets size
  // themselves correctly without their author thinking about it.
  function reportNaturalHeight() {
    try {
      var h = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      if (h > 0) post('natural-height', h);
    } catch (e) {}
  }
  window.addEventListener('load', function () {
    reportNaturalHeight();
    post('ready', 1);
  });
  // Throttled: a widget whose content changes as the user types would otherwise
  // post a height on every frame of the reflow.
  var heightTimer = null;
  function scheduleHeightReport() {
    if (heightTimer) return;
    heightTimer = setTimeout(function () { heightTimer = null; reportNaturalHeight(); }, 200);
  }
  if (typeof ResizeObserver === 'function') {
    try {
      new ResizeObserver(scheduleHeightReport).observe(document.documentElement);
    } catch (e) {}
  }
})();<\/script>`
}

/** Theme variables handed to the widget so a generated widget looks like it
 *  belongs on the desk it is sitting on, in either theme, without the model
 *  having to guess this app's palette. */
function themeStyle(dark: boolean): string {
  const v = dark
    ? {
        bg: '#1c1917', fg: '#e7e5e4', muted: '#a8a29e', border: 'rgba(255,255,255,0.12)',
        accent: '#6366f1', surface: 'rgba(255,255,255,0.05)'
      }
    : {
        bg: '#ffffff', fg: '#1c1917', muted: '#78716c', border: 'rgba(0,0,0,0.12)',
        accent: '#6366f1', surface: 'rgba(0,0,0,0.03)'
      }
  return `<style>
  :root {
    --plexi-bg: ${v.bg}; --plexi-fg: ${v.fg}; --plexi-muted: ${v.muted};
    --plexi-border: ${v.border}; --plexi-accent: ${v.accent}; --plexi-surface: ${v.surface};
    color-scheme: ${dark ? 'dark' : 'light'};
  }
  html { margin: 0; padding: 0; }
  body {
    margin: 0; padding: 12px; background: var(--plexi-bg); color: var(--plexi-fg);
    font-family: ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    font-size: 13px; line-height: 1.5;
  }
  * { box-sizing: border-box; }
  ::selection { background: var(--plexi-accent); color: #fff; }
</style>`
}

export interface ComposeOptions {
  code: string
  state?: Record<string, unknown>
  net?: boolean
  dark?: boolean
  /** The wired-in sources, already resolved by the host. */
  inputs?: readonly WidgetInput[]
}

/** A widget wired INTO a custom widget, as the sandbox sees it.
 *
 *  Resolved host-side and pushed in. The widget cannot ask for anything that is
 *  not here, which is what keeps "read desk data" from meaning "read the
 *  workspace": the user decides by drawing a wire, and the grant is visible on
 *  the canvas as a line. */
export interface WidgetInput {
  id: string
  kind: string
  title: string
  /**
   * How this input got here: a wire drawn on the canvas, or an @ mention in the
   * widget's own description.
   *
   * Both are the user pointing at something on purpose, which is why both grant
   * the same access. It is surfaced because a widget reading data ought to be
   * able to say WHERE that data came from, and so can the person looking at it.
   */
  via?: 'wire' | 'mention'
  /** The source as plain text — always present, even for a table. */
  text: string
  /** Structured rows, when the source is a table. This is what lets a widget
   *  compute over real desk data rather than scrape a rendering of it. */
  table?: {
    id: string
    columns: Array<{ id: string; label: string; type: string }>
    rows: Array<{ id: string; cells: Record<string, unknown> }>
  }
}

/** Build the final srcdoc for a generated widget.
 *
 *  The CSP, theme and bridge are injected ahead of the model's markup regardless
 *  of what the model wrote. If it produced a full document we splice into its
 *  <head>; if it produced a fragment we wrap it. Either way the security
 *  preamble is first, so a document that tries to declare its own looser policy
 *  cannot widen what the first policy already restricted -- when two CSP headers
 *  or meta elements are present the browser enforces the intersection. */
export function composeCustomWidgetDocument(opts: ComposeOptions): string {
  const { code, state, net = false, dark = false, inputs } = opts
  let initial = '{}'
  try {
    // Escaped so no value inside the state can close the script element it is
    // inlined into.
    initial = JSON.stringify(state ?? {}).replace(/</g, '\\u003c')
  } catch {
    initial = '{}'
  }

  let initialInputs = '[]'
  try {
    initialInputs = JSON.stringify(inputs ?? []).replace(/</g, '\\u003c')
  } catch {
    initialInputs = '[]'
  }

  const preamble =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${cspFor(net)}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    themeStyle(dark) +
    bridgeScript(initial, initialInputs)

  const src = (code || '').trim()

  // A full document: put the preamble at the very start of <head>.
  const headOpen = /<head[^>]*>/i.exec(src)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return src.slice(0, at) + preamble + src.slice(at)
  }

  // A document with <html> but no <head>: create one.
  const htmlOpen = /<html[^>]*>/i.exec(src)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return src.slice(0, at) + '<head>' + preamble + '</head>' + src.slice(at)
  }

  // A bare fragment, which is the common and preferred case.
  return `<!doctype html><html><head>${preamble}</head><body>${src}</body></html>`
}

/** Messages the bridge is allowed to send. Anything else from the frame is
 *  ignored by the host rather than dispatched. */
export type BridgeMessage =
  | { type: 'state'; payload: Record<string, unknown> }
  | { type: 'title'; payload: string }
  | { type: 'height'; payload: number }
  | { type: 'natural-height'; payload: number }
  | { type: 'error'; payload: string }
  | { type: 'ready'; payload: unknown }
  // An action the widget is ASKING for. Carrying the request id so the host can
  // answer the exact call that made it; the action itself is deliberately left
  // unknown here and judged by customWidgetActions.
  | { type: 'act'; payload: { id: string; action: unknown } }

/** Validate a message arriving from the sandboxed frame.
 *
 *  The frame is untrusted, so shape is checked before anything acts on it: an
 *  unexpected type, a height that is not a number, a state that is an array
 *  rather than an object, all return null and are dropped. */
export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.__plexi !== 1) return null
  const type = d.type
  const payload = d.payload

  switch (type) {
    case 'state':
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
      return { type: 'state', payload: payload as Record<string, unknown> }
    case 'title':
      if (typeof payload !== 'string' || !payload.trim()) return null
      return { type: 'title', payload: payload.slice(0, 120) }
    case 'height':
    case 'natural-height': {
      const n = Number(payload)
      if (!Number.isFinite(n) || n <= 0) return null
      return { type, payload: Math.min(Math.round(n), 4000) }
    }
    case 'error':
      if (typeof payload !== 'string') return null
      return { type: 'error', payload: payload.slice(0, 500) }
    case 'ready':
      return { type: 'ready', payload }
    case 'act': {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
      const p = payload as Record<string, unknown>
      // An id is required: without one the host has nowhere to send the answer
      // and the widget's await would hang.
      if (typeof p.id !== 'string' || !p.id || p.id.length > 64) return null
      return { type: 'act', payload: { id: p.id, action: p.action } }
    }
    default:
      return null
  }
}
