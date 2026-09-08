import { createRoot } from 'react-dom/client'
import type { Widget } from '@shared/types'
import { renderWidget } from '../components/widgets/renderWidget'
import { WidgetSurfaceContext } from './widgetSurface'

// Capturing a widget's own markup, for the kinds the projection has no
// structural renderer for.
//
// The widget is rendered off-screen through the same dispatcher the desk and
// the dashboard use, then serialised. Rendering it here rather than reading it
// off the canvas matters: publishing must not depend on the desk being open,
// and that is a bug this feature already had once.
//
// Two things make the output safe to publish. Styles are inlined from a curated
// property list, so the markup carries its own appearance and the public page
// never needs the app's stylesheet -- inlining everything computed costs about
// 9KB per element, which is why this list is short. And the result goes through
// the same sanitiser the editor trusts, after which the server checks again.


/** Structural tags a widget is built from. Anything else is unwrapped. */
const CAPTURE_TAGS = new Set([
  'div', 'span', 'p', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'code', 'pre', 'blockquote',
  'sub', 'sup', 'mark', 'img', 'figure', 'figcaption',
  // Vector content. `foreignObject` is excluded on purpose -- it can carry
  // arbitrary HTML back in through the side door.
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'use', 'symbol', 'title', 'linearGradient', 'radialGradient', 'stop'
])

/** Attributes an SVG element needs to draw, none of which can execute. */
const SVG_ATTRS = new Set([
  'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'points', 'transform', 'opacity', 'fill-rule',
  'clip-rule', 'offset', 'stop-color', 'gradientUnits', 'text-anchor', 'font-size'
])

/**
 * Sanitise captured widget markup.
 *
 * The editor's sanitiser is built for document HTML: its allowlist is
 * paragraphs and tables, so it unwrapped every div and a calculator's keypad
 * arrived as the string "789456123". Widget markup needs structure preserved
 * and everything executable removed, which is a different job.
 *
 * Only `style` survives, and only the properties we inlined. No classes, no
 * ids, no data attributes, no handlers, no javascript:/data: URLs.
 */
export function sanitizeCapturedHtml(root: HTMLElement): string {
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) walk(child)
    const tag = el.tagName.toLowerCase()
    for (const a of Array.from(el.attributes)) {
      const keep =
        SVG_ATTRS.has(a.name) ||
        // `class` is what makes the app's own stylesheet apply in the viewer's
        // shadow root; `style` carries the runtime values CSS cannot know.
        a.name === 'class' ||
        a.name === 'style' ||
        (tag === 'img' && (a.name === 'src' || a.name === 'alt'))
      if (!keep) el.removeAttribute(a.name)
    }
    if (tag === 'use') {
      const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? ''
      if (!href.startsWith('#')) el.remove()
      return
    }
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? ''
      // A local file reference is dead in a browser and a remote one would
      // phone home from the reader's machine; neither belongs in a capture.
      if (!/^data:image\//i.test(src)) el.remove()
      return
    }
    if (!CAPTURE_TAGS.has(tag)) {
      // Unknown element: keep what it said, drop the element itself.
      el.replaceWith(...Array.from(el.childNodes))
    }
  }
  for (const child of Array.from(root.children)) walk(child)
  return root.innerHTML
}


/**
 * Elements that must never appear in published markup: executable, or a window
 * onto something the public has no business seeing.
 */
const STRIP_SELECTOR = 'script,style,link,iframe,webview,object,embed,canvas,video,audio'

/**
 * Controls are not stripped, they are defused. A calculator's keypad and a
 * Stream Deck's grid ARE the widget; deleting them published a calculator with
 * no keys and a deck with no buttons. Each becomes a plain element carrying the
 * same text and appearance, so it looks right and does nothing.
 */
const CONTROL_SELECTOR = 'button,input,textarea,select,a,form,label'

