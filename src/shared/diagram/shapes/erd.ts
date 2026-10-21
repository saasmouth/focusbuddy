// Entity-relationship notation: Chen symbols (entities, relationships,
// attributes) plus the table-style entity used for crow's-foot diagrams. Ids
// are saved in documents — never rename.

import { type ShapeDef, ellipse, fpoly, line, rect } from './types'
import { topBand } from './containers'
import { PORTS_THIRDS, box, fill, pad, pathShape, shade, shape, stroke } from './kit'

const E = 'ERD' as const

const diamond = (w: number, h: number): string => fpoly(w, h, [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]])
const oval = (w: number, h: number): string => ellipse(w / 2, h / 2, w / 2, h / 2)
const ovalText = (w: number, h: number) => pad(w, h, w * 0.14, h * 0.14)
const diamondText = (w: number, h: number) => pad(w, h, w * 0.22, h * 0.22)

function entityTable(id: string, label: string, keyCol: boolean, keywords: string[]): ShapeDef {
  return shape(
    id,
    label,
    E,
    200,
    150,
    (w, h) => {
      const hb = Math.min(h * 0.24, 30)
      const parts = [fill(rect(0, 0, w, h, 4)), shade(topBand(w, hb, 4)), stroke(line(0, hb, w, hb))]
      if (keyCol) parts.push(stroke(line(Math.min(w * 0.18, 40), hb, Math.min(w * 0.18, 40), h)))
      return { parts, text: box(w, h, 6, 0, w - 12, hb) }
    },
    { keywords: ['entity', 'table', 'record', 'database table', 'schema', ...keywords], special: 'erdEntity', ports: PORTS_THIRDS, minW: 40, minH: 30, defaultLabel: 'Entity' }
  )
}

export const ERD_SHAPES: ShapeDef[] = [
  entityTable('erd-entity', 'Entity', false, ['crows foot', "crow's foot", 'attributes']),
  entityTable('erd-entity-keyed', 'Entity with key column', true, ['primary key', 'pk', 'fk', 'columns', 'crows foot']),
  pathShape('erd-entity-simple', 'Entity (Chen)', E, 130, 60, (w, h) => rect(0, 0, w, h), (w, h) => pad(w, h, 6, 4), {
    keywords: ['entity', 'chen', 'strong entity', 'rectangle'],
    defaultLabel: 'Entity'
  }),
  shape(
    'erd-weak-entity',
    'Weak entity',
    E,
    130,
    60,
    (w, h) => {
      const k = Math.min(5, w * 0.08, h * 0.12)
      return { parts: [fill(rect(0, 0, w, h)), stroke(rect(k, k, w - 2 * k, h - 2 * k))], text: pad(w, h, k + 4, k + 2) }
    },
    { keywords: ['weak entity', 'double border', 'dependent', 'chen'], defaultLabel: 'Weak entity' }
  ),
  pathShape('erd-relationship', 'Relationship', E, 120, 72, diamond, diamondText, {
    keywords: ['relationship', 'diamond', 'association', 'chen', 'relation'],
    defaultLabel: 'has'
  }),
  shape(
    'erd-identifying-relationship',
    'Identifying relationship',
    E,
    130,
    80,
    (w, h) => {
      const k = 0.1
      return {
        parts: [fill(diamond(w, h)), stroke(fpoly(w, h, [[0.5, k], [1 - k * 0.8, 0.5], [0.5, 1 - k], [k * 0.8, 0.5]]))],
        text: pad(w, h, w * 0.26, h * 0.26)
      }
    },
    { keywords: ['identifying relationship', 'double diamond', 'weak relationship', 'chen'], defaultLabel: 'owns' }
  ),
  pathShape('erd-attribute', 'Attribute', E, 110, 52, oval, ovalText, {
    keywords: ['attribute', 'property', 'field', 'column', 'ellipse', 'oval'],
    defaultLabel: 'attribute'
  }),
  pathShape('erd-key-attribute', 'Key attribute', E, 110, 52, oval, ovalText, {
    keywords: ['key attribute', 'primary key', 'pk', 'identifier', 'underline'],
    defaultLabel: 'id',
    defaultStyle: { underline: true }
  }),
  pathShape('erd-partial-key', 'Partial key attribute', E, 110, 52, oval, ovalText, {
    keywords: ['partial key', 'discriminator', 'weak key', 'underline'],
    defaultLabel: 'key',
    defaultStyle: { underline: true, italic: true }
  }),
  shape(
    'erd-multivalued-attribute',
    'Multivalued attribute',
    E,
    120,
    56,
    (w, h) => {
      const k = Math.min(5, w * 0.08, h * 0.12)
      return {
        parts: [fill(oval(w, h)), stroke(ellipse(w / 2, h / 2, w / 2 - k, h / 2 - k))],
        text: pad(w, h, w * 0.16, h * 0.18)
      }
    },
    { keywords: ['multivalued', 'multi-valued', 'double ellipse', 'list attribute'], defaultLabel: 'values' }
  ),
  pathShape('erd-derived-attribute', 'Derived attribute', E, 110, 52, oval, ovalText, {
    keywords: ['derived', 'computed', 'calculated', 'dashed ellipse'],
    defaultLabel: 'age',
    defaultStyle: { strokeDash: 'dashed' }
  }),
  shape(
    'erd-associative-entity',
    'Associative entity',
    E,
    140,
    80,
    (w, h) => ({ parts: [fill(rect(0, 0, w, h)), stroke(diamond(w, h))], text: pad(w, h, w * 0.24, h * 0.24) }),
    { keywords: ['associative entity', 'junction table', 'bridge', 'link table', 'many to many'], defaultLabel: 'Enrolment' }
  ),
  pathShape(
    'erd-isa',
    'ISA / subtype',
    E,
    90,
    70,
    (w, h) => fpoly(w, h, [[0.5, 0], [1, 1], [0, 1]]),
    (w, h) => pad(w, h, w * 0.26, h * 0.46, w * 0.26, h * 0.06),
    { keywords: ['isa', 'is a', 'inheritance', 'specialisation', 'specialization', 'generalisation', 'subtype'], defaultLabel: 'ISA' }
  ),
  pathShape('erd-subtype-circle', 'Subtype discriminator', E, 36, 36, oval, ovalText, {
    keywords: ['disjoint', 'overlapping', 'd', 'o', 'subtype', 'category'],
    aspectLocked: true,
    defaultLabel: 'd'
  }),
  shape(
    'erd-view',
    'View',
    E,
    200,
    150,
    (w, h) => {
      const hb = Math.min(h * 0.24, 30)
      return { parts: [fill(rect(0, 0, w, h, 4)), stroke(line(0, hb, w, hb))], text: box(w, h, 6, 0, w - 12, hb) }
    },
    {
      keywords: ['view', 'virtual table', 'query', 'materialised view', 'materialized view'],
      special: 'erdEntity',
      ports: PORTS_THIRDS,
      minW: 40,
      minH: 30,
      defaultLabel: 'View',
      defaultStyle: { strokeDash: 'dashed' }
    }
  )
]
