// Low-fidelity wireframe / UI mock-up elements. Chrome (title bars, dots, grips,
// placeholder text lines) is drawn as inner parts scaled from the box so mocks
// stay crisp at any size. Ids are saved in documents — never rename.

import { type ShapeDef, ellipse, line, poly, r, rect, star } from './types'
import {
  P,
  PORTS_THIRDS,
  bounds,
  box,
  circle,
  ellipseRev,
  fill,
  fit,
  none,
  pad,
  pathShape,
  shade,
  shape,
  solid,
  stroke,
  wedge
} from './kit'

const W = 'Wireframe' as const
const ACCENT = '#2563EB'

const lines = (segs: string[]): string => segs.filter(Boolean).join(' ')
const chevronDown = (cx: number, cy: number, s: number): string =>
  `M${P(cx - s, cy - s / 2)} L${P(cx, cy + s / 2)} L${P(cx + s, cy - s / 2)}`
const chevronRight = (cx: number, cy: number, s: number): string =>
  `M${P(cx - s / 2, cy - s)} L${P(cx + s / 2, cy)} L${P(cx - s / 2, cy + s)}`
const xMark = (cx: number, cy: number, s: number): string =>
  `${line(cx - s, cy - s, cx + s, cy + s)} ${line(cx + s, cy - s, cx - s, cy + s)}`

// Placeholder text lines inside a rect.
function textLines(x: number, y: number, w: number, h: number, n: number, lastFrac = 0.6): string {
  const out: string[] = []
  if (n <= 0 || w <= 0 || h <= 0) return line(x, y, x, y)
  const gap = h / n
  for (let i = 0; i < n; i++) {
    const yy = y + gap * (i + 0.5)
    out.push(line(x, yy, x + (i === n - 1 ? w * lastFrac : w), yy))
  }
  return out.join(' ')
}

// Labelled control: a small widget on the left, label to the right.
function labelled(
  id: string,
  label: string,
  widget: (s: number, h: number) => { parts: ReturnType<typeof fill>[]; ww: number },
  keywords: string[],
  defaultLabel: string,
  w = 140,
  h = 24
): ShapeDef {
  return shape(
    id,
    label,
    W,
    w,
    h,
    (Wd, Hd) => {
      const s = Math.min(Hd, Wd * 0.3)
      const wg = widget(s, Hd)
      return { parts: [none(bounds(Wd, Hd)), ...wg.parts], text: box(Wd, Hd, wg.ww + 6, 0, Wd - wg.ww - 6, Hd) }
    },
    {
      keywords: ['wireframe', 'ui', 'form', 'control', ...keywords],
      outline: bounds,
      defaultLabel,
      defaultStyle: { textAlign: 'left' },
      minH: 12
    }
  )
}

const UI = (...k: string[]): string[] => ['wireframe', 'ui', 'mockup', ...k]

