// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// "Make the cognitive load warning more obvious, centred with the Add Widget
// button, show the alarm light as bigger and more aggressive as it becomes
// more overloaded."
//
// It was a 3px dot in the bottom floating pill — hover-gated and at the edge of
// the screen, which is where you look least, and why an overloaded desk could
// go unnoticed entirely.

const ROOT = join(__dirname, '..', '..', 'src', 'renderer', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const meter = read('components/LoadMeter.tsx')
const canvas = read('components/Canvas.tsx')
const pill = read('components/FloatingPill.tsx')

describe('it is where the eye already is', () => {
  it('renders in the header slot that holds Add widget', () => {
    const slot = canvas.slice(
      canvas.indexOf('<HeaderSlot id="fb-header-add">'),
      canvas.indexOf('</HeaderSlot>', canvas.indexOf('<HeaderSlot id="fb-header-add">'))
    )
    expect(slot).toContain('<DeskAddWidget')
    expect(slot).toContain('<LoadMeter variant="header" />')
  })

  it('is not also left in the floating pill', () => {
    // Two of the same indicator in one window is noise, and the pill is the
    // place it was being missed.
    expect(pill).not.toContain('<LoadMeter')
  })

  it('exposes its tier and load for inspection', () => {
    expect(meter).toContain('data-testid="load-meter"')
    expect(meter).toContain('data-tier=')
    expect(meter).toContain('data-load=')
  })
})

describe('the alarm escalates with the real load', () => {
  it('grows AND quickens, rather than switching between two states', () => {
    // Size alone stops being noticed once it stops changing.
    expect(meter).toContain('function alarmFor')
    expect(meter).toContain('animationDuration')
  })

  it('stays still while nothing is wrong', () => {
    // An indicator that animates at Light teaches you to ignore it.
    expect(meter).toContain('idx < 2 ? 0')
  })

  it('keeps escalating past the overload threshold, then stops', () => {
    // Everything from 15 widgets to fifty used to read as one flat
    // "Overloaded"; and an indicator that grew without limit would end up
    // bigger than the button beside it.
    expect(meter).toContain('function overloadDepth')
    expect(meter).toContain('Math.min(1')
  })

  it('names the tier once it matters, instead of relying on colour alone', () => {
    expect(meter).toContain('showLabel')
    expect(meter).toContain('tierIndexForLoad(load) >= 2')
  })

  it('reads as an alarm when overloaded — glow and a tinted ground', () => {
    expect(meter).toContain('boxShadow')
    expect(meter).toContain('bg-red-500/10')
    expect(meter).toContain('rings > 1')
  })
})
