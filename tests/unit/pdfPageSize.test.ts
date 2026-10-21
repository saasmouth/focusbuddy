// Electron 44's printToPDF reads a custom pageSize in inches. Microns (the old
// unit) make the print compositor fail outright, which silently broke every
// custom-sized PDF export after the Electron upgrade. These pin the unit.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { pdfPageSize, pxToInch } from '../../src/main/pdfPageSize'

describe('pdfPageSize', () => {
  it('converts CSS pixels to inches at 96 per inch', () => {
    expect(pxToInch(96)).toBe(1)
    expect(pxToInch(816)).toBe(8.5)
    expect(pdfPageSize(486, 348)).toEqual({ width: 486 / 96, height: 348 / 96 })
  })

  it('never yields a zero or negative page', () => {
    expect(pxToInch(0)).toBeGreaterThan(0)
    expect(pxToInch(-20)).toBeGreaterThan(0)
  })

  it('no main-process exporter passes microns to printToPDF', () => {
    const dir = join(__dirname, '../../src/main')
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /pxToMicron|pdfPageMicrons|25400/.test(readFileSync(join(dir, f), 'utf-8')))
    expect(offenders).toEqual([])
  })
})
