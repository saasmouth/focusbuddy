import { describe, it, expect } from 'vitest'
import { formatValue, type NumberFormat } from '@shared/sheetFormat'

// Display formatting must never turn a non-numeric value into a fabricated
// number. Numbers format as asked; anything that does not fit is returned as-is.

describe('formatValue — number', () => {
  it('applies decimals and thousands grouping', () => {
    const fmt: NumberFormat = { kind: 'number', decimals: 2, thousands: true }
    expect(formatValue('1234.5', fmt)).toBe('1,234.50')
    expect(formatValue('1234.5', { kind: 'number', decimals: 0, thousands: true })).toBe('1,235')
    expect(formatValue('1234.5', { kind: 'number', decimals: 2, thousands: false })).toBe('1234.50')
  })

  it('preserves negative sign', () => {
    expect(formatValue('-1234.5', { kind: 'number', decimals: 1, thousands: true })).toBe('-1,234.5')
  })
})

describe('formatValue — currency', () => {
  it('prefixes the symbol with grouping and decimals', () => {
    expect(formatValue('1234.5', { kind: 'currency', decimals: 2, symbol: '$' })).toBe('$1,234.50')
  })
  it('puts the minus before the symbol', () => {
    expect(formatValue('-99', { kind: 'currency', decimals: 2, symbol: '$' })).toBe('-$99.00')
  })
})

describe('formatValue — percent', () => {
  it('multiplies by 100 and appends %', () => {
    expect(formatValue('0.125', { kind: 'percent', decimals: 1 })).toBe('12.5%')
    expect(formatValue('1234.5', { kind: 'percent', decimals: 0 })).toBe('123450%')
  })
})

describe('formatValue — date', () => {
  it('formats an ISO date with tokens', () => {
    expect(formatValue('2026-06-17', { kind: 'date', pattern: 'YYYY-MM-DD' })).toBe('2026-06-17')
    expect(formatValue('2026-06-17', { kind: 'date', pattern: 'D MMM YYYY' })).toBe('17 Jun 2026')
  })
  it('formats an epoch-ms value', () => {
    const ms = String(Date.UTC(2026, 0, 5))
    expect(formatValue(ms, { kind: 'date', pattern: 'YYYY-MM-DD' })).toBe('2026-01-05')
  })
  it('returns the raw value when it is not a date', () => {
    expect(formatValue('not a date', { kind: 'date', pattern: 'YYYY-MM-DD' })).toBe('not a date')
  })
})

describe('formatValue — honesty', () => {
  it('returns non-numeric text unchanged under numeric formats', () => {
    expect(formatValue('hello', { kind: 'number', decimals: 2 })).toBe('hello')
    expect(formatValue('hello', { kind: 'currency', decimals: 2, symbol: '$' })).toBe('hello')
    expect(formatValue('#ERR', { kind: 'percent', decimals: 0 })).toBe('#ERR')
  })
  it('passes empty and general through untouched', () => {
    expect(formatValue('', { kind: 'number', decimals: 2 })).toBe('')
    expect(formatValue('42', { kind: 'general' })).toBe('42')
    expect(formatValue('42', undefined)).toBe('42')
  })
  it('round-trips an already-formatted currency value', () => {
    expect(formatValue('$1,234.50', { kind: 'currency', decimals: 2, symbol: '$' })).toBe('$1,234.50')
  })
})