function defuseControls(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR))) {
    const plain = document.createElement('div')
    for (const a of Array.from(el.attributes)) {
      // A defused control keeps how it looked, which now means its classes.
      if (a.name === 'class' || a.name === 'style') plain.setAttribute(a.name, a.value)
    }
    // An input shows its value; everything else keeps its children.
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      plain.textContent = el.value || el.placeholder || ''
    } else if (el instanceof HTMLSelectElement) {
      plain.textContent = el.selectedOptions[0]?.textContent ?? ''
    } else {
      while (el.firstChild) plain.appendChild(el.firstChild)
    }
    el.replaceWith(plain)
  }
}

const MAX_CAPTURE_BYTES = 512 * 1024
/**
 * Above this many elements a widget is left to its structural render. A
 * thousand-row table is not a likeness worth minutes of the renderer's time,
 * and the list view shows its contents properly anyway.
 */
const MAX_CAPTURE_ELEMENTS = 1500
/**
 * Rendering is asynchronous; give effects time to put content on screen. Too
 * short and a widget is photographed mid-load, showing the empty state it
 * offers before its content arrives -- a markdown note captured as "Set up
 * with AI" rather than as what the owner wrote.
 */
const SETTLE_MS = 1200

/**
 * Render one widget off-screen and return its sanitised markup, or null when it
 * produced nothing worth publishing. Never throws into a publish.
 */
export async function captureWidgetHtml(widget: Widget): Promise<string | null> {
  // What the widget is known to say, for kinds whose content is plain prose.
  // A capture that does not contain it photographed an empty state, and the
  // structural render is a better likeness than an empty box.
  // Only kinds whose content IS the prose on screen. A scratchpad holds pen
  // strokes, so looking for its content in the rendered text can never succeed.
  const expected = ['sticky', 'note', 'markdown'].includes(widget.kind)
    ? (widget.content || '').trim().slice(0, 24)
    : ''
  const host = document.createElement('div')
  // Off-screen rather than display:none, so layout still resolves and the
  // computed styles we inline are the real ones.
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${Math.max(120, widget.width)}px;height:${Math.max(80, widget.height)}px;pointer-events:none;`
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    root.render(
      <WidgetSurfaceContext.Provider value="embedded">{renderWidget(widget)}</WidgetSurfaceContext.Provider>
    )
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    // Remove anything executable or session-bearing before serialising, so the
    // sanitiser is a second line of defence rather than the only one.
    for (const el of Array.from(host.querySelectorAll(STRIP_SELECTOR))) el.remove()
    // The frame's own header is chrome, not content: it published the widget's
    // title followed by "edit push_pin remove open_in_full close".
    for (const el of Array.from(host.querySelectorAll('.widget-handle'))) el.remove()
    // Icon glyphs go too. The viewer carries the app's stylesheet but not its
    // 3.9MB Material Symbols font, and a ligature without its font renders as
    // the literal word -- a deck button reading "play_pause", a toolbar reading
    // "rectangle Rect". The text label beside each icon says the same thing.
    //
    // Selected by class rather than computed font-family: asking for the
    // computed style of every element forces a style recalculation per element,
    // and across a whole desk of widgets that was enough to lock the renderer
    // up and stop publishing entirely.
    for (const el of Array.from(host.querySelectorAll('[class*="material-symbols"],[class*="material-icons"]'))) {
      el.remove()
    }
    defuseControls(host)

    // Nothing visible is not worth a card; the placeholder says more.
    if (!host.innerText.trim() && !host.querySelector('img')) return null
    if (host.querySelectorAll('*').length > MAX_CAPTURE_ELEMENTS) return null
    if (expected && !host.innerText.includes(expected)) return null
    const clean = sanitizeCapturedHtml(host)
    if (!clean || clean.length > MAX_CAPTURE_BYTES) return null
    return clean
  } catch {
    return null
  } finally {
    try {
      root.unmount()
    } catch {
      /* already gone */
    }
    host.remove()
  }
}
