import { create } from 'zustand'
import type { ActionProposal } from '@shared/types'
import { useMeetingsStore } from './meetings'
import { getMeetingOrigin, clearMeetingOrigin } from '../lib/startMeeting'
import type { CarriedItem } from '@shared/meetings'
import { sendBriefsToAttendees } from '../lib/briefOutbox'
import { ensureMeetingFolder, saveTranscriptDoc, saveMeetingNotesDoc } from '../lib/meetingWrapup'
import { transcribeRecording } from '../lib/transcribeRecording'
import { transcriptLooksEmpty, NO_SPEECH_MESSAGE } from '../lib/transcriptSanity'
import { mergeTrackSegments, formatAttributedTranscript } from '../lib/transcriptMerge'
import { buildYoursSpans, validateRecordSpans } from '../lib/recordSpans'
import { DEFAULT_RECORD_TEMPLATE } from '../lib/recordTemplates'
import { validateCommitments, type ValidatedCommitment } from '../lib/commitments'
import { useAccountStore } from './account'
import { useNodeStore } from './nodes'
import { useWidgetStore } from './widgets'

// End-of-conversation wrap-up. When a meeting or call ends with a recording, this
// drives the one honest pipeline: transcribe the mixed audio, ask the AI for a
// grounded summary and the deliverables that came out of it, save a Meeting
// record, and surface a review panel. Every failure (no key, no speech, AI error)
// resolves to an honest state, never a fabricated summary or silent success.

export type WrapupStatus = 'idle' | 'processing' | 'review' | 'error'

interface WrapupState {
  status: WrapupStatus
  title: string
  step: string // human-readable progress, e.g. "Transcribing…"
  summary: string
  transcript: string
  proposals: ActionProposal[]
  error: string | null
  needsApiKey: boolean
  // Where this meeting's output is kept. The transcript is saved as a document
  // in this folder, and the deliverables default to it too.
  folderId: string | null
  folderName: string
  transcriptDocId: string | null
  // DEC-079 — the Meeting record this wrap-up produced, so approved
  // deliverables can POINT back at it (sourceType 'meeting').
  meetingId: string | null
  /** M5 — still-open items from the PREVIOUS instance of this series
   *  ("carried from last time"), shown atop the commitments card. Database
   *  facts, fetched once the meeting record exists with its seriesId. */
  carried: CarriedItem[]
  /** M3 — extracted commitments awaiting the confirm stop. Never filed
   *  silently (S3-DEC-023): the review screen is the only door. */
  commitments: ValidatedCommitment[]
  begin: (input: {
    title: string
    buffer: ArrayBuffer
    mimeType: string
    durationSec: number
    /** M2 — per-participant attributed takes (C1): each is transcribed
     *  on-device and merged on the shared clock; the mixed buffer is only
     *  the fallback when per-track capture was unavailable. */
    tracks?: Array<{ accountId: string; buffer: ArrayBuffer; mimeType: string; offsetMs: number; durationSec: number }>
    /** accountId → display name, resolved at record time from the roster. */
    speakers?: Record<string, string>
    /** M2 (CR-11) — MEETING audio never goes to a cloud engine; set by the
     *  meeting store. Calls keep the provider preference until their own
     *  consent round. */
    forceLocalTranscription?: boolean
    /** The Stage notepad + ⌘⇧M anchors, saved verbatim beside the transcript. */
    notes?: string
    moments?: number[]
    /** Q14 — the roster with handles, so a series meeting's brief can be
     *  DM'd to the other attendees (host shareBriefs knob permitting). */
    attendees?: Array<{ accountId: string; handle: string }>
    /** DEC-130 — "Record notes" picked a REAL desk (DEC-118): the Record and
     *  the transcript stand on it; no desk is minted. */
    deskNodeId?: string | null
  }) => Promise<void>
  dismiss: () => void
}

