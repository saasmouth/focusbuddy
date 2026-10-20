// @vitest-environment node
// Build with AI reads the user's own widget files when the request is about
// them. A file must actually be named or substantially matched: one shared
// filler word used to pull an unrelated desk's content into the build.
import { describe, it, expect } from 'vitest'
import { widgetFileRelevance } from '../../src/main/ai/anthropic'

describe('widgetFileRelevance', () => {
  const kitchen = ['Kitchen', 'Kitchen budget: $18,500 cap. Contractor is Delgado Builders. Work starts 3 March.'] as const
  const launch = ['Launch date', 'Launch date moved to 14 November 2026 because the payments review slipped. Owner: Priya.'] as const

  it('ignores files that share only filler words with the request', () => {
    expect(widgetFileRelevance('Plan a two-week family trip to Japan with a budget, itinerary, bookings and packing.', ...kitchen)).toBe(0)
    expect(widgetFileRelevance('Manage a small rental property: tenants, rent payments, maintenance requests, and documents.', ...launch)).toBe(0)
  })

  it('keeps a file the request names', () => {
    expect(widgetFileRelevance('Set up a desk to finish my kitchen renovation', ...kitchen)).toBeGreaterThan(0)
  })

  it('keeps a file two meaningful words of the request appear in', () => {
    expect(widgetFileRelevance('Track the contractor and the budget for the renovation', ...kitchen)).toBeGreaterThan(0)
  })
})
