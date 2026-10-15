# 4.3.28 — manual test script

Written for: you, running the locally installed build. Roughly 20 minutes.

Everything below is a change in this build. Where a step says **"was broken"**,
that is the old behaviour you should *not* see any more.

Install: `/Applications/PlexiDesk 4.3.28.app`.

---

## 0. It starts at all (2 min) — the Electron 44 check

This build jumped seven browser-engine versions. Nothing below matters if this
step fails, so do it first.

1. Launch PlexiDesk 4.3.28. It should open normally — no bouncing-then-dead
   dock icon, no "not responding".
2. Open a desk you already had. **Your data must still be there**: desks,
   widgets, documents, connected apps. (The database layer changed with the
   upgrade, so this is the one with real consequences.)
3. Open **Settings › About** (or the changelog) and confirm it reads 4.3.28.

> If the app does not start, stop and tell me — do not keep testing. The
> previous build is recoverable.

**Then exercise the things the engine upgrade touches most:**

4. Open a connected app from the side menu. It should load and still be signed
   in — sessions carry over.
5. Export something to PDF: open a Doc → **File › Export › PDF**. The margin
   API changed in this upgrade, so check the page isn't clipped or oddly
   margined.
6. Mirror a screen onto a desk with audio (Add widget → screen mirror). Sound
   should come through. *Was broken-in-waiting:* the new engine needs a
   permission string macOS didn't previously require; without it the audio
   would have gone silently missing.

---

## 1. Side menu colour (3 min)

1. Open the side menu. Under **Desk**, confirm each row has its own coloured,
   filled icon:
   - Home — indigo
   - Attention — **amber** (*was: teal, borrowed from Desks*)
   - Rooms — teal
   - Desks — sky
   - Shared — violet
   - Trash — slate, deliberately drab
2. Expand **Attention** (the chevron on its row). The six filters should each
   have their own colour, reading as a temperature:
   Open sky · Due today amber · **Overdue red** · In progress blue ·
   Waiting grey · **Closed 7d green**.
   *Was broken:* all six were the same colour, so six different questions
   looked like one row repeated.
3. Collapse the sidebar to the narrow rail. **The colours must be the same
   ones** — a destination cannot change colour with the sidebar width.
   *Was broken:* the rail was a column of grey glyphs.
4. Scroll the whole menu. Nothing should be grey-on-grey; the desk half and
   the apps half should read as one list.

---

## 2. Connected apps belong to an organisation (5 min)

This is the one with a real consequence if it is wrong, so it is worth doing
properly.

1. In **Personal**, open the side menu → **Apps**. The Connected apps heading
   should read **"Connected apps — all accounts"**, with a **+** beside it.
2. Click the **+**. The dialog header should say *"Connecting to your personal
   account"*. Add any app. It should open straight after being added.
3. Switch to an organisation (the workspace switcher). The heading should now
   read **"Connected apps — <that org>"**, and you should see **only that
   org's apps**.
4. With the org active, click **+** and connect **the same app you added in
   Personal** (same URL). It must create a **second, separate** entry.
   *Was broken:* it silently reused the Personal entry — the same row, the same
   saved login, the same signed-in session — so you would believe you had
   connected a second account and would in fact be looking at the first.
5. Sign in to that app inside the org. Switch back to Personal and open your
   Personal copy of the same app. **The two must be different sessions.**
6. Still in Personal, confirm each tile now shows a small org label underneath
   saying which account it is. In an org, that label should be absent (there it
   would be noise).
7. Rename or delete an app while an org is active, then switch to Personal and
   confirm you changed the right one.

---

## 3. Unread counts: messages, not conversations (3 min)

1. Have WhatsApp (or any messaging app) connected with notifications on, and
   get **more than one unread message in a single conversation**.
2. Wait for a background check — up to ~5 minutes, or reopen the app to force
   one.
3. The side-menu badge should show the **total messages**, not the number of
   conversations. *Was broken:* 5 unread in one chat reported as **1**.
4. Hover the badge. The tooltip should say which it is counting — *"5 unread
   messages — signed in, checked just now"*. Where the app only publishes a
   vaguer number it should say plainly "5 unread" rather than claiming either.
5. Sign out of that app. The badge should go grey with a **moon**, and the
   tooltip should say the count is not current. Signed in, it is a green count
   with a **yellow sun**.

---

## 4. Top toolbar: tooltips and the assistant (3 min)

1. Hover each button in the top-right toolbar — status, Focus, Chat, Meeting,
   Tidy, Build, Template, Resume, search, settings. **Every one** should show a
   styled tooltip after a short pause.
   *Was broken:* most had only a slow system tooltip, and several showed
   nothing at all.
2. Open the AI assistant (fullscreen or the right-side panel). Hover those same
   buttons again. **The tooltips must appear on top of the assistant**, and the
   buttons must stay clickable. *Was broken:* the toolbar sat below the
   assistant in stacking order.
3. With the assistant open, click a toolbar button that opens a menu (status,
   or Tidy). **The menu must paint over the assistant, not behind it.**
4. Drag the desk pill away from the header so it floats, then to a side edge so
   it goes vertical. The same buttons, with the same tooltips, in all three
   layouts. *Was broken:* the vertical layout was a separate copy of the code
   and kept the old tooltips.

---

## 5. Vault unlock with Touch ID (4 min)

1. Open **Apps › Vault** and unlock it with your master password.
2. You should see a **"Faster ways to unlock"** panel. Read what it says about
   Touch ID: it should tell you plainly that this is a *convenience gate, not
   extra encryption*, because the key is kept in your login keychain rather
   than the Secure Enclave. If that text is missing or overclaims, say so —
   it's the point of the panel.
3. Click **Set up**. Approve the Touch ID prompt.
4. **Lock** the vault. The unlock screen should now offer **"Unlock with Touch
   ID"** above the password field — with the password field still right there,
   not hidden behind a "use password instead" link.
5. Unlock with your fingerprint. It should open.
6. Cancel a Touch ID prompt deliberately. It should fail quietly and leave you
   on the password field — no error banner, no buzz.
7. **The important one:** change your master password (Vault → Change
   password). Then lock, and unlock with Touch ID again. **It should still
   work** without you setting it up again. *The old key is useless after a
   rotation, so the app drops it and re-enrols while the vault is still open.*
8. Turn Touch ID off. The unlock screen should go back to password-only.

---

## What I could not test for you

- **Steps 2.4–2.5** need a real second organisation with real accounts. I
  verified the scoping at the data layer and in tests; I could not verify the
  lived experience of two signed-in accounts.
- **Step 3** needs your WhatsApp. The message-sum reads the per-conversation
  counts an app publishes for screen readers; I verified the summing and the
  no-double-counting rule against constructed cases, but not against WhatsApp's
  live page, which I cannot sign in to. **If the badge is still wrong, tell me
  what it shows versus what it should, and I'll read the page's actual markup.**
- **Step 5** needs your fingerprint. The enrolment and rotation logic is
  covered by tests; the prompt itself I cannot trigger.
- **Step 0.6** needs audio playing on a real screen share.

## Known, not fixed in this build

A help-centre audit raised ~100 further defects — unenforced paid-plan gates,
features listed in pricing that do not exist, several data-loss paths. They are
recorded in `docs/HELP-AUDIT-BACKLOG-2026-10-15.md` and none are addressed
here.
