import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The PlexiMeet material round (operator: "this page still feels very
// vibe-coded"). Presentation ONLY — these pin the house recipes onto the
// view so a refactor cannot quietly ship it back to bespoke styling. The
// functional pins (testids, copy, honest states) live in the m1–m6 suites
// and were untouched by this round.

const ROOT = join(__dirname, '..', '..')
const view = readFileSync(join(ROOT, 'src/renderer/src/components/views/PlexiMeetView.tsx'), 'utf-8')

// DEC-144: Attention was renamed Focus and its items are "tasks"; these pins follow the new words.
describe('PlexiMeet wears the house material — and reads like Home', () => {
  // History: DEC-112 put the view on desk-paper (no-tod) with a raised,
  // bordered rail, a 15px display rail header and a glossy ROSE primary,
  // and gave the detail a sticky raised header bar. DEC-116 (operator:
  // "make the entire page background, textures and colors look and feel
  // like the Home screen") moved it onto Home's own substrate and idioms:
  // paper-texture (Home deliberately avoids desk-paper — its overlay caused
  // the mid-screen seam and the light-in-dark bug), Home's page shell and
  // hero header, Home's accent primary, and every surface a floating kit
  // RailCard. The rose identity survives as the module chip; the sunken
  // segmented track survives unchanged.
  it('the view sits on the SAME paper as Home (paper-texture, not desk-paper)', () => {
    // History: DEC-116 made the root `h-full w-full overflow-auto` — the whole
    // page scrolled. DEC-134 (operator: the DEC-132 rule "for the Calendar and
    // Meet pages") made it a WINDOW on a wide screen — the hero pinned, the
    // rail and the column beside it scrolling inside themselves — and a
    // scroll only below `lg`, where the columns stack. Same paper.
    expect(view).toContain('overflow-y-auto lg:overflow-hidden paper-texture text-[var(--ink-100)]" data-testid="pleximeet-view"')
    expect(view).not.toContain('desk-paper no-tod')
    // Home's page shell, verbatim: wide board, 32px gutters.
    expect(view).toContain('max-w-[1440px] mx-auto px-8 pb-8 pt-8')
  })

  it("the hero is Home's greeting header: display title, quiet subtitle, rose module chip", () => {
    expect(view).toContain('fb-display-hero text-[24px] leading-tight text-[var(--ink-100)]">PlexiMeet</h1>')
    expect(view).toContain('bg-rose-500/10 text-rose-500')
    expect(view).toContain('data-testid="meet-hero"')
    expect(view).not.toContain('fb-display text-[15px] font-bold')
  })

  it("the primary is Home's accent button (the Customize → Done glow), the doors are surface buttons", () => {
    expect(view).toContain(
      'rounded-[10px] bg-[rgb(var(--accent))] text-white shadow-[0_1px_2px_rgb(var(--accent)/0.25),0_4px_12px_-2px_rgb(var(--accent)/0.30)]'
    )
    expect(view).not.toContain('from-rose-500 to-rose-600')
    expect(view.split('h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]').length - 1).toBeGreaterThanOrEqual(4)
  })

  it('the rail is a stack of floating kit cards standing beside the Record', () => {
    // History: DEC-116 pinned the rail with `lg:sticky lg:top-4 self-start`
    // and capped its list at `calc(100vh - 460px)` — a number the wrapping
    // hero could not see, so a full rail ran under the footer. DEC-134: the
    // rail stands as tall as the window's floor and no taller (the Meetings
    // card shrinks and scrolls its list; the Recording card keeps its
    // height), so nothing sticks because nothing scrolls past it.
    expect(view).toContain('shrink-0 flex flex-col gap-4 lg:min-h-0" data-testid="meet-rail"')
    expect(view).not.toContain('lg:sticky lg:top-4 self-start')
    expect(view).toContain('testId="meet-list-card"')
    expect(view).toContain('testId="meet-recording-card"')
    expect(view).not.toContain('bg-[color-mix(in_oklab,var(--surface-raised)_88%,transparent)]')
  })

  it('the recording preferences live in one eyebrowed card', () => {
    expect(view).toContain('>RECORDING</div>')
  })

  it('the record views are a sunken segmented track with a glossy active pill', () => {
    expect(view).toContain('rounded-full bg-[var(--surface-sunken)] shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)]')
    expect(view).toContain('shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.15)]')
  })

  it("the detail header is the title on a house card — the Timeline's own material — with surface-button doors; no sticky bar", () => {
    // History: DEC-112 gave the detail a sticky raised header bar; DEC-116
    // set the title bare on the paper. DEC-135 (operator: "add a filled-in
    // colored block behind it similar to the timeline block, just for that
    // header title field") puts the title, its facts and the doors on the
    // same `fb-card` the Timeline and the panes wear, edge to edge with them.
    expect(view).toContain('<header className="fb-card px-4 py-3.5 flex items-start justify-between gap-4 flex-wrap mb-4 shrink-0" data-testid="meet-detail-header">')
    // The overlapping speaker avatars ring in the card's fill, not the paper's.
    expect(view).toContain('rounded-full text-[9.5px] font-bold text-white ring-2 ring-[var(--surface-raised)]')
    expect(view).toContain('data-testid="meet-detail-header"')
    expect(view).toContain('fb-display-hero text-[22px] leading-tight text-[var(--ink-100)] outline-none')
    expect(view).not.toContain('sticky top-0 z-10 flex items-center gap-2 px-5 py-3')
    expect(view).not.toContain('bg-[color-mix(in_oklab,var(--surface-raised)_92%,transparent)]')
  })

  it('the three panels are kit RailCards with icon headers, side by side, the transcript capped at the window', () => {
    expect(view).not.toContain('max-w-[780px]')
    expect(view).toContain('flex flex-col lg:flex-row gap-4 items-start')
    for (const s of ['title="Timeline"', 'title="Record"', 'title="Transcript"']) expect(view).toContain(s)
    expect(view).toContain('testId="meet-record-pane"')
    expect(view).toContain('testId="meet-transcript-pane"')
    // History: DEC-116 stuck the transcript to the page scroll under
    // `lg:max-h-[calc(100vh-140px)]`, which put its bottom edge under the
    // footer. DEC-134: the Record hands the two panes its remaining height;
    // each hugs short content and caps at the floor (`lg:max-h-full`), the
    // thread scrolling under the pinned search and speaker chips.
    expect(view).toContain('shrink-0 flex flex-col lg:min-h-0 lg:max-h-full"')
    expect(view).not.toContain('lg:max-h-[calc(100vh-140px)]')
  })

  it("the Record's section titles sit on a filled block — the pane's own sunken fill — like the header on its card", () => {
    // DEC-136 — operator: "Now do the same for the Overview and Analytics
    // tabs." One band, one component, every section title in those two
    // renderings; the section's content stays on the pane beneath it.
    // DEC-137 ("…for the Action items tab") moved the band into its own
    // module so the tab's "Carried from last time" (MeetingCommitmentsCard)
    // could wear it too; the view imports it.
    const band = readFileSync(join(ROOT, 'src/renderer/src/components/RecordSectionTitle.tsx'), 'utf-8')
    expect(band).toContain("export const RECORD_SECTION_BAND = 'rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-1.5 mb-2'")
    expect(band).toContain('<div className={RECORD_SECTION_BAND} data-record-section-title>')
    expect(band).toContain('<h2 className="text-[13.5px] font-semibold tracking-tight text-[var(--ink-100)]">{children}</h2>')
    expect(view).toContain("import RecordSectionTitle, { RECORD_SECTION_BAND } from '../RecordSectionTitle'")
    for (const t of [
      '<RecordSectionTitle>Summary</RecordSectionTitle>',
      '<RecordSectionTitle>Your notes</RecordSectionTitle>',
      '<RecordSectionTitle>{section}</RecordSectionTitle>',
      '<RecordSectionTitle>Who spoke</RecordSectionTitle>',
      '<RecordSectionTitle>Moments</RecordSectionTitle>'
    ])
      expect(view).toContain(t)
    // The transcript toggle is the same band, as a button.
    expect(view).toContain('className={`${RECORD_SECTION_BAND} w-full flex items-center gap-1.5 text-[13.5px] font-semibold tracking-tight text-[var(--ink-100)] fb-press`}')
    // No bare heading is left in those two renderings…
    expect(view).not.toContain('<h2 className="text-[14px] font-semibold tracking-tight text-[var(--ink-100)] mb-2">{section}</h2>')
    expect(view).not.toContain('>Who spoke</h2>')
    expect(view).not.toContain('tracking-wider text-[var(--ink-40)] mb-1.5">Summary</div>')
  })

  it("the Action items tab's section titles wear the same band — In Attention, From the summary, Carried from last time", () => {
    // History: DEC-136 left this tab's eyebrows as they were (not asked
    // for). DEC-137 — operator: "Now do the same for the Action items tab."
    for (const t of ['<RecordSectionTitle>In Focus</RecordSectionTitle>', '<RecordSectionTitle>From the summary</RecordSectionTitle>'])
      expect(view).toContain(t)
    expect(view).not.toContain('tracking-wider text-[var(--ink-40)] mb-1.5">In Attention</div>')
    expect(view).not.toContain('tracking-wider text-[var(--ink-40)] mb-1.5">From the summary</div>')
    // "Carried from last time" lives in MeetingCommitmentsCard and is shared
    // with the wrap-up: the Record asks for the band, the wrap-up keeps its
    // eyebrow.
    expect(view).toContain('lastAt={lastMeeting?.createdAt}\n                  band\n')
    const card = readFileSync(join(ROOT, 'src/renderer/src/components/MeetingCommitmentsCard.tsx'), 'utf-8')
    expect(card).toContain("import RecordSectionTitle from './RecordSectionTitle'")
    expect(card).toContain('band?: boolean')
    expect(card).toContain('<RecordSectionTitle>\n          Carried from last time')
    expect(card).toContain('CARRIED FROM LAST TIME')
    // The confirm-stop card ("Plexii found N things…") is its own tinted
    // block already and is untouched.
    expect(card).toContain('rounded-[var(--radius-card)] border border-accent/30 bg-accent/[0.05] p-3" data-testid="meeting-commitments"')
  })

  it('the kit grew what the page needed, without moving a pixel for Home', () => {
    const kit = readFileSync(join(ROOT, 'src/renderer/src/components/plexi/index.tsx'), 'utf-8')
    expect(kit).toContain('trailing?: ReactNode')
    expect(kit).toContain("bodyClassName ?? (title ? 'px-4 pb-4' : 'p-4')")
    expect(kit).toContain('data-testid={testId}')
    const dash = readFileSync(join(ROOT, 'src/renderer/src/components/ModuleDashboard.tsx'), 'utf-8')
    expect(dash).toContain("embedded ? 'w-full' : 'w-full px-8 py-6'")
  })
})

describe('the Stage and wrap-up wear the house material too', () => {
  const wrap = readFileSync(join(ROOT, 'src/renderer/src/components/WrapupOverlay.tsx'), 'utf-8')
  const stage = readFileSync(join(ROOT, 'src/renderer/src/components/MeetingOverlay.tsx'), 'utf-8')

  it('the wrap-up header carries the rose identity chip and display title', () => {
    expect(wrap).toContain('bg-rose-500/10 text-rose-500')
    expect(wrap).toContain('fb-display text-[14px] font-semibold')
  })

  it("the wrap-up's Done is a glossy accent primary; Close stays quiet", () => {
    expect(wrap).toContain('bg-gradient-to-b from-[rgb(var(--accent))] to-[rgb(var(--accent-hover))]')
    expect(wrap).toContain("status === 'review'")
  })

  it('the Stage controls are premium — press, gloss inset, danger gradient', () => {
    expect(stage).toContain('rounded-full fb-press transition-colors shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]')
    expect(stage).toContain('bg-gradient-to-b from-rose-500 to-rose-600 text-white hover:from-rose-400')
  })
})