export const WIREFRAME_SHAPES: ShapeDef[] = [
  // ── frames ────────────────────────────────────────────────────────────────
  shape(
    'wf-browser',
    'Browser window',
    W,
    640,
    420,
    (w, h) => {
      const hb = Math.min(32, h * 0.2)
      const dr = Math.min(hb * 0.16, w * 0.02)
      const dy = hb / 2
      const ax = Math.min(w * 0.2, dr * 12)
      return {
        parts: [
          fill(rect(0, 0, w, h, Math.min(8, w * 0.04, h * 0.04))),
          stroke(line(0, hb, w, hb)),
          shade(`${circle(dr * 3, dy, dr)} ${circle(dr * 6, dy, dr)} ${circle(dr * 9, dy, dr)}`),
          stroke(rect(ax, hb * 0.22, Math.max(0, w - ax - Math.min(16, w * 0.04)), hb * 0.56, hb * 0.28))
        ],
        text: box(w, h, ax + 6, hb * 0.22, w - ax - 24, hb * 0.56)
      }
    },
    {
      keywords: UI('browser', 'web page', 'website', 'chrome', 'window', 'url bar', 'address bar'),
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'https://example.com',
      defaultStyle: { textAlign: 'left', fontSize: 11 },
      minW: 60,
      minH: 40
    }
  ),
  shape(
    'wf-phone',
    'Mobile phone',
    W,
    200,
    400,
    (w, h) => {
      const k = Math.min(w, h) * 0.12
      const bz = Math.min(w, h) * 0.05
      const top = Math.max(bz, h * 0.07)
      return {
        parts: [
          fill(rect(0, 0, w, h, k)),
          stroke(rect(bz, top, w - 2 * bz, h - 2 * top, Math.max(0, k - bz))),
          stroke(`${line(w * 0.4, top / 2, w * 0.6, top / 2)} ${line(w * 0.38, h - top / 2, w * 0.62, h - top / 2)}`)
        ],
        text: box(w, h, bz, top, w - 2 * bz, h - 2 * top)
      }
    },
    { keywords: UI('phone', 'mobile', 'smartphone', 'app', 'device', 'screen'), container: true, ports: PORTS_THIRDS, minW: 30, minH: 50 }
  ),
  shape(
    'wf-tablet',
    'Tablet',
    W,
    420,
    320,
    (w, h) => {
      const k = Math.min(w, h) * 0.07
      const bz = Math.min(w, h) * 0.06
      return {
        parts: [fill(rect(0, 0, w, h, k)), stroke(rect(bz, bz, w - 2 * bz, h - 2 * bz, Math.max(0, k - bz))), stroke(circle(w - bz / 2, h / 2, bz * 0.2))],
        text: box(w, h, bz, bz, w - 2 * bz, h - 2 * bz)
      }
    },
    { keywords: UI('tablet', 'ipad', 'device', 'screen', 'landscape'), container: true, ports: PORTS_THIRDS, minW: 40, minH: 30 }
  ),
  shape(
    'wf-window',
    'Desktop window',
    W,
    520,
    340,
    (w, h) => {
      const hb = Math.min(28, h * 0.2)
      const s = hb * 0.18
      const bx = (i: number): number => w - hb * (0.6 + i * 0.8)
      return {
        parts: [
          fill(rect(0, 0, w, h, Math.min(6, w * 0.03, h * 0.03))),
          stroke(line(0, hb, w, hb)),
          stroke(`${xMark(bx(0), hb / 2, s)} ${rect(bx(1) - s, hb / 2 - s, 2 * s, 2 * s)} ${line(bx(2) - s, hb / 2 + s, bx(2) + s, hb / 2 + s)}`)
        ],
        text: box(w, h, 8, 0, w - hb * 2.6 - 8, hb)
      }
    },
    {
      keywords: UI('window', 'desktop', 'app', 'dialog', 'title bar'),
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'Window',
      defaultStyle: { textAlign: 'left' },
      minW: 60,
      minH: 30
    }
  ),
  shape(
    'wf-modal',
    'Modal dialog',
    W,
    380,
    240,
    (w, h) => {
      const hb = Math.min(40, h * 0.22)
      const bh = Math.min(30, h * 0.16)
      const bw = Math.min(80, w * 0.22)
      const g = Math.min(10, w * 0.03)
      return {
        parts: [
          fill(rect(0, 0, w, h, Math.min(10, w * 0.04, h * 0.04))),
          stroke(`${line(0, hb, w, hb)} ${xMark(w - hb / 2, hb / 2, hb * 0.15)}`),
          stroke(rect(w - 2 * bw - 2 * g, h - bh - g, bw, bh, 4)),
          solid(rect(w - bw - g, h - bh - g, bw, bh, 4))
        ],
        text: box(w, h, 12, 0, w - hb - 12, hb)
      }
    },
    {
      keywords: UI('modal', 'dialog', 'popup', 'lightbox', 'confirm', 'overlay'),
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'Dialog title',
      defaultStyle: { textAlign: 'left', bold: true },
      minW: 60,
      minH: 40
    }
  ),
  // ── controls ──────────────────────────────────────────────────────────────
  pathShape('wf-button', 'Button', W, 120, 40, (w, h) => rect(0, 0, w, h, Math.min(6, h / 2)), (w, h) => pad(w, h, 6, 2), {
    keywords: UI('button', 'cta', 'action', 'secondary', 'click'),
    defaultLabel: 'Button'
  }),
  pathShape('wf-button-primary', 'Primary button', W, 120, 40, (w, h) => rect(0, 0, w, h, Math.min(6, h / 2)), (w, h) => pad(w, h, 6, 2), {
    keywords: UI('button', 'primary', 'cta', 'submit', 'call to action'),
    defaultLabel: 'Submit',
    defaultStyle: { fill: ACCENT, stroke: ACCENT, textColor: '#FFFFFF', bold: true },
    color: ACCENT
  }),
  shape(
    'wf-icon-button',
    'Icon button',
    W,
    40,
    40,
    (w, h) => {
      const s = Math.min(w, h) * 0.22
      return {
        parts: [fill(ellipse(w / 2, h / 2, w / 2, h / 2)), stroke(`${line(w / 2 - s, h / 2, w / 2 + s, h / 2)} ${line(w / 2, h / 2 - s, w / 2, h / 2 + s)}`)],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('icon button', 'fab', 'floating action', 'round button', 'add'), aspectLocked: true }
  ),
  shape(
    'wf-input',
    'Text input',
    W,
    220,
    36,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, Math.min(4, h / 2)))], text: pad(w, h, 10, 2) }),
    {
      keywords: UI('input', 'text field', 'textbox', 'form', 'field', 'entry'),
      defaultLabel: 'Placeholder',
      defaultStyle: { textAlign: 'left', textColor: '#9CA3AF' }
    }
  ),
  shape(
    'wf-search',
    'Search box',
    W,
    240,
    36,
    (w, h) => {
      const s = Math.min(h * 0.22, w * 0.06)
      const cx = h * 0.5
      return {
        parts: [
          fill(rect(0, 0, w, h, h / 2)),
          stroke(`${circle(cx, h / 2 - s * 0.2, s)} ${line(cx + s * 0.7, h / 2 + s * 0.5, cx + s * 1.5, h / 2 + s * 1.3)}`)
        ],
        text: pad(w, h, cx + s * 2 + 4, 2, h / 2, 2)
      }
    },
    {
      keywords: UI('search', 'find', 'query', 'magnifier', 'lookup', 'input'),
      defaultLabel: 'Search…',
      defaultStyle: { textAlign: 'left', textColor: '#9CA3AF' }
    }
  ),
  shape(
    'wf-textarea',
    'Text area',
    W,
    240,
    110,
    (w, h) => {
      const g = Math.min(12, w * 0.1, h * 0.2)
      return {
        parts: [
          fill(rect(0, 0, w, h, Math.min(4, h / 4))),
          stroke(`${line(w - g, h - 2, w - 2, h - g)} ${line(w - g * 0.55, h - 2, w - 2, h - g * 0.55)}`)
        ],
        text: pad(w, h, 10, 8, 10, g)
      }
    },
    {
      keywords: UI('textarea', 'text area', 'multiline', 'comment box', 'message'),
      defaultLabel: 'Write something…',
      defaultStyle: { textAlign: 'left', vAlign: 'top', textColor: '#9CA3AF' }
    }
  ),
  labelled(
    'wf-checkbox',
    'Checkbox',
    (s, h) => {
      const y = (h - s) / 2
      return {
        parts: [fill(rect(0, y, s, s, s * 0.15)), stroke(`M${P(s * 0.22, y + s * 0.52)} L${P(s * 0.42, y + s * 0.72)} L${P(s * 0.78, y + s * 0.3)}`)],
        ww: s
      }
    },
    ['checkbox', 'tick', 'check', 'option', 'agree'],
    'Option'
  ),
  labelled(
    'wf-radio',
    'Radio button',
    (s, h) => ({ parts: [fill(circle(s / 2, h / 2, s / 2)), solid(circle(s / 2, h / 2, s * 0.22))], ww: s }),
    ['radio', 'option', 'choice', 'select one'],
    'Choice'
  ),
  labelled(
    'wf-toggle',
    'Toggle switch',
    (s, h) => {
      const tw = s * 1.8
      const y = (h - s) / 2
      return { parts: [fill(rect(0, y, tw, s, s / 2)), solid(circle(tw - s / 2, h / 2, s * 0.36))], ww: tw }
    },
    ['toggle', 'switch', 'on off', 'setting', 'enable'],
    'Setting',
    150,
    28
  ),
  shape(
    'wf-select',
    'Dropdown',
    W,
    200,
    36,
    (w, h) => {
      const bw = Math.min(h, w * 0.3)
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(4, h / 2))), stroke(`${line(w - bw, 0, w - bw, h)} ${chevronDown(w - bw / 2, h / 2, bw * 0.18)}`)],
        text: pad(w, h, 10, 2, bw + 4, 2)
      }
    },
    { keywords: UI('dropdown', 'select', 'combo box', 'picker', 'menu'), defaultLabel: 'Select…', defaultStyle: { textAlign: 'left' } }
  ),
  shape(
    'wf-dropdown-menu',
    'Open menu',
    W,
    180,
    160,
    (w, h) => {
      const n = 5
      const rows: string[] = []
      for (let i = 1; i < n; i++) rows.push(line(0, (h * i) / n, w, (h * i) / n))
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(6, w * 0.04, h * 0.04))), shade(rect(0, h / n, w, h / n)), stroke(rows.join(' '))],
        text: pad(w, h, 10, 0, 10, h - h / n)
      }
    },
    { keywords: UI('menu', 'context menu', 'dropdown list', 'options', 'popover'), defaultLabel: 'Menu item', defaultStyle: { textAlign: 'left' } }
  ),
  shape(
    'wf-slider',
    'Slider',
    W,
    200,
    24,
    (w, h) => {
      const rr = Math.min(h * 0.4, w * 0.1)
      const kx = Math.max(rr, Math.min(w - rr, w * 0.6))
      return {
        parts: [none(bounds(w, h)), stroke(line(0, h / 2, w, h / 2)), solid(rect(0, h / 2 - Math.min(2, h * 0.1), kx, Math.min(4, h * 0.2))), fill(circle(kx, h / 2, rr))],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('slider', 'range', 'volume', 'scrubber', 'knob'), outline: bounds, minH: 8 }
  ),
  shape(
    'wf-progress',
    'Progress bar',
    W,
    220,
    14,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, h / 2)), solid(rect(0, 0, w * 0.6, h, h / 2))], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: UI('progress', 'loading', 'bar', 'percent', 'completion'), minH: 4 }
  ),
  shape(
    'wf-spinner',
    'Loading spinner',
    W,
    40,
    40,
    (w, h) => ({
      parts: [
        none(bounds(w, h)),
        stroke(ellipse(w / 2, h / 2, w * 0.4, h * 0.4)),
        solid(`M${P(w / 2, h * 0.06)} A${r(w * 0.44)},${r(h * 0.44)} 0 0 1 ${P(w * 0.94, h / 2)} L${P(w * 0.86, h / 2)} A${r(w * 0.36)},${r(h * 0.36)} 0 0 0 ${P(w / 2, h * 0.14)} Z`)
      ],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: UI('spinner', 'loading', 'busy', 'wait', 'loader'), outline: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2), aspectLocked: true }
  ),
  pathShape('wf-badge', 'Badge', W, 56, 24, (w, h) => rect(0, 0, w, h, h / 2), (w, h) => pad(w, h, Math.min(8, w * 0.15), 1), {
    keywords: UI('badge', 'pill', 'tag', 'count', 'notification', 'label'),
    defaultLabel: 'New',
    defaultStyle: { fill: '#DC2626', stroke: '#DC2626', textColor: '#FFFFFF', fontSize: 11, bold: true },
    color: '#DC2626'
  }),
  shape(
    'wf-chip',
    'Chip',
    W,
    100,
    30,
    (w, h) => {
      const s = Math.min(h * 0.16, w * 0.06)
      return { parts: [fill(rect(0, 0, w, h, h / 2)), stroke(xMark(w - h / 2, h / 2, s))], text: pad(w, h, h / 2, 2, h, 2) }
    },
    { keywords: UI('chip', 'tag', 'filter', 'token', 'removable', 'pill'), defaultLabel: 'Filter' }
  ),
  // ── content ───────────────────────────────────────────────────────────────
  shape(
    'wf-image',
    'Image placeholder',
    W,
    200,
    140,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h)), stroke(`${line(0, 0, w, h)} ${line(w, 0, 0, h)}`)], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: UI('image', 'picture', 'photo', 'placeholder', 'media', 'graphic') }
  ),
  shape(
    'wf-avatar',
    'Avatar',
    W,
    48,
    48,
    (w, h) => ({
      parts: [
        fill(ellipse(w / 2, h / 2, w / 2, h / 2)),
        shade(
          `${ellipse(w / 2, h * 0.38, w * 0.17, h * 0.17)} M${P(w * 0.2, h * 0.84)} Q${P(w / 2, h * 0.5)} ${P(w * 0.8, h * 0.84)} Q${P(w / 2, h * 1)} ${P(w * 0.2, h * 0.84)} Z`
        )
      ],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: UI('avatar', 'profile', 'user', 'photo', 'account', 'person'), aspectLocked: true }
  ),
  shape(
    'wf-card',
    'Card',
    W,
    240,
    260,
    (w, h) => {
      const ih = h * 0.45
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(8, w * 0.05, h * 0.05))), stroke(`${line(0, ih, w, ih)} ${line(0, 0, w, ih)} ${line(w, 0, 0, ih)}`)],
        text: pad(w, h, 12, ih + 8, 12, 8)
      }
    },
    {
      keywords: UI('card', 'tile', 'product card', 'article', 'panel'),
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'Card title',
      defaultStyle: { textAlign: 'left', vAlign: 'top', bold: true },
      minW: 40,
      minH: 40
    }
  ),
  shape(
    'wf-alert',
    'Alert banner',
    W,
    360,
    52,
    (w, h) => {
      const bar = Math.min(5, w * 0.03)
      const rr = Math.min(h * 0.22, w * 0.05)
      const cx = bar + Math.min(8, w * 0.04) + rr
      return {
        parts: [
          fill(rect(0, 0, w, h, Math.min(6, h * 0.2))),
          shade(rect(0, 0, bar, h)),
          stroke(`${circle(cx, h / 2, rr)} ${line(cx, h / 2 - rr * 0.1, cx, h / 2 + rr * 0.5)} ${line(cx, h / 2 - rr * 0.5, cx, h / 2 - rr * 0.35)}`)
        ],
        text: pad(w, h, cx + rr + 8, 2, 8, 2)
      }
    },
    {
      keywords: UI('alert', 'banner', 'notice', 'warning', 'info', 'toast', 'message'),
      defaultLabel: 'Heads up: something happened.',
      defaultStyle: { textAlign: 'left', fill: '#FEF3C7' },
      color: '#D97706'
    }
  ),
  pathShape(
    'wf-tooltip',
    'Tooltip',
    W,
    150,
    48,
    (w, h) => {
      const bh = h * 0.78
      const k = Math.min(6, bh / 2, w / 4)
      const t = Math.min(8, w * 0.08)
      return (
        `M${r(k)},0 H${r(w - k)} A${r(k)},${r(k)} 0 0 1 ${r(w)},${r(k)} V${r(bh - k)} A${r(k)},${r(k)} 0 0 1 ${P(w - k, bh)} ` +
        `H${r(w / 2 + t)} L${P(w / 2, h)} L${P(w / 2 - t, bh)} H${r(k)} A${r(k)},${r(k)} 0 0 1 0,${r(bh - k)} V${r(k)} A${r(k)},${r(k)} 0 0 1 ${r(k)},0 Z`
      )
    },
    (w, h) => pad(w, h, 8, 2, 8, h * 0.22 + 2),
    {
      keywords: UI('tooltip', 'hint', 'popover', 'help', 'hover'),
      defaultLabel: 'Tooltip',
      defaultStyle: { fill: '#111827', stroke: '#111827', textColor: '#FFFFFF', fontSize: 11 }
    }
  ),
  shape(
    'wf-heading',
    'Heading',
    W,
    240,
    40,
    (w, h) => ({ parts: [none(bounds(w, h))], text: box(w, h, 0, 0, w, h) }),
    {
      keywords: UI('heading', 'title', 'h1', 'headline', 'text'),
      special: 'text',
      outline: bounds,
      defaultLabel: 'Heading',
      defaultStyle: { bold: true, fontSize: 24, textAlign: 'left' }
    }
  ),
  shape(
    'wf-paragraph',
    'Paragraph lines',
    W,
    240,
    90,
    (w, h) => ({ parts: [none(bounds(w, h)), stroke(textLines(0, 0, w, h, 5, 0.55))], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: UI('paragraph', 'text', 'lorem ipsum', 'body copy', 'lines', 'placeholder text'), outline: bounds }
  ),
  shape(
    'wf-link',
    'Link',
    W,
    120,
    24,
    (w, h) => ({ parts: [none(bounds(w, h))], text: box(w, h, 0, 0, w, h) }),
    {
      keywords: UI('link', 'hyperlink', 'anchor', 'url', 'text'),
      special: 'text',
      outline: bounds,
      defaultLabel: 'Link text',
      defaultStyle: { underline: true, textColor: ACCENT, textAlign: 'left' }
    }
  ),
  shape(
    'wf-list',
    'List',
    W,
    240,
    160,
    (w, h) => {
      const n = 4
      const rh = h / n
      const dots: string[] = []
      const seps: string[] = []
      const rr = Math.min(rh * 0.12, w * 0.03)
      for (let i = 0; i < n; i++) {
        const cy = rh * (i + 0.5)
        dots.push(circle(rr * 3, cy, rr))
        seps.push(line(rr * 6, cy, w - Math.min(16, w * 0.1), cy))
        if (i > 0) seps.push(line(0, rh * i, w, rh * i))
      }
      return { parts: [fill(rect(0, 0, w, h, Math.min(6, w * 0.03, h * 0.03))), solid(dots.join(' ')), stroke(seps.join(' '))], text: box(w, h, 0, 0, 0, 0) }
    },
    { keywords: UI('list', 'items', 'rows', 'bullets', 'feed', 'list view'), ports: PORTS_THIRDS }
  ),
  shape(
    'wf-table',
    'Table placeholder',
    W,
    360,
    180,
    (w, h) => {
      const rows = 5
      const cols = 3
      const segs: string[] = []
      for (let i = 1; i < rows; i++) segs.push(line(0, (h * i) / rows, w, (h * i) / rows))
      for (let c = 1; c < cols; c++) segs.push(line((w * c) / cols, 0, (w * c) / cols, h))
      return { parts: [fill(rect(0, 0, w, h)), shade(rect(0, 0, w, h / rows)), stroke(segs.join(' '))], text: box(w, h, 0, 0, 0, 0) }
    },
    { keywords: UI('table', 'data grid', 'grid', 'rows', 'spreadsheet'), ports: PORTS_THIRDS }
  ),
  shape(
    'wf-accordion',
    'Accordion',
    W,
    280,
    150,
    (w, h) => {
      const n = 3
      const rh = h / n
      const segs: string[] = []
      const s = Math.min(rh * 0.12, w * 0.03)
      for (let i = 0; i < n; i++) {
        if (i > 0) segs.push(line(0, rh * i, w, rh * i))
        segs.push(chevronDown(w - rh / 2, rh * (i + 0.5), s))
      }
      return { parts: [fill(rect(0, 0, w, h, Math.min(6, w * 0.03, h * 0.03))), stroke(segs.join(' '))], text: pad(w, h, 12, 0, rh, h - rh) }
    },
    { keywords: UI('accordion', 'collapse', 'expand', 'faq', 'disclosure'), defaultLabel: 'Section', defaultStyle: { textAlign: 'left' } }
  ),
  // ── navigation ────────────────────────────────────────────────────────────
  shape(
    'wf-navbar',
    'Navigation bar',
    W,
    640,
    56,
    (w, h) => {
      const rr = Math.min(h * 0.25, w * 0.04)
      const items: string[] = []
      const iw = Math.min(56, w * 0.1)
      for (let i = 0; i < 4; i++) {
        const x1 = w - Math.min(16, w * 0.03) - i * iw * 1.3
        items.push(line(x1 - iw, h / 2, x1, h / 2))
      }
      return {
        parts: [fill(rect(0, 0, w, h)), shade(circle(Math.min(16, w * 0.03) + rr, h / 2, rr)), stroke(items.join(' '))],
        text: box(w, h, Math.min(16, w * 0.03) + rr * 2 + 8, 0, w * 0.3, h)
      }
    },
    { keywords: UI('navbar', 'navigation', 'header', 'top bar', 'menu bar', 'app bar'), defaultLabel: 'Brand', defaultStyle: { textAlign: 'left', bold: true }, ports: PORTS_THIRDS }
  ),
  shape(
    'wf-tabs',
    'Tabs',
    W,
    360,
    40,
    (w, h) => {
      const n = 3
      const tw = w / n
      const ul = Math.min(3, h * 0.1)
      return {
        parts: [fill(rect(0, 0, w, h)), stroke(`${line(tw, h * 0.25, tw, h * 0.75)} ${line(2 * tw, h * 0.25, 2 * tw, h * 0.75)}`), solid(rect(0, h - ul, tw, ul))],
        text: box(w, h, 0, 0, tw, h - ul)
      }
    },
    { keywords: UI('tabs', 'tab bar', 'segmented', 'navigation', 'sections'), defaultLabel: 'Tab one' }
  ),
  shape(
    'wf-breadcrumb',
    'Breadcrumb',
    W,
    280,
    24,
    (w, h) => {
      const seg = w / 3
      const s = Math.min(h * 0.2, seg * 0.05)
      return {
        parts: [
          none(bounds(w, h)),
          stroke(
            lines([
              line(seg * 0.62, h / 2, seg * 0.62 + seg * 0.32, h / 2),
              line(seg * 1.08, h / 2, seg * 1.86, h / 2),
              chevronRight(seg * 0.98, h / 2, s),
              chevronRight(seg * 1.96, h / 2, s),
              line(seg * 2.08, h / 2, seg * 2.8, h / 2)
            ])
          )
        ],
        text: box(w, h, 0, 0, seg * 0.6, h)
      }
    },
    { keywords: UI('breadcrumb', 'path', 'trail', 'navigation', 'hierarchy'), outline: bounds, defaultLabel: 'Home', defaultStyle: { textAlign: 'left' } }
  ),
  shape(
    'wf-pagination',
    'Pagination',
    W,
    220,
    32,
    (w, h) => {
      const n = 5
      const s = Math.min(h, (w / n) * 0.8)
      const g = (w - n * s) / (n - 1 || 1)
      const boxes: string[] = []
      for (let i = 1; i < n; i++) boxes.push(rect(i * (s + g), (h - s) / 2, s, s, s * 0.15))
      return { parts: [none(bounds(w, h)), solid(rect(0, (h - s) / 2, s, s, s * 0.15)), stroke(boxes.join(' '))], text: box(w, h, 0, 0, 0, 0) }
    },
    { keywords: UI('pagination', 'pager', 'pages', 'next', 'previous'), outline: bounds }
  ),
  shape(
    'wf-stepper',
    'Stepper',
    W,
    300,
    32,
    (w, h) => {
      const n = 4
      const rr = Math.min(h / 2, w / (n * 3))
      const cx = (i: number): number => rr + (i * (w - 2 * rr)) / (n - 1)
      const circles: string[] = []
      const links: string[] = []
      for (let i = 0; i < n; i++) {
        if (i > 0) circles.push(circle(cx(i), h / 2, rr))
        if (i < n - 1) links.push(line(cx(i) + rr, h / 2, cx(i + 1) - rr, h / 2))
      }
      return { parts: [none(bounds(w, h)), solid(circle(cx(0), h / 2, rr)), stroke(`${circles.join(' ')} ${links.join(' ')}`)], text: box(w, h, 0, 0, 0, 0) }
    },
    { keywords: UI('stepper', 'steps', 'wizard', 'progress', 'onboarding'), outline: bounds }
  ),
  shape(
    'wf-sidebar',
    'Sidebar',
    W,
    220,
    480,
    (w, h) => {
      const top = Math.min(56, h * 0.12)
      const ih = Math.min(36, h * 0.08)
      const items: string[] = []
      for (let i = 0; i < 6; i++) {
        const cy = top + ih * (i + 0.5)
        if (cy < h - 4) items.push(line(Math.min(20, w * 0.1), cy, w * 0.7, cy))
      }
      return {
        parts: [fill(rect(0, 0, w, h)), shade(rect(0, top, w, Math.min(ih, Math.max(0, h - top)))), stroke(`${line(0, top, w, top)} ${items.join(' ')}`)],
        text: box(w, h, 12, 0, w - 24, top)
      }
    },
    {
      keywords: UI('sidebar', 'side nav', 'drawer', 'navigation', 'menu', 'rail'),
      container: true,
      ports: PORTS_THIRDS,
      defaultLabel: 'App',
      defaultStyle: { textAlign: 'left', bold: true },
      minW: 30,
      minH: 60
    }
  ),
  shape(
    'wf-hamburger',
    'Hamburger menu',
    W,
    32,
    32,
    (w, h) => ({
      parts: [none(bounds(w, h)), stroke(`${line(w * 0.15, h * 0.28, w * 0.85, h * 0.28)} ${line(w * 0.15, h * 0.5, w * 0.85, h * 0.5)} ${line(w * 0.15, h * 0.72, w * 0.85, h * 0.72)}`)],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: UI('hamburger', 'menu', 'three lines', 'nav toggle', 'drawer'), outline: bounds, aspectLocked: true }
  ),
  shape(
    'wf-footer',
    'Footer',
    W,
    640,
    120,
    (w, h) => {
      const cols = 3
      const segs: string[] = []
      const cw = w / (cols + 1)
      for (let c = 0; c < cols; c++) segs.push(textLines(cw * (c + 1) - cw * 0.3, h * 0.2, cw * 0.6, h * 0.6, 4, 0.7))
      return { parts: [fill(rect(0, 0, w, h)), stroke(segs.join(' '))], text: box(w, h, Math.min(16, w * 0.03), 0, cw * 0.6, h) }
    },
    { keywords: UI('footer', 'site footer', 'bottom', 'links', 'copyright'), defaultLabel: '© Company', defaultStyle: { textAlign: 'left' }, ports: PORTS_THIRDS }
  ),
  shape(
    'wf-divider',
    'Divider',
    W,
    240,
    12,
    (w, h) => ({ parts: [none(bounds(w, h)), stroke(line(0, h / 2, w, h / 2))], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: UI('divider', 'separator', 'rule', 'hr', 'line'), outline: bounds, minH: 4 }
  ),
  // ── media and data ────────────────────────────────────────────────────────
  shape(
    'wf-video',
    'Video player',
    W,
    320,
    190,
    (w, h) => {
      const s = Math.min(w, h) * 0.14
      const bar = h - Math.min(14, h * 0.1)
      return {
        parts: [
          fill(rect(0, 0, w, h, Math.min(6, w * 0.03, h * 0.03))),
          solid(poly([[w / 2 - s * 0.6, h * 0.45 - s], [w / 2 + s, h * 0.45], [w / 2 - s * 0.6, h * 0.45 + s]])),
          stroke(line(Math.min(12, w * 0.04), bar, w - Math.min(12, w * 0.04), bar)),
          solid(circle(w * 0.35, bar, Math.min(4, h * 0.03)))
        ],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('video', 'player', 'media', 'play', 'movie', 'embed') }
  ),
  shape(
    'wf-map',
    'Map placeholder',
    W,
    300,
    200,
    (w, h) => {
      const pw = Math.min(w, h) * 0.12
      const px = w * 0.6
      const py = h * 0.42
      return {
        parts: [
          fill(rect(0, 0, w, h)),
          stroke(`M0,${r(h * 0.7)} Q${P(w * 0.4, h * 0.5)} ${P(w, h * 0.8)} M${P(w * 0.3, 0)} Q${P(w * 0.45, h * 0.5)} ${P(w * 0.25, h)} ${line(w * 0.7, 0, w * 0.85, h)}`),
          solid(`M${P(px, py + pw * 1.4)} L${P(px - pw * 0.7, py + pw * 0.3)} A${r(pw * 0.8)},${r(pw * 0.8)} 0 1 1 ${P(px + pw * 0.7, py + pw * 0.3)} Z`)
        ],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('map', 'location', 'pin', 'geography', 'directions', 'embed') }
  ),
  shape(
    'wf-calendar',
    'Calendar',
    W,
    280,
    240,
    (w, h) => {
      const hb = Math.min(36, h * 0.18)
      const cols = 7
      const rows = 5
      const segs: string[] = []
      for (let c = 1; c < cols; c++) segs.push(line((w * c) / cols, hb, (w * c) / cols, h))
      for (let i = 1; i < rows; i++) segs.push(line(0, hb + ((h - hb) * i) / rows, w, hb + ((h - hb) * i) / rows))
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(6, w * 0.03, h * 0.03))), shade(rect(0, 0, w, hb)), stroke(`${line(0, hb, w, hb)} ${segs.join(' ')}`)],
        text: box(w, h, 8, 0, w - 16, hb)
      }
    },
    { keywords: UI('calendar', 'date picker', 'month', 'schedule', 'dates'), defaultLabel: 'October', ports: PORTS_THIRDS }
  ),
  shape(
    'wf-chart-bar',
    'Bar chart placeholder',
    W,
    280,
    180,
    (w, h) => {
      const m = Math.min(16, w * 0.08, h * 0.1)
      const bars: string[] = []
      const heights = [0.45, 0.75, 0.55, 0.9, 0.65]
      const bw = (w - 2 * m) / (heights.length * 1.6)
      heights.forEach((f, i) => {
        const bh = (h - 2 * m) * f
        bars.push(rect(m + bw * 0.4 + i * bw * 1.6, h - m - bh, bw, bh))
      })
      return {
        parts: [fill(rect(0, 0, w, h)), shade(bars.join(' ')), stroke(`M${P(m, m)} V${r(h - m)} H${r(w - m)}`)],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('chart', 'bar chart', 'graph', 'analytics', 'dashboard', 'columns') }
  ),
  shape(
    'wf-chart-line',
    'Line chart placeholder',
    W,
    280,
    180,
    (w, h) => {
      const m = Math.min(16, w * 0.08, h * 0.1)
      const ys = [0.7, 0.45, 0.55, 0.25, 0.35, 0.1]
      const pts = ys.map((f, i): [number, number] => [m + ((w - 2 * m) * i) / (ys.length - 1), m + (h - 2 * m) * f])
      return {
        parts: [fill(rect(0, 0, w, h)), stroke(`M${P(m, m)} V${r(h - m)} H${r(w - m)} M${pts.map(([x, y]) => P(x, y)).join(' L')}`)],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('chart', 'line chart', 'trend', 'graph', 'analytics', 'time series') }
  ),
  shape(
    'wf-chart-pie',
    'Pie chart placeholder',
    W,
    160,
    160,
    (w, h) => ({
      parts: [fill(ellipse(w / 2, h / 2, w / 2, h / 2)), shade(wedge(w / 2, h / 2, w / 2, h / 2, -90, 40)), stroke(`${line(w / 2, h / 2, w / 2, 0)}`)],
      text: box(w, h, 0, 0, 0, 0)
    }),
    { keywords: UI('chart', 'pie chart', 'donut', 'share', 'breakdown', 'analytics'), aspectLocked: true }
  ),
  shape(
    'wf-rating',
    'Star rating',
    W,
    130,
    24,
    (w, h) => {
      const s = Math.min(h, w / 5.5)
      const g = (w - 5 * s) / 4
      const starAt = (i: number): string => poly(fit(s, s, star(1, 1, 5, 0.45)).map(([x, y]) => [x + i * (s + g), y + (h - s) / 2]))
      return {
        parts: [none(bounds(w, h)), solid([0, 1, 2].map(starAt).join(' ')), stroke([3, 4].map(starAt).join(' '))],
        text: box(w, h, 0, 0, 0, 0)
      }
    },
    { keywords: UI('rating', 'stars', 'review', 'score', 'feedback'), outline: bounds, minH: 8 }
  ),
  shape(
    'wf-file-upload',
    'File drop zone',
    W,
    280,
    140,
    (w, h) => {
      const s = Math.min(w, h) * 0.12
      const cx = w / 2
      const cy = h * 0.38
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(8, w * 0.04, h * 0.04))), stroke(`M${P(cx - s, cy)} L${P(cx, cy - s)} L${P(cx + s, cy)} M${P(cx, cy - s)} V${r(cy + s)}`)],
        text: box(w, h, 8, h * 0.58, w - 16, h * 0.34)
      }
    },
    {
      keywords: UI('upload', 'file', 'drop zone', 'drag and drop', 'attachment'),
      defaultLabel: 'Drop files here',
      defaultStyle: { strokeDash: 'dashed' }
    }
  ),
  shape(
    'wf-scrollbar',
    'Scrollbar',
    W,
    14,
    200,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, w / 2)), solid(rect(w * 0.2, h * 0.1, w * 0.6, h * 0.3, w * 0.3))], text: box(w, h, 0, 0, 0, 0) }),
    { keywords: UI('scrollbar', 'scroll', 'overflow'), minW: 4 }
  ),
  shape(
    'wf-donut-progress',
    'Circular progress',
    W,
    64,
    64,
    (w, h) => ({
      parts: [
        fill(`${ellipse(w / 2, h / 2, w / 2, h / 2)} ${ellipseRev(w / 2, h / 2, w * 0.36, h * 0.36)}`),
        solid(
          `M${P(w / 2, 0)} A${r(w / 2)},${r(h / 2)} 0 1 1 ${P(0, h / 2)} H${r(w * 0.14)} A${r(w * 0.36)},${r(h * 0.36)} 0 1 0 ${P(w / 2, h * 0.14)} Z`
        )
      ],
      text: box(w, h, w * 0.2, h * 0.3, w * 0.6, h * 0.4)
    }),
    {
      keywords: UI('progress', 'ring', 'gauge', 'circular', 'percent', 'kpi'),
      aspectLocked: true,
      defaultLabel: '75%',
      outline: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2)
    }
  )
]