export const useWrapupStore = create<WrapupState>((set) => ({
  status: 'idle',
  title: '',
  step: '',
  summary: '',
  transcript: '',
  proposals: [],
  error: null,
  needsApiKey: false,
  folderId: null,
  folderName: '',
  transcriptDocId: null,
  meetingId: null,
  commitments: [],
  carried: [],

  begin: async ({ title, buffer, mimeType, durationSec, tracks, speakers, forceLocalTranscription, notes, moments, attendees, deskNodeId }) => {
    set({ status: 'processing', title, step: 'Transcribing the conversation…', summary: '', transcript: '', proposals: [], error: null, needsApiKey: false, folderId: null, folderName: '', transcriptDocId: null, meetingId: null, commitments: [], carried: [] })
    // M1 — the notes are the user's words and must survive REGARDLESS of how
    // transcription goes: saved first, not gated on the pipeline succeeding.
    if ((notes && notes.trim()) || (moments && moments.length)) {
      void saveMeetingNotesDoc(title, notes ?? '', moments ?? [], Date.now())
    }
    try {
      await runWrapup({ title, buffer, mimeType, durationSec, tracks, speakers, forceLocalTranscription, notes, attendees, deskNodeId }, set)
    } catch (err) {
      // Any thrown/rejected step (IPC failure, network, an AI provider error)
      // resolves to an honest error state instead of an unhandled rejection —
      // this is the crash the user saw "after the meeting ends".
      set({
        status: 'error',
        error: `The meeting wrap-up could not finish: ${(err as Error)?.message ?? 'unknown error'}.`
      })
    }
  },

  dismiss: () => set({ status: 'idle', title: '', step: '', summary: '', transcript: '', proposals: [], error: null, needsApiKey: false, folderId: null, folderName: '', transcriptDocId: null, meetingId: null, commitments: [], carried: [] })
}))

// Expose the store on window so e2e specs can put the review panel into a known
// state (wrapupOverlay.spec): a real meeting cannot produce audio in headless
// Electron. A thin handle to the real store, not a mock -- the same pattern as
// __fbAccount and __fbWorkItems -- and it changes nothing about how the app
// behaves.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbWrapup?: typeof useWrapupStore }).__fbWrapup = useWrapupStore
}

// The wrap-up pipeline, extracted so `begin` can wrap the whole thing in one
// try/catch. Sets state through the store's setter.
interface WrapupInput {
  attendees?: Array<{ accountId: string; handle: string }>
  title: string
  buffer: ArrayBuffer
  mimeType: string
  durationSec: number
  tracks?: Array<{ accountId: string; buffer: ArrayBuffer; mimeType: string; offsetMs: number; durationSec: number }>
  speakers?: Record<string, string>
  forceLocalTranscription?: boolean
  notes?: string
  deskNodeId?: string | null
}

