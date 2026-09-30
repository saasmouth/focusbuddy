import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// A pinned email on a real desk, in the real app.
//
// The unit tests cover the store query, the content whitelist, the quoted-history
// split and the widget's own rendering in isolation. None of them can see the
// thing that actually goes wrong when a widget kind is added: a kind has to be
// registered in several files with no compile-time link to each other, and
// missing one produces no error -- just an empty rectangle on the desk.
//
// Asserted on text rather than on [data-widget-kind]. That attribute lives on
// WidgetFrame, which a desk in its default layout does not mount at all -- the
// first version of this spec failed for that reason while the widget underneath
// was rendering perfectly, which is a good way to waste an afternoon on a
// working feature.
//
// No mail account is configured here, and that is the point rather than a
// limitation: it exercises the state a user meets when the message is not in the
// local copy, and that state must SAY so and name the email. A blank card there
// reads as "this email is empty" when the truth is "this mailbox is not
// connected".

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a pinned email renders on a desk and says why it has no body', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Northmead' })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'mail-thread' as never,
      title: 'Strata levy notice',
      // What the pin flow writes: the uids, the thread anchor, and a snapshot of
      // the subject and sender so the card is never anonymous.
      content: JSON.stringify({
        mode: 'one',
        uids: [4101],
        rootMessageId: '<levy-2026-q1@example.test>',
        subject: 'Strata levy notice',
        fromName: 'Dana Reed',
        accountKey: 'someone@example.test'
      }),
      x: 80,
      y: 80,
      width: 380,
      height: 420
    })
    return desk.id as string
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  // The kind is registered as far as the desk's own object list, which names it
  // by its human label. A kind missing from the catalogue shows up here.
  await expect(window.getByText(/Strata levy notice \(mail thread\)/i)).toBeAttached({
    timeout: 15_000
  })

  // It rendered, and it is honest about why there is no body.
  //
  // Specifically "not in the local copy" and NOT "no mail account connected",
  // which is the pinned accountKey doing its job: the widget carries the mailbox
  // it was pinned from, so the handler looks that account up in the store rather
  // than refusing because nothing is connected right now. Before that change this
  // same widget could not render at all without a live mailbox.
  await expect(window.getByText(/not in PlexiDesk/i).first()).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText('No mail account connected.')).toHaveCount(0)
  await expect(window.getByText(/It was pinned as/).first()).toBeVisible()

  // And the offer to widen to the conversation is there, which is the widget's
  // own chrome rather than a generic placeholder.
  await expect(window.getByText('Show the whole thread').first()).toBeVisible()
})
