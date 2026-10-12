import type { TimeBlock, TimeBlockDraft } from '@shared/types'
import { useTimeBlockStore } from '../stores/timeBlocks'
import { useActionHistory } from '../stores/actionHistory'
import { useAccountStore } from '../stores/account'
import { useNoticeStore } from '../stores/notice'
import { fmtTimeRange, scheduleInviteHold, HOLD_INVITES_MS, type InviteHold } from './bookTime'
import { inviteDeliveryNote, sendMeetingInvites } from './meetingInvite'
import { personDisplayName } from './personName'

// DEC-131 — booking a block from the Book-time dialog, with the house undo
// toast and the invite hold: the calendar grid's own path, extracted so the
// assistant's Calendar tab (a day picked on its month view) books exactly the
// way the Calendar page does. The dialog closes FIRST (the caller's job), the
// block is created, and the stated hold means outbound invites wait a window
// Undo can cancel. Once that window closes, the connected mailbox sends the
// invite and a notice reports the real delivery outcome.
export async function bookBlockWithToast(draft: TimeBlockDraft): Promise<TimeBlock> {
  const { create: createBlock, remove: removeBlock } = useTimeBlockStore.getState()
  let block = await createBlock(draft)
  const meeting = draft.meeting ?? null

  function holdInvites(): InviteHold | null {
    if (!meeting || meeting.invitees.length === 0) return null
    return scheduleInviteHold(() => {
      const account = useAccountStore.getState().account
      void sendMeetingInvites({
        title: draft.title || 'Meeting',
        startMs: draft.startMs,
        durationMin: draft.durationMin,
        roomId: meeting.roomId,
        invitees: meeting.invitees,
        hostName: account ? personDisplayName(account) : undefined,
        joinUrl: meeting.joinUrl,
        location: meeting.location
      })
        .then((result) => {
          const text = inviteDeliveryNote(result, meeting.invitees.length)
          if (text) useNoticeStore.getState().show({ text, icon: 'mail' }, 9000)
        })
        .catch(() => {
          useNoticeStore.getState().show(
            {
              text: 'The meeting is saved, but the invitation email could not be sent.',
              icon: 'error'
            },
            9000
          )
        })
    }, HOLD_INVITES_MS)
  }

  let hold = holdInvites()
  const verb = meeting ? 'Scheduled' : 'Booked'
  useActionHistory.getState().recordWithToast({
    label: `${verb} “${draft.title || 'Focus'}” · ${fmtTimeRange(draft.startMs, draft.durationMin)}${
      hold ? ` · invites hold ${HOLD_INVITES_MS / 1000}s` : ''
    }`,
    undo: async () => {
      hold?.cancel()
      await removeBlock(block.id)
    },
    redo: async () => {
      block = await createBlock(draft)
      hold = holdInvites()
    }
  })
  return block
}
