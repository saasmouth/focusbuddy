// The sharing model, as two questions instead of five buttons.
//
// WHAT WAS WRONG. Sharing a desk offered five separate link-minting controls in
// one dialog, three of which produced a public link to a copy of the desk:
//
//   1. Live sharing            named accounts, two-way, real access
//   2. Ephemeral desk share    48h link, nested INSIDE (1)
//   3. Live web view           public, read-only, follows changes
//   4. "Public duplicate link" one-click copy-scope snapshot
//   5. Permission picker       the same snapshot, with view/copy chosen by hand
//
// (4) and (5) were the same call to the same transport, differing only in how
// many clicks it took. (2) was a different transport to a different product,
// nested under the heading for (1). And the dialog carried a paragraph of prose
// whose only job was to warn that the link below (5) was frozen while the
// section above (1) was live — a sure sign the controls could not be told apart
// by looking at them.
//
// WHAT REPLACED IT. Two orthogonal questions, asked in order:
//
//   Who can open this?   specific people  |  anyone with the link
//   What do they get?    (only when "anyone") use it | watch it | read it
//
// Every capability that existed still exists, and each appears exactly once.
// Delivery (copy the link, or email it) is not a kind of sharing and is no
// longer presented as one — it applies to whichever link is selected.
//
// THE DESTINATIONS ARE GENUINELY DIFFERENT, which is why "anyone with the link"
// needs a second question rather than one merged option:
//
//   'use'   → <cloud app>/s/<token>      a real, usable desk in the browser.
//                                        Their edits are theirs and never come
//                                        back. This is the demo path.
//   'watch' → published live projection  read-only, follows the owner's changes.
//   'read'  → <viewer>/share/<token>     a frozen render, plus an "add to my
//                                        workspace" signup for anyone who wants it.
//
// A merged option would have had to pick one and silently drop the other two,
// and they are not substitutes: a demo wants 'use', a status page wants
// 'watch', an attachment wants 'read'.

export type ShareAudience = 'people' | 'link'

/** What someone opening a public link receives. Only meaningful for 'link'. */
export type PublicMode = 'use' | 'watch' | 'read'

export interface PublicModeSpec {
  id: PublicMode
  label: string
  /** One line, in the dialog, saying what the recipient actually gets. */
  blurb: string
  /** Does this mode mint a token that can carry an expiry? */
  expires: boolean
}

// Order is deliberate: 'use' first and default, because a desk someone can
// actually drive is the one that sells the product, and demo desks are the
// reason this surface was revisited at all.
export const PUBLIC_MODES: PublicModeSpec[] = [
  {
    id: 'use',
    label: 'A desk they can use',
    blurb:
      // What a visitor may do is the share page's rule (owner, 2026-11-07):
      // look around and drag things on; anything more is "Download this desk
      // on Plexii" (web/api/readOnly.ts). Say so to the sender.
      'Opens in a browser — no account, no install. They can look around it and drag apps, work widgets and files onto it. To do more, they download it on Plexii and take a copy with them. Nothing they do comes back to you. Best for a demo.',
    expires: true
  },
  {
    id: 'watch',
    label: 'A live view they can watch',
    blurb:
      'A page that follows your changes. They can look around it but not change it. Anyone who wants it can download a copy of it as it is on Plexii. Good for a status board, or a client who should see progress.',
    expires: false
  },
  {
    id: 'read',
    label: 'A snapshot they can read',
    blurb:
      'A frozen copy of this desk as it is right now. It does not update. Anyone who wants it can download it on Plexii or add it to their own workspace, unless you untick that below.',
    expires: true
  }
]

// Said once under the three choices, because it is true of all three (4.3.47;
// owner, 2026-11-08: "webhook secrets and agent instructions stay hidden for
// security"). Each link carries a note where a private work widget is
// (main deskBundle.ts publicWidgetRow, lib/shareSnapshot.ts serializeWidget,
// publicDeskProjection for the live view), and the server strips any an older
// app sends (focusbuddy-signal privateWidgets.ts).
export const PRIVATE_WIDGETS_NOTE =
  'Every kind of link keeps private work widgets — agents, webhooks, mail, chats and contacts — on this computer. The person you send it to sees a note where each one is, never its instructions, secrets, messages or people.'

export function publicMode(id: PublicMode): PublicModeSpec {
  const m = PUBLIC_MODES.find((x) => x.id === id)
  if (!m) throw new Error(`unknown public share mode: ${id}`)
  return m
}

export const EXPIRY_CHOICES: Array<{ label: string; ms: number | null }> = [
  // Never is the default: a demo link that dies in 48 hours is a demo link that
  // dies in the middle of someone's trial. The 48-hour option is kept because
  // it was the only behaviour the old ephemeral panel offered, and a one-off
  // send is a real use for it.
  { label: 'Never', ms: null },
  { label: '48 hours', ms: 48 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 }
]

/** Resolve an expiry choice to an absolute timestamp. */
export function expiryAt(ms: number | null, now: number = Date.now()): number | null {
  return ms === null ? null : now + ms
}
