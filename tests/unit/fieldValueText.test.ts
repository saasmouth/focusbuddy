// @vitest-environment node
// A field's value as a person reads it, for a read-only Field widget.
import { describe, it, expect } from 'vitest'
import { fieldValueText } from '../../src/renderer/src/lib/fieldValueText'
import type { FieldDefinition } from '../../src/shared/fields'

const def = (type: string, config: Record<string, unknown> = {}): FieldDefinition => ({ id: 'f', type, label: 'F', config }) as FieldDefinition
const OPTS = { options: [{ id: 'o1', label: 'Red' }, { id: 'o2', label: 'Blue' }] }

describe('fieldValueText', () => {
  it('text is itself; rich text is its words, a line per block', () => {
    expect(fieldValueText(def('text-short'), 'Ada')).toBe('Ada')
    expect(fieldValueText(def('text-long'), 'line one\nline two')).toBe('line one\nline two')
    const rich = JSON.stringify({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world', marks: [{ type: 'bold' }] }] },
      { type: 'heading', content: [{ type: 'text', text: 'Next' }] }
    ] })
    expect(fieldValueText(def('text-rich'), rich)).toBe('Hello world\nNext')
    expect(fieldValueText(def('text-rich'), 'not json')).toBe('not json')
  })

  it('a number with its precision, prefix and suffix', () => {
    expect(fieldValueText(def('number', { precision: 2, prefix: '$' }), 3.5)).toBe('$3.50')
    expect(fieldValueText(def('number', { suffix: ' kg' }), 12)).toBe('12 kg')
    expect(fieldValueText(def('number'), null)).toBe('')
  })

  it('options by their labels, never their ids', () => {
    expect(fieldValueText(def('single-select', OPTS), 'o2')).toBe('Blue')
    expect(fieldValueText(def('single-select', OPTS), 'gone')).toBe('')
    expect(fieldValueText(def('multi-select', OPTS), ['o1', 'gone', 'o2'])).toBe('Red, Blue')
  })

  it('a checkbox, a date, and a count for what lives outside the field', () => {
    expect(fieldValueText(def('checkbox'), true)).toBe('Yes')
    expect(fieldValueText(def('checkbox'), false)).toBe('No')
    expect(fieldValueText(def('date'), Date.UTC(2026, 10, 20))).toBe(new Date(Date.UTC(2026, 10, 20)).toLocaleDateString(undefined, { timeZone: 'UTC' }))
    expect(fieldValueText(def('date'), null)).toBe('')
    expect(fieldValueText(def('attachment'), ['a', 'b'])).toBe('2 files')
    expect(fieldValueText(def('relation'), ['r'])).toBe('1 linked record')
    expect(fieldValueText(def('doc-ref'), [])).toBe('')
  })

  it('nothing is invented: an empty value is empty', () => {
    for (const t of ['text-short', 'text-long', 'text-rich', 'number', 'date', 'attachment', 'relation', 'doc-ref']) {
      expect(fieldValueText(def(t, t.includes('select') ? OPTS : {}), undefined)).toBe('')
    }
  })
})
