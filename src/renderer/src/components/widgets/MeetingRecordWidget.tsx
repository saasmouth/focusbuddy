import { useEffect, useState } from 'react'
import type { Widget } from '@shared/types'
import type { Meeting } from '@shared/meetings'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'

// C5 (S3-DEC-020, the last sliver) — the meeting Record ON its desk. The
// wrap-up mints this widget beside the transcript doc; content holds the
// meeting id, and the Record is READ from the meetings store on every mount,
// never copied into the widget — the desk shows the same truth PlexiMeet
// shows, provenance tiers included:
//   yours    — your words, verbatim, ink-100 (they lead);
//   heard    — anchored to a spoken moment, timestamped, quoted rule;
//   inferred — the machine's unanchored reading, visibly quieter (ink-50).
// An honest empty state names when a Record exists ("written at wrap-up");
// the door opens the meeting in PlexiMeet (the DEC-079 seam).

function fmtOffsetMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function MeetingRecordWidget({ widget }: { widget: Widget }): JSX.Element {
  const goMeetings = useViewStore((s) => s.goMeetings)
  const meetingId = widget.content.trim()
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let alive = true
    if (!meetingId) {
      setMissing(true)
      return
    }
    void window.api.meetings
      .get(meetingId)
      .then((m) => {
        if (!alive) return
        if (m) setMeeting(m)
        else setMissing(true)
      })
      .catch(() => {
        if (alive) setMissing(true)
      })
    return () => {
      alive = false
    }
  }, [meetingId])

  function openMeeting(segmentId?: string | null): void {
    goMeetings()
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent('fb:open-meeting', {
            detail: segmentId ? { id: meetingId, segmentId } : { id: meetingId }
          })
        ),
      250
    )
  }

  const spans = meeting?.record?.spans ?? []
  const sections = [...new Set(spans.map((s) => s.section).filter((s): s is string => !!s))]

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-raised)] text-[var(--ink-100)]" data-testid="meeting-record-widget">
      <div className="px-3 py-2 border-b border-[var(--edge-soft)] flex items-center gap-2 shrink-0">
        <Icon name="history_edu" size={15} className="text-[rgb(var(--accent))]" />
        <span className="text-[12.5px] font-semibold truncate flex-1 min-w-0">
          {meeting ? meeting.title : 'Meeting Record'}
        </span>
        {meeting && (
          <button
            onClick={() => openMeeting()}
            className="text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-100)] fb-press shrink-0"
            data-testid="record-widget-open"
            title="Open this meeting in PlexiiMeet"
          >
            Open →
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
        {missing ? (
          <p className="text-[12px] text-[var(--ink-50)] leading-relaxed">
            This meeting is gone — the Record went with it.
          </p>
        ) : !meeting ? (
          <p className="text-[12px] text-[var(--ink-50)]">Loading…</p>
        ) : spans.length === 0 ? (
          <p className="text-[12px] text-[var(--ink-50)] leading-relaxed" data-testid="record-widget-empty">
            No Record yet — it is written at wrap-up, from your notes and the attributed transcript.
          </p>
        ) : (
          <div className="space-y-3">
            {(sections.length > 0 ? sections : [null]).map((section) => (
              <div key={section ?? '_'}>
                {section && (
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">
                    {section.toUpperCase()}
                  </div>
                )}
                <div className="space-y-1">
                  {spans
                    .filter((s) => (section ? s.section === section : !s.section))
                    .map((s, i) =>
                      s.tier === 'yours' ? (
                        <p key={i} className="text-[12.5px] leading-snug text-[var(--ink-100)]">
                          {s.text}
                        </p>
                      ) : s.tier === 'heard' && s.segmentId ? (
                        <button
                          key={i}
                          onClick={() => openMeeting(s.segmentId)}
                          className="block w-full text-left text-[12px] leading-snug text-[var(--ink-90)] border-l-2 border-[var(--edge-soft)] pl-2 hover:border-[rgb(var(--accent))] fb-press"
                          title={`Heard at ${fmtOffsetMs(s.startMs ?? 0)} — open the moment in the Thread`}
                          data-testid="record-widget-heard"
                        >
                          <span className="fb-tabular text-[var(--ink-50)]">[{fmtOffsetMs(s.startMs ?? 0)}]</span>{' '}
                          {s.text}
                        </button>
                      ) : (
                        <p key={i} className="text-[12px] leading-snug text-[var(--ink-50)]" title="Inferred — the machine's reading, no transcript anchor">
                          {s.text}
                        </p>
                      )
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