async function runWrapup(
  { title, buffer, mimeType, durationSec, tracks, speakers, forceLocalTranscription, notes, attendees, deskNodeId }: WrapupInput,
  set: (partial: Partial<WrapupState>) => void
): Promise<void> {
  let transcript = ''
  const segmentDrafts: Array<{
    speakerAccountId: string | null
    speakerName: string
    startMs: number
    endMs: number
    text: string
    confidence: number | null
  }> = []

  if (tracks && tracks.length > 0) {
    // M2 — the attributed path (C1): each participant's take is transcribed
    // ON-DEVICE (CR-11 — meeting audio never leaves the machine; there is no
    // cloud fallback here, failing honestly beats a second disclosure) and
    // merged on the shared clock. Attribution is exact by construction — no
    // model ever infers who spoke.
    const perTrack: Array<{
      accountId: string
      speakerName: string
      offsetMs: number
      segments: Array<{ startMs: number; endMs: number; text: string; confidence: number | null }> | null
      text: string
      durationSec: number
    }> = []
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      const who = speakers?.[track.accountId] || `Speaker ${i + 1}`
      set({ step: `Transcribing on-device — ${who} (${i + 1} of ${tracks.length})…` })
      const r = await transcribeRecording(track.buffer, track.mimeType, { forceLocal: true })
      if (!r.ok) {
        set({
          status: 'error',
          error: `On-device transcription failed for ${who}: ${r.error} Meeting audio never leaves this machine, so there is no cloud fallback — fix the local engine and re-run.`
        })
        return
      }
      perTrack.push({
        accountId: track.accountId,
        speakerName: who,
        offsetMs: track.offsetMs,
        segments: r.segments,
        text: r.transcript,
        durationSec: r.durationSec ?? track.durationSec
      })
    }
    segmentDrafts.push(...mergeTrackSegments(perTrack))
    transcript = formatAttributedTranscript(segmentDrafts)
  } else {
    // Legacy single-blob path (no per-track capture available). A meeting
    // still refuses the cloud (CR-11); calls keep the provider preference.
    const t = await transcribeRecording(buffer, mimeType, {
      forceLocal: forceLocalTranscription === true
    })
    if (!t.ok) {
      set({
        status: 'error',
        needsApiKey: t.reason === 'no_key',
        error:
          t.reason === 'no_key'
            ? 'Add a transcription key in Settings → AI to get summaries and deliverables from your calls.'
            : `Could not transcribe the conversation: ${t.error}`
      })
      return
    }
    transcript = t.transcript.trim()
  }
  // DEC-130 — an engine never returns "nothing" for silence; it returns
  // "you you you you". Refuse to summarise, file or deliver on that.
  if (!transcript || transcriptLooksEmpty(transcript, durationSec)) {
    set({ status: 'error', error: NO_SPEECH_MESSAGE })
    return
  }

  // Keep the meeting's output together: create a folder from the meeting origin
  // (a desk-started meeting nests under that desk; otherwise a top-level folder),
  // and save the transcript into it as a real document. This is best-effort —
  // if filing fails the wrap-up still shows the summary and deliverables.
  const origin = getMeetingOrigin()
  const folder = await ensureMeetingFolder(origin, title, Date.now())
  const transcriptDocId = await saveTranscriptDoc(title, transcript, folder?.folderId ?? null)
  clearMeetingOrigin()
  set({
    transcript,
    step: 'Summarising and finding deliverables…',
    folderId: folder?.folderId ?? null,
    folderName: folder?.folderName ?? '',
    transcriptDocId
  })
  const r = await window.api.voiceNote.processMeetingEnd({ transcript, meetingTitle: title, durationSec })
  if (!r.ok) {
    set({
      status: 'error',
      needsApiKey: !!r.needsApiKey,
      error: r.needsApiKey
        ? 'Add an Anthropic API key in Settings → AI to get a summary and deliverables.'
        : `Could not summarise the conversation: ${r.error}`
    })
    return
  }

  const summary = r.summary ?? ''
  const proposals = r.proposals ?? []
  // Save a real Meeting record so the conversation is kept, best-effort — but
  // AWAITED now (DEC-079): its id is what lets an approved deliverable point
  // back at the meeting whose transcript produced it. A failed save degrades
  // to the old behaviour (items file without a link), never blocks the review.
  const meeting = await useMeetingsStore
    .getState()
    .create({
      title,
      transcript,
      summary,
      // DEC-144 — action items are tasks in Focus (create-work-item); a
      // create-task is a whole desk. The record lists both until the
      // commitments extractor (below) replaces them with what it found.
      actionItems: proposals
        .filter((p) => p.kind === 'create-task' || p.kind === 'create-work-item')
        .map((p) => ('title' in p ? p.title : ''))
        .filter(Boolean),
      durationSec,
      // M5 — series identity rides the calendar origin onto the record;
      // "carried from last time" is an indexed lookup from here on.
      seriesId: origin?.kind === 'calendar' ? (origin.seriesId ?? null) : null,
      blockId: origin?.kind === 'calendar' ? (origin.blockId ?? null) : null
    })
    .catch(() => null)

  // M2 — the segments ARE the transcript now; persist them against the
  // meeting record so the Thread rendering and Recall have data, not prose.
  let savedSegments: Awaited<ReturnType<typeof window.api.meetings.saveSegments>> = []
  if (meeting?.id && segmentDrafts.length) {
    savedSegments = (await window.api.meetings.saveSegments(meeting.id, segmentDrafts).catch(() => null)) ?? []
  }

  // M2b — the Enhance pass (§3.4). Best-effort and NON-BLOCKING: a failed
  // enhance leaves summary + deliverables intact and the Record simply
  // absent. `yours` spans are built HERE from the notes, verbatim — the
  // model never touches them; its heard claims are validated against the
  // real segments and the unprovable are downgraded (S3-DEC-021).
  if (meeting?.id && savedSegments.length) {
    set({ step: 'Building the record…', status: 'processing' })
    const enh = await window.api.meetings
      .enhanceRecord({
        title,
        notes: notes ?? '',
        sections: DEFAULT_RECORD_TEMPLATE.sections,
        segments: savedSegments.map((s) => ({
          id: s.id,
          startMs: s.startMs,
          speakerName: s.speakerName,
          text: s.text
        }))
      })
      .catch(() => ({ ok: false as const, error: 'enhance failed' }))
    if (enh.ok) {
      const spans = [...buildYoursSpans(notes ?? ''), ...validateRecordSpans(enh.spans, savedSegments)]
      await window.api.meetings
        .update(meeting.id, { record: { spans, generatedAt: Date.now() } })
        .catch(() => null)
    }
  }

  // M3 (§3.6) — extract commitments, meetings only. They go to the CONFIRM
  // STOP, never silently into Attention (S3-DEC-023); other-owned ones
  // arrive unchecked with the owner as a mention (C7 — reference, no send).
  let commitments: ValidatedCommitment[] = []
  if (meeting?.id && savedSegments.length && forceLocalTranscription) {
    set({ step: 'Finding commitments…' })
    const selfId = useAccountStore.getState().account?.id ?? ''
    const roster = [
      ...new Map(
        savedSegments
          // M6 (CR-12) — the guest capture's system-audio track ('guests',
          // labelled Them) is speech, not a person: guests are NEVER owners,
          // so they never enter the roster the extractor may assign from. A
          // guest's spoken commitment still surfaces — ownerless, with its
          // "[m:ss] Them: …" anchor showing exactly who said it.
          .filter((s) => s.speakerAccountId && s.speakerAccountId !== 'guests')
          .map((s) => [s.speakerAccountId as string, { accountId: s.speakerAccountId as string, name: s.speakerName }])
      ).values(),
      ...(selfId ? [{ accountId: selfId, name: speakers?.[selfId] || speakers?.me || 'You' }] : [])
    ]
    const ex = await window.api.meetings
      .extractCommitments({
        title,
        notes: notes ?? '',
        segments: savedSegments.map((s) => ({
          id: s.id,
          startMs: s.startMs,
          speakerName: s.speakerName,
          speakerAccountId: s.speakerAccountId,
          text: s.text
        })),
        roster
      })
      .catch(() => ({ ok: false as const, error: 'extract failed' }))
    if (ex.ok) commitments = validateCommitments(ex.commitments, savedSegments, selfId)
  }

  // M5 — carried from last time: the previous instance's still-open items,
  // for the section atop the commitments card. Best-effort database facts.
  let carried: CarriedItem[] = []
  if (meeting?.seriesId && typeof window.api.meetings.prep === 'function') {
    carried = await window.api.meetings
      .prep({ seriesId: meeting.seriesId, excludeMeetingId: meeting.id })
      .then((prep) => prep.carried)
      .catch(() => [])
  }

  // M3 (Q14, host-only default) — the meeting authors ONE To Know item:
  // machine-authored, DEC-014-exempt, the Attendant's own channel. "Here's
  // what happened; you don't need to do anything." M5 wired Q14's per-series
  // knob: a series whose briefs are noise can turn them off, and the wrap-up
  // asks before minting. Briefs for OTHER attendees remain a named follow-up
  // (they need an out-of-room delivery channel).
  const briefsWanted = !meeting?.seriesId
    ? true
    : await window.api.meetings
        .getSeriesPrefs(meeting.seriesId)
        .then((p) => p.briefs)
        .catch(() => true)
  if (meeting?.id && forceLocalTranscription && summary.trim() && briefsWanted) {
    await window.api.workItems
      .create({
        title: `Meeting brief — ${title || 'Meeting'}`,
        notes: summary.trim(),
        intentClass: 'to_know',
        dueAt: null,
        confidence: 1,
        approvalState: 'approved',
        wiOrigin: 'ai',
        sourceType: 'meeting',
        sourceRef: meeting.id
      })
      .then(() => window.dispatchEvent(new CustomEvent('fb:workitems-changed')))
      .catch(() => null)
  }

  // Q14, the delivery half — the brief goes to the OTHER attendees as a DM
  // (server-persisted; an away attendee meets it on their next open). Gated
  // by the host's per-series shareBriefs knob, default OFF — sending is its
  // own act. Filing on the far side is the recipient's own choice
  // (briefInbox). Best-effort: a failed send never touches the review.
  if (meeting?.seriesId && meeting?.id && summary.trim() && attendees?.length) {
    const share = await window.api.meetings
      .getSeriesPrefs(meeting.seriesId)
      .then((p) => p.shareBriefs)
      .catch(() => false)
    if (share) {
      const selfId = useAccountStore.getState().account?.id ?? null
      void sendBriefsToAttendees({
        seriesId: meeting.seriesId,
        meetingId: meeting.id,
        title: title || 'Meeting',
        summary: summary.trim(),
        attendees,
        selfAccountId: selfId
      }).catch(() => 0)
    }
  }

  // M2c (CR-13) — persist the audio takes, retention permitting. Zero means
  // zero: no save call at all, so the takes die with this function's scope
  // at the end of the Enhance pass — not at a nightly sweep. A declined
  // participant has no take to save (DEC-098 never captured one).
  if (meeting?.id && tracks && tracks.length && forceLocalTranscription) {
    const retention = await window.api.meetings.getAudioRetention().catch(() => '30' as const)
    if (retention !== '0') {
      await window.api.meetings
        .saveAudioTakes(
          meeting.id,
          tracks.map((tr) => ({
            speaker: speakers?.[tr.accountId] || tr.accountId,
            bytes: new Uint8Array(tr.buffer),
            mimeType: tr.mimeType,
            offsetMs: tr.offsetMs
          }))
        )
        .catch(() => null)
    }
  }

  // M2c (S3-DEC-020) — the meeting's CONTAINER: a desk node holding its
  // documents as widgets, so sharing, ACL, search and staging all come for
  // free. Meetings only (calls stay lightweight); best-effort — a failed
  // desk never blocks the review.
  if (meeting?.id && forceLocalTranscription) {
    try {
      // DEC-130 — a desk picked at the recording's door IS the container;
      // otherwise the meeting mints its own, as before.
      const desk = deskNodeId
        ? { id: deskNodeId }
        : await useNodeStore.getState().create({
            parentId: null,
            kind: 'task',
            title: `${title || 'Meeting'} — ${new Date().toLocaleDateString()}`
          })
      if (desk) {
        // C5, closed: the Record itself stands on the desk beside the
        // transcript — reading the meetings store live, provenance tiers
        // intact, its heard lines doors into the Thread.
        await useWidgetStore
          .getState()
          .create({ taskId: desk.id, kind: 'meeting-record', content: meeting.id, x: 40, y: 40, width: 420, height: 440 })
          .catch(() => null)
        let x = 500
        for (const docId of [transcriptDocId].filter((d): d is string => !!d)) {
          await useWidgetStore
            .getState()
            .create({ taskId: desk.id, kind: 'doc', content: docId, x, y: 40, width: 560, height: 420 })
            .catch(() => null)
          x += 600
        }
        await window.api.meetings.update(meeting.id, { deskNodeId: desk.id }).catch(() => null)
      }
    } catch {
      /* the review still shows; the meeting simply has no desk */
    }
  }

  // C6 — the split: COMMITMENTS go through the confirm stop; artifact
  // deliverables stay on ProposalCards. When the extractor produced
  // commitments, the overlapping create-task proposals leave the cards so
  // one obligation is never offered through two doors.
  // DEC-144: action items now arrive as create-work-item, so those overlap
  // the commitments too; the record's action items become the commitments.
  const cardProposals = commitments.length
    ? proposals.filter((p) => p.kind !== 'create-task' && p.kind !== 'create-work-item')
    : proposals
  if (commitments.length && meeting?.id) {
    await window.api.meetings
      .update(meeting.id, { actionItems: commitments.map((c) => c.title).filter(Boolean) })
      .catch(() => null)
  }
  set({ status: 'review', summary, proposals: cardProposals, commitments, carried, meetingId: meeting?.id ?? null })
}
