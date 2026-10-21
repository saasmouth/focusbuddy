// Org chart cards. Avatars are shaded circles the editor can fill with a photo
// or initials; the label (name / title lines) sits beside or under them. Ids are
// saved in documents — never rename.

import { type ShapeDef, line, rect } from './types'
import { PORTS_THIRDS, box, circle, fill, pad, shade, shape, stroke } from './kit'
import { topBand } from './containers'

const O = 'Org chart' as const
const ORG_PORTS: [number, number][] = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
  [0.25, 1],
  [0.75, 1]
]

// Avatar on the left, text to the right.
function personCard(
  id: string,
  label: string,
  opts: { keywords: string[]; defaultLabel: string; w?: number; h?: number; avatarPaint?: 'shade' | 'stroke'; extra?: Partial<ShapeDef> }
): ShapeDef {
  return shape(
    id,
    label,
    O,
    opts.w ?? 220,
    opts.h ?? 72,
    (w, h) => {
      const rr = Math.min(h * 0.32, w * 0.16)
      const cx = Math.min(10, w * 0.05) + rr
      const av = circle(cx, h / 2, rr)
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(10, h * 0.2, w * 0.1))), opts.avatarPaint === 'stroke' ? stroke(av) : shade(av)],
        text: pad(w, h, cx + rr + 8, 4, 8, 4)
      }
    },
    {
      keywords: ['org chart', 'organisation', 'organization', 'person', 'employee', ...opts.keywords],
      defaultLabel: opts.defaultLabel,
      ports: ORG_PORTS,
      minW: 40,
      minH: 24,
      defaultStyle: { textAlign: 'left' },
      ...opts.extra
    }
  )
}

export const ORGCHART_SHAPES: ShapeDef[] = [
  personCard('org-person', 'Person card', { keywords: ['staff', 'member', 'card', 'profile', 'avatar'], defaultLabel: 'Name\nTitle' }),
  shape(
    'org-executive',
    'Executive card',
    O,
    240,
    96,
    (w, h) => {
      const hb = Math.min(h * 0.32, 30)
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(10, h * 0.15, w * 0.1))), shade(topBand(w, hb, Math.min(10, h * 0.15, w * 0.1)))],
        text: pad(w, h, 10, hb + 4, 10, 4)
      }
    },
    {
      keywords: ['org chart', 'executive', 'ceo', 'leader', 'director', 'head', 'manager', 'vp'],
      defaultLabel: 'Name\nChief Executive',
      ports: ORG_PORTS,
      minW: 40,
      minH: 30,
      color: '#1D4ED8'
    }
  ),
  shape(
    'org-person-vertical',
    'Person card (photo on top)',
    O,
    140,
    150,
    (w, h) => {
      const rr = Math.min(w * 0.22, h * 0.2)
      const cy = Math.min(10, h * 0.08) + rr
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(10, w * 0.08, h * 0.08))), shade(circle(w / 2, cy, rr))],
        text: pad(w, h, 6, cy + rr + 6, 6, 6)
      }
    },
    {
      keywords: ['org chart', 'person', 'photo', 'profile', 'vertical card', 'headshot'],
      defaultLabel: 'Name\nTitle',
      ports: ORG_PORTS,
      minW: 30,
      minH: 40
    }
  ),
  shape(
    'org-team',
    'Team box',
    O,
    300,
    180,
    (w, h) => {
      const hb = Math.min(h * 0.25, 28)
      return { parts: [fill(rect(0, 0, w, h, 8)), stroke(line(0, hb, w, hb))], text: box(w, h, 10, 0, w - 20, hb) }
    },
    {
      keywords: ['org chart', 'team', 'group', 'squad', 'unit', 'container'],
      defaultLabel: 'Team',
      container: true,
      ports: PORTS_THIRDS,
      minW: 60,
      minH: 40
    }
  ),
  personCard('org-vacant', 'Vacant position', {
    keywords: ['vacant', 'open role', 'hiring', 'tbd', 'unfilled', 'position'],
    defaultLabel: 'Vacant\nTitle',
    avatarPaint: 'stroke',
    extra: { defaultStyle: { strokeDash: 'dashed', textAlign: 'left' } }
  }),
  shape(
    'org-assistant',
    'Assistant',
    O,
    170,
    56,
    (w, h) => {
      const bar = Math.min(6, w * 0.05)
      return {
        parts: [fill(rect(0, 0, w, h, Math.min(8, h * 0.2))), shade(rect(0, 0, bar * 2, h, Math.min(8, h * 0.2)))],
        text: pad(w, h, bar * 2 + 6, 4, 6, 4)
      }
    },
    {
      keywords: ['org chart', 'assistant', 'pa', 'ea', 'executive assistant', 'support', 'staff'],
      defaultLabel: 'Name\nAssistant',
      ports: ORG_PORTS,
      minW: 30,
      minH: 20,
      defaultStyle: { textAlign: 'left' }
    }
  ),
  shape(
    'org-department',
    'Department header',
    O,
    260,
    48,
    (w, h) => {
      const strip = Math.min(6, h * 0.15)
      return { parts: [fill(rect(0, 0, w, h)), shade(rect(0, h - strip, w, strip))], text: pad(w, h, 8, 4, 8, strip + 2) }
    },
    {
      keywords: ['org chart', 'department', 'division', 'function', 'header', 'business unit'],
      defaultLabel: 'Department',
      ports: ORG_PORTS,
      minW: 40,
      minH: 20,
      defaultStyle: { bold: true }
    }
  ),
  shape(
    'org-position',
    'Role box',
    O,
    180,
    56,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h, Math.min(6, h * 0.15)))], text: pad(w, h, 8, 4) }),
    { keywords: ['org chart', 'role', 'position', 'title', 'job'], defaultLabel: 'Role', ports: ORG_PORTS }
  ),
  personCard('org-contractor', 'Contractor', {
    keywords: ['contractor', 'freelancer', 'consultant', 'external', 'vendor', 'temp'],
    defaultLabel: 'Name\nContractor',
    extra: { defaultStyle: { strokeDash: 'dotted', textAlign: 'left' } }
  })
]
