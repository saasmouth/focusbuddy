// The deterministic action bridge (A6/B1, R27/R29). Every way the agent
// runtime can touch a page funnels through ONE door — performAgentAction —
// so the kill switch, the step ceiling, and the R29 bans hold over BOTH
// acting paths (the DOM-driver and the screenshot/coordinates fallback).
// Nothing here calls a model: the bridge is deterministic on purpose, so a
// fake-site probe can prove every rule without an API key, and B2's loop
// can trust that a banned action is refused in CODE, not merely discouraged
// in a prompt.
//
// R29, enforced here and not negotiable by any caller:
//   - credential fields are the human's: typing into a password field, or
//     clicking the submit of a form that contains one, refuses with a typed
//     reason the loop turns into "pause and ask".
//   - payment never commits: typing into a card field, or clicking the
//     submit of a form that carries payment fields, refuses.
//   - no file transfer: file inputs refuse clicks; downloads started while
//     a run drives the webContents are cancelled at the session.
//   - no CAPTCHA: anything inside a captcha container refuses; there is no
//     solve primitive to begin with (a ban by omission).
//   - no windows outside the panel: main's window-open handler consults
//     isAgentDrivenWc and denies popups for a driven webContents.
// The coordinate path CANNOT bypass any of this: click_at hit-tests the
// page at (x, y) and runs the SAME refusal rules on whatever is there.

import { webContents } from 'electron'
import { randomUUID } from 'crypto'

// ── The kill switch (built first, per the B1 ruling) ─────────────────────

export interface AgentRun {
  id: string
  wcId: number
  aborted: boolean
  steps: number
  downloadsCancelled: number
}

// Bridge-level hard ceiling — defence in depth under B2's tighter round
// budget (every observe step counts here too, so this sits well above
// MODEL_ROUND_BUDGET x steps-per-round). A runaway loop dies here even if
// its own accounting is wrong.
export const HARD_STEP_CEILING = 120

// Longest a single wait action may hold, in ms. The loop waits in small
// slices so Stop lands within ~100ms regardless of the requested wait.
export const WAIT_CAP_MS = 5000

const runs = new Map<string, AgentRun>()
// Sessions that already carry the download guard (one listener per session,
// consulted per-download against the live run set).
const guardedSessions = new WeakSet<Electron.Session>()

export function createAgentRun(wcId: number): AgentRun {
  const run: AgentRun = { id: randomUUID(), wcId, aborted: false, steps: 0, downloadsCancelled: 0 }
  runs.set(run.id, run)
  const wc = liveWc(wcId)
  if (wc) guardDownloads(wc.session)
  return run
}

export function stopAgentRun(runId: string): boolean {
  const run = runs.get(runId)
  if (!run) return false
  run.aborted = true
  return true
}

export function endAgentRun(runId: string): void {
  runs.delete(runId)
}

export function getAgentRun(runId: string): AgentRun | null {
  return runs.get(runId) ?? null
}

// Is this webContents currently driven by a live, un-aborted run? Main's
// popup handler and the download guard ask this.
export function isAgentDrivenWc(wcId: number): boolean {
  for (const run of runs.values()) {
    if (run.wcId === wcId && !run.aborted) return true
  }
  return false
}

function guardDownloads(ses: Electron.Session): void {
  if (guardedSessions.has(ses)) return
  guardedSessions.add(ses)
  ses.on('will-download', (event, _item, wc) => {
    if (!wc || !isAgentDrivenWc(wc.id)) return
    event.preventDefault()
    for (const run of runs.values()) {
      if (run.wcId === wc.id && !run.aborted) run.downloadsCancelled++
    }
  })
}

// ── The action vocabulary (R29) ──────────────────────────────────────────

export type AgentAction =
  | { kind: 'open_url'; url: string }
  | { kind: 'read_page'; selector?: string }
  // Harvest the page's links or images as a list. Reading the page text tells
  // the model what a page SAYS; this tells it what the page POINTS AT, which
  // is what "collect the links" and "gather the images" actually need. Images
  // in particular were invisible before: the element walker only reports
  // things you can act on, and an <img> is not one of them.
  | { kind: 'collect'; what: 'links' | 'images' }
  | { kind: 'snapshot' }
  | { kind: 'click'; elementIndex: number }
  | { kind: 'type'; elementIndex: number; text: string; replace?: boolean }
  | { kind: 'select'; elementIndex: number; value: string }
  | { kind: 'scroll'; dy: number }
  | { kind: 'wait'; ms: number }
  // The screenshot path (R27's fallback): same door, same rules.
  | { kind: 'screenshot' }
  | { kind: 'click_at'; x: number; y: number }
  | { kind: 'type_text'; text: string }
  | { kind: 'press_key'; key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' }

export type RefusalReason =
  | 'run_unknown'
  | 'run_stopped'
  | 'step_ceiling'
  | 'browser_gone'
  | 'element_gone'
  | 'credential_field'
  | 'credential_submit'
  | 'payment_field'
  | 'payment_submit'
  | 'file_transfer'
  | 'captcha'
  | 'bad_input'

export interface ActionResult {
  ok: boolean
  refused?: RefusalReason
  detail?: string
  pageUrl?: string
  // read_page / extract text, snapshot elements, screenshot image.
  text?: string
  // read_page windowing (AI-42): which slice of the page's full text this
  // is, so the loop can tell the model honestly how much it has seen and
  // that scrolling advances the window.
  textStart?: number
  textTotal?: number
  elements?: PageElement[]
  collected?: CollectedItem[]
  // How many the page actually had, when more were found than the cap allows.
  collectedTotal?: number
  captchaPresent?: boolean
  image?: { base64Png: string; width: number; height: number }
}

// One harvested link or image. Deliberately flat and small: these are fed
// back to the model as text, so every field costs tokens on every round that
// carries them.
export interface CollectedItem {
  /** Absolute URL. Relative hrefs are resolved in the page, where they mean something. */
  url: string
  /** A link's visible text, or an image's alt text. May be empty — honestly so. */
  text: string
  /** Natural pixel size, images only. Lets the model tell a hero shot from an icon. */
  w?: number
  h?: number
}

// One harvest may return this many items. A long page has thousands of links;
// unbounded, a single collect would blow the round's whole context.
export const MAX_COLLECTED = 60

// Images below this on their long edge are icons, spacers and tracking pixels,
// not content. Collecting them buries the real pictures in noise.
const MIN_IMAGE_EDGE = 64

// What the in-page walker reports about one interactive element. The ban
// classification (below) runs on THIS record main-side, so it is pure and
// unit-testable; the walker only gathers facts.
export interface PageElement {
  idx: number
  tag: string
  type: string
  role: string
  label: string
  value: string
  href: string
  bounds: { x: number; y: number; w: number; h: number }
  disabled: boolean
  editable: boolean
  isPassword: boolean
  isPayment: boolean
  isFileInput: boolean
  isSubmit: boolean
  inCaptcha: boolean
  formHasPassword: boolean
  formHasPayment: boolean
  options?: string[]
}

// ── The R29 refusal rules (pure — unit-locked) ───────────────────────────

// Decide whether acting on this element is banned, regardless of which path
// (index or coordinates) found it. Reading is never banned; committing is.
export function refusalFor(
  action: 'click' | 'type' | 'select',
  el: Pick<
    PageElement,
    | 'isPassword'
    | 'isPayment'
    | 'isFileInput'
    | 'isSubmit'
    | 'inCaptcha'
    | 'formHasPassword'
    | 'formHasPayment'
  >
): RefusalReason | null {
  if (el.inCaptcha) return 'captcha'
  if (action === 'type') {
    if (el.isPassword) return 'credential_field'
    if (el.isPayment) return 'payment_field'
  }
  if (action === 'click') {
    if (el.isFileInput) return 'file_transfer'
    if (el.isSubmit && el.formHasPassword) return 'credential_submit'
    if (el.isSubmit && el.formHasPayment) return 'payment_submit'
  }
  return null
}

// ── The in-page walker ───────────────────────────────────────────────────
// One library string shared by snapshot, resolve, and hit-test, so the
// three ways of finding an element can never disagree about what it is.
// Elements are tagged with data-fba indices at snapshot time; resolve
// re-measures and re-describes FRESH, because the page may have changed —
// the ban check always runs on what is there NOW, not what was there when
// the model last looked.

const IN_PAGE_LIB = `
  var FBA_SEL = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable="true"],[onclick]';
  var FBA_PAY = /(^|[-_ ])(cc|card)[-_ ]?(number|num|no|name)|cvc|cvv|expir|security[-_ ]?code/i;
  var FBA_CAPTCHA = /captcha|turnstile/i;
  function fbaText(el, attr) { return (el.getAttribute && el.getAttribute(attr)) || ''; }
  function fbaVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }
  function fbaIsPay(el) {
    var ac = fbaText(el, 'autocomplete').toLowerCase();
    if (ac.indexOf('cc-') === 0) return true;
    return FBA_PAY.test((el.name || '') + ' ' + (el.id || '') + ' ' + fbaText(el, 'placeholder'));
  }
  function fbaInCaptcha(el) {
    var n = el;
    while (n && n !== document.body) {
      if (FBA_CAPTCHA.test((n.className || '') + ' ' + (n.id || ''))) return true;
      n = n.parentElement;
    }
    return false;
  }
  function fbaLabel(el) {
    var lab = fbaText(el, 'aria-label') || fbaText(el, 'placeholder');
    if (!lab && el.labels && el.labels.length) lab = el.labels[0].innerText || '';
    if (!lab) lab = (el.innerText || '').trim();
    if (!lab) lab = fbaText(el, 'title') || fbaText(el, 'alt') || el.name || '';
    return lab.replace(/\\s+/g, ' ').slice(0, 80);
  }
  function fbaForm(el) {
    var form = el.form || (el.closest ? el.closest('form') : null);
    var hasPw = false, hasPay = false;
    if (form) {
      var fields = form.querySelectorAll('input,select,textarea');
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].type === 'password') hasPw = true;
        if (fbaIsPay(fields[i])) hasPay = true;
      }
    }
    return { form: form, hasPw: hasPw, hasPay: hasPay };
  }
  function fbaDescribe(el) {
    var r = el.getBoundingClientRect();
    var tag = el.tagName.toLowerCase();
    var type = (el.type || '').toLowerCase();
    var f = fbaForm(el);
    var isPw = type === 'password';
    var submit = false;
    if (f.form) {
      submit = type === 'submit' || type === 'image' ||
        (tag === 'button' && type !== 'button' && type !== 'reset');
    }
    var opts;
    if (tag === 'select') {
      opts = [];
      for (var i = 0; i < el.options.length && i < 20; i++) opts.push(el.options[i].value);
    }
    return {
      idx: parseInt(fbaText(el, 'data-fba') || '-1', 10),
      tag: tag,
      type: type,
      role: fbaText(el, 'role'),
      label: fbaLabel(el),
      value: isPw ? '' : String(el.value == null ? '' : el.value).slice(0, 120),
      href: tag === 'a' ? (el.href || '') : '',
      bounds: { x: r.x, y: r.y, w: r.width, h: r.height },
      disabled: !!el.disabled,
      editable: tag === 'input' || tag === 'textarea' || el.isContentEditable === true,
      isPassword: isPw,
      isPayment: fbaIsPay(el),
      isFileInput: type === 'file',
      isSubmit: submit,
      inCaptcha: fbaInCaptcha(el),
      formHasPassword: f.hasPw,
      formHasPayment: f.hasPay,
      options: opts
    };
  }
`


// The harvest script. Pure string-building so it unit-tests without a browser:
// the ways this goes wrong (relative URLs left unresolved, tracking pixels
// drowning the real images, an unbounded list) are all visible in the source.
export function collectJs(what: 'links' | 'images', cap = MAX_COLLECTED): string {
  const common = `
    var out = [], seen = Object.create(null), total = 0;
    var abs = function (u) {
      // Resolved against the page, which is the only place a relative URL
      // means anything. Anything unresolvable is dropped rather than guessed.
      try { return new URL(u, document.baseURI).href } catch (e) { return '' }
    };`
  if (what === 'links') {
    return `(() => {${common}
      var as = document.querySelectorAll('a[href]');
      for (var i = 0; i < as.length; i++) {
        var rawHref = (as[i].getAttribute('href') || '').trim();
        // A same-page anchor resolves to a perfectly good absolute URL, so the
        // scheme test below would wave it through as a destination.
        if (!rawHref || rawHref.charAt(0) === '#') continue;
        var href = abs(rawHref);
        // In-page anchors and script hrefs are navigation, not destinations.
        if (!href || !/^https?:/i.test(href)) continue;
        if (seen[href]) continue;
        seen[href] = 1; total++;
        if (out.length < ${cap}) {
          out.push({ url: href, text: (as[i].innerText || as[i].textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) });
        }
      }
      return { items: out, total: total };
    })()`
  }
  return `(() => {${common}
    var push = function (src, alt, w, h) {
      var u = abs(src);
      if (!u || !/^https?:|^data:image\\//i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1; total++;
      if (out.length < ${cap}) out.push({ url: u, text: (alt || '').replace(/\\s+/g, ' ').trim().slice(0, 160), w: w, h: h });
    };
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      var w = im.naturalWidth || im.width || 0, h = im.naturalHeight || im.height || 0;
      // Icons, spacers and tracking pixels are not what anyone means by "the
      // images on this page". A picture that has not loaded reports 0x0, so
      // an unknown size is kept rather than assumed tiny.
      if (w && h && Math.max(w, h) < ${MIN_IMAGE_EDGE}) continue;
      push(im.getAttribute('src') || im.currentSrc || '', im.getAttribute('alt') || '', w, h);
    }
    return { items: out, total: total };
  })()`
}

const SNAPSHOT_JS = `(() => {${IN_PAGE_LIB}
  var els = Array.prototype.slice.call(document.querySelectorAll(FBA_SEL)).filter(fbaVisible).slice(0, 120);
  for (var i = 0; i < els.length; i++) els[i].setAttribute('data-fba', String(i));
  var captcha = FBA_CAPTCHA.test(document.body ? document.body.innerHTML.slice(0, 200000) : '');
  return { url: location.href, captchaPresent: captcha, elements: els.map(fbaDescribe) };
})()`

function resolveJs(idx: number, scrollTo: boolean): string {
  return `(() => {${IN_PAGE_LIB}
  var el = document.querySelector('[data-fba="${idx}"]');
  if (!el) return null;
  ${scrollTo ? "el.scrollIntoView({ block: 'center', inline: 'center' });" : ''}
  return fbaDescribe(el);
})()`
}

// The visible-run flash (B3): a brief ring on the element about to be
// acted on, so the human can follow the run with their eyes. Purely
// decorative in-page animation; failures are ignored.
function flashJs(idx: number): string {
  return `(() => {
  var el = document.querySelector('[data-fba="${idx}"]');
  if (el && el.animate) el.animate(
    [{ boxShadow: '0 0 0 3px rgba(124,108,255,0.9)' }, { boxShadow: '0 0 0 6px rgba(124,108,255,0)' }],
    { duration: 600, easing: 'ease-out' }
  );
})()`
}

function flashAtJs(x: number, y: number): string {
  return `(() => {
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:${x - 12}px;top:${y - 12}px;width:24px;height:24px;border-radius:50%;border:3px solid rgba(124,108,255,0.9);pointer-events:none;z-index:2147483647';
  document.body.appendChild(d);
  if (d.animate) d.animate([{ opacity: 1, transform: 'scale(0.7)' }, { opacity: 0, transform: 'scale(1.4)' }], { duration: 600, easing: 'ease-out' });
  setTimeout(function () { d.remove(); }, 620);
})()`
}

function hitTestJs(x: number, y: number): string {
  return `(() => {${IN_PAGE_LIB}
  var el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  var hit = el.closest ? el.closest(FBA_SEL) : null;
  return fbaDescribe(hit || el);
})()`
}

// ── Executing against the live webContents ───────────────────────────────

function liveWc(wcId: number): Electron.WebContents | null {
  const wc = webContents.fromId(wcId)
  return wc && !wc.isDestroyed() ? wc : null
}

async function runJs<T>(wc: Electron.WebContents, script: string): Promise<T | null> {
  try {
    return (await wc.executeJavaScript(script, true)) as T
  } catch {
    return null
  }
}

async function resolveFresh(
  wc: Electron.WebContents,
  idx: number
): Promise<PageElement | null> {
  const el = await runJs<PageElement | null>(wc, resolveJs(idx, true))
  if (!el) return null
  // scrollIntoView needs a beat to settle before re-measuring for the click.
  await new Promise((r) => setTimeout(r, 80))
  return runJs<PageElement | null>(wc, resolveJs(idx, false))
}

function centerOf(el: PageElement): { x: number; y: number } {
  return { x: Math.round(el.bounds.x + el.bounds.w / 2), y: Math.round(el.bounds.y + el.bounds.h / 2) }
}

// Input goes through the CDP debugger, not webContents.sendInputEvent: for
// <webview> guests sendInputEvent is unreliable (events silently miss), and
// Input.dispatchMouseEvent / insertText are the same trusted path Playwright
// itself drives pages with — isTrusted true, guest-viewport coordinates.
async function cdp(
  wc: Electron.WebContents,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  await wc.debugger.sendCommand(method, params)
}

async function trustedClick(wc: Electron.WebContents, x: number, y: number): Promise<void> {
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function trustedType(wc: Electron.WebContents, text: string): Promise<void> {
  await cdp(wc, 'Input.insertText', { text: text.slice(0, 2000) })
}

const PRESSABLE: Record<string, { keyCode: number; key: string; code: string }> = {
  Enter: { keyCode: 13, key: 'Enter', code: 'Enter' },
  Tab: { keyCode: 9, key: 'Tab', code: 'Tab' },
  Escape: { keyCode: 27, key: 'Escape', code: 'Escape' },
  Backspace: { keyCode: 8, key: 'Backspace', code: 'Backspace' }
}

async function trustedPress(
  wc: Electron.WebContents,
  k: { keyCode: number; key: string; code: string }
): Promise<void> {
  const base = {
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    key: k.key,
    code: k.code
  }
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  if (k.key === 'Enter') await cdp(wc, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base })
  await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// ── The single door ──────────────────────────────────────────────────────

export async function performAgentAction(runId: string, action: AgentAction): Promise<ActionResult> {
  const run = runs.get(runId)
  if (!run) return { ok: false, refused: 'run_unknown' }
  if (run.aborted) return { ok: false, refused: 'run_stopped' }
  if (run.steps >= HARD_STEP_CEILING) return { ok: false, refused: 'step_ceiling' }
  run.steps++

  const wc = liveWc(run.wcId)
  if (!wc) return { ok: false, refused: 'browser_gone' }
  const done = (r: Omit<ActionResult, 'pageUrl'>): ActionResult => ({ ...r, pageUrl: wc.getURL() })

  switch (action.kind) {
    case 'open_url': {
      let target = String(action.url ?? '').trim()
      if (!target) return done({ ok: false, refused: 'bad_input' })
      if (!/^https?:\/\//i.test(target)) target = `https://${target}`
      try {
        await wc.loadURL(target)
      } catch (e) {
        // did-navigate aborts (client redirects) still land the page; report
        // rather than fail hard so the loop can read what actually loaded.
        return done({ ok: true, detail: `navigation settled with: ${(e as Error).message}` })
      }
      await abortableWait(run, 800)
      return done({ ok: true })
    }

    case 'read_page': {
      // AI-42 (Caleb's B5 drive): the old read re-served the FIRST slice
      // of a long page every time — "truncated to the same excerpt every
      // time". The window now anchors to the scroll position, so a scroll
      // action genuinely advances what the next read sees; start/total
      // ride along so the loop can be honest about coverage.
      const sel = action.selector ? JSON.stringify(action.selector) : 'null'
      const r = await runJs<{ text: string; start: number; total: number } | null>(
        wc,
        `(() => {
          var root = ${sel} ? document.querySelector(${sel}) : document.body;
          if (!root) return { text: '', start: 0, total: 0 };
          var full = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
          var W = 9000;
          var maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
          var frac = Math.min(1, Math.max(0, window.scrollY / maxScroll));
          var start = ${sel} ? 0 : Math.round(frac * Math.max(0, full.length - W));
          return { text: full.slice(start, start + W), start: start, total: full.length };
        })()`
      )
      return done({
        ok: true,
        text: r?.text ?? '',
        textStart: r?.start ?? 0,
        textTotal: r?.total ?? 0
      })
    }

    case 'collect': {
      const what = action.what === 'images' ? 'images' : 'links'
      const r = await runJs<{ items: CollectedItem[]; total: number } | null>(wc, collectJs(what))
      if (!r) return done({ ok: false, refused: 'browser_gone', detail: 'collect failed' })
      const items = Array.isArray(r.items) ? r.items.slice(0, MAX_COLLECTED) : []
      return done({ ok: true, collected: items, collectedTotal: r.total ?? items.length })
    }

    case 'snapshot': {
      const snap = await runJs<{ url: string; captchaPresent: boolean; elements: PageElement[] }>(
        wc,
        SNAPSHOT_JS
      )
      if (!snap) return done({ ok: false, refused: 'browser_gone', detail: 'snapshot failed' })
      return done({ ok: true, elements: snap.elements, captchaPresent: snap.captchaPresent })
    }

    case 'click': {
      const el = await resolveFresh(wc, action.elementIndex)
      if (!el) return done({ ok: false, refused: 'element_gone' })
      const refused = refusalFor('click', el)
      if (refused) return done({ ok: false, refused, detail: el.label })
      const { x, y } = centerOf(el)
      await runJs(wc, flashJs(action.elementIndex))
      await trustedClick(wc, x, y)
      return done({ ok: true, detail: el.label })
    }

    case 'type': {
      const el = await resolveFresh(wc, action.elementIndex)
      if (!el) return done({ ok: false, refused: 'element_gone' })
      if (!el.editable) return done({ ok: false, refused: 'bad_input', detail: 'not editable' })
      const refused = refusalFor('type', el)
      if (refused) return done({ ok: false, refused, detail: el.label })
      await runJs(wc, flashJs(action.elementIndex))
      await runJs(
        wc,
        `(() => { var el = document.querySelector('[data-fba="${action.elementIndex}"]'); if (el) { el.focus(); ${
          action.replace ? "if (el.select) el.select(); else if (el.isContentEditable) document.execCommand('selectAll');" : ''
        } } })()`
      )
      await trustedType(wc, action.text)
      return done({ ok: true, detail: el.label })
    }

    case 'select': {
      const el = await resolveFresh(wc, action.elementIndex)
      if (!el) return done({ ok: false, refused: 'element_gone' })
      if (el.tag !== 'select') return done({ ok: false, refused: 'bad_input', detail: 'not a select' })
      const refused = refusalFor('select', el)
      if (refused) return done({ ok: false, refused, detail: el.label })
      await runJs(wc, flashJs(action.elementIndex))
      const okSet = await runJs<boolean>(
        wc,
        `(() => {
          var el = document.querySelector('[data-fba="${action.elementIndex}"]');
          if (!el) return false;
          var v = ${JSON.stringify(action.value)};
          var found = false;
          for (var i = 0; i < el.options.length; i++) {
            if (el.options[i].value === v || el.options[i].label === v) { el.selectedIndex = i; found = true; break; }
          }
          if (found) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return found;
        })()`
      )
      return okSet
        ? done({ ok: true, detail: el.label })
        : done({ ok: false, refused: 'bad_input', detail: 'no such option' })
    }

    case 'scroll': {
      const dy = Math.max(-4000, Math.min(4000, Number(action.dy) || 0))
      await runJs(wc, `window.scrollBy({ top: ${dy}, behavior: 'instant' })`)
      return done({ ok: true })
    }

    case 'wait': {
      await abortableWait(run, Math.max(0, Math.min(WAIT_CAP_MS, Number(action.ms) || 0)))
      return run.aborted ? done({ ok: false, refused: 'run_stopped' }) : done({ ok: true })
    }

    case 'screenshot': {
      try {
        const img = await wc.capturePage()
        const size = img.getSize()
        return done({
          ok: true,
          image: { base64Png: img.toPNG().toString('base64'), width: size.width, height: size.height }
        })
      } catch (e) {
        return done({ ok: false, refused: 'browser_gone', detail: (e as Error).message })
      }
    }

    case 'click_at': {
      // The fallback path hit-tests before it clicks: whatever sits at
      // (x, y) faces the same rules an indexed click would.
      const x = Math.round(Number(action.x)),
        y = Math.round(Number(action.y))
      if (!Number.isFinite(x) || !Number.isFinite(y)) return done({ ok: false, refused: 'bad_input' })
      const el = await runJs<PageElement | null>(wc, hitTestJs(x, y))
      if (el) {
        const refused = refusalFor('click', el)
        if (refused) return done({ ok: false, refused, detail: el.label })
      }
      await runJs(wc, flashAtJs(x, y))
      await trustedClick(wc, x, y)
      return done({ ok: true, detail: el?.label })
    }

    case 'type_text': {
      // Types into whatever holds focus — so classify the focused element
      // first; a password or card field refuses exactly like the DOM path.
      const el = await runJs<PageElement | null>(
        wc,
        `(() => {${IN_PAGE_LIB}
          var el = document.activeElement;
          if (!el || el === document.body) return null;
          return fbaDescribe(el);
        })()`
      )
      if (el) {
        const refused = refusalFor('type', el)
        if (refused) return done({ ok: false, refused, detail: el.label })
      }
      await trustedType(wc, action.text)
      return done({ ok: true })
    }

    case 'press_key': {
      const code = PRESSABLE[action.key]
      if (!code) return done({ ok: false, refused: 'bad_input' })
      // Enter can submit the focused form — run the same commit rules the
      // click path runs on a submit button before letting it through.
      if (action.key === 'Enter') {
        const el = await runJs<PageElement | null>(
          wc,
          `(() => {${IN_PAGE_LIB}
            var el = document.activeElement;
            if (!el || el === document.body) return null;
            return fbaDescribe(el);
          })()`
        )
        if (el?.formHasPassword) return done({ ok: false, refused: 'credential_submit', detail: el.label })
        if (el?.formHasPayment) return done({ ok: false, refused: 'payment_submit', detail: el.label })
      }
      await trustedPress(wc, code)
      return done({ ok: true })
    }
  }
}

// Wait in slices so a Stop lands within ~100ms of the click, never after
// the full requested delay.
async function abortableWait(run: AgentRun, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end && !run.aborted) {
    await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())))
  }
}
