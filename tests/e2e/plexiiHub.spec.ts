import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Plexii AI mission, Phase 1: the hub and its doors.
//
// The hub (view.kind 'plexii') is the existing conversational engine given a
// page in the main pane. These specs drive the three doors this phase built —
// the sidebar tab (with its recent-conversations sublist), the Home hero
// input, and the Home header button — and lock the one-ChatPanel invariant:
// while the hub page shows, the overlay pill is suppressed.
//
// No API key rides in e2e (stripped by _helpers), so a send takes the honest
// no-key path: the user turn renders, the assistant turn carries the failure.
// What matters here is navigation, seeding, persistence and suppression — not
// model output.

test.describe('Plexii hub (Phase 1)', () => {
  let launched: LaunchedApp

  // A fresh profile lands on the Suite launcher, not Home — the Home-door specs
  // walk there first, the way a user's saved view would.
  async function gotoHome(): Promise<void> {
    await launched.window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState().goHome()
    })
    await launched.window.waitForTimeout(300)
  }

  test.beforeEach(async () => {
    launched = await launchApp()
    await waitForReady(launched.window)
  })

  test.afterEach(async () => {
    await launched.dispose()
  })

  test('sidebar tab opens the hub and suppresses the assistant pill', async () => {
    const { window } = launched
    // The pill exists before the hub is open (any non-hub screen).
    await expect(window.locator('[data-testid="assistant-pill"]')).toBeVisible()

    await window.locator('[data-testid="sidebar-plexii"]').click()
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    // The hub hosts the real panel in its page dressing, rail included.
    await expect(window.locator('[data-testid="assistant-panel"]')).toBeVisible()
    await expect(window.locator('[data-testid="conversation-rail"]')).toBeVisible()
    // One ChatPanel instance: the overlay (pill and panel both) is suppressed.
    await expect(window.locator('[data-testid="assistant-pill"]')).toHaveCount(0)
    await expect(window.locator('[data-testid="assistant-overlay"]')).toHaveCount(0)
    // Page mode is a place, not a dressing — no display-mode menu.
    await expect(window.locator('[data-testid="assistant-mode-toggle"]')).toHaveCount(0)
  })

  test('home hero input seeds a conversation and lands in the hub', async () => {
    const { window } = launched
    await gotoHome()
    const input = window.locator('[data-testid="start-or-ask-input"]')
    await input.waitFor({ state: 'visible' })
    await input.click()
    await input.fill('Plan a wedding')
    await window.locator('[data-testid="start-or-ask-go"]').click()

    // Landed on the hub with the typed message already sent as the first turn.
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    await expect(window.locator('[data-testid="user-turn"]').first()).toContainText(
      'Plan a wedding'
    )
    // The send minted a persisted conversation; the hub's rail lists it.
    await expect(
      window.locator('[data-testid="conversation-row"]').first()
    ).toContainText('Plan a wedding', { timeout: 10_000 })
  })

  test('the assistant panel is where conversations are found and reopened', async () => {
    const { window } = launched
    // Seed one conversation through the hero door.
    await gotoHome()
    const input = window.locator('[data-testid="start-or-ask-input"]')
    await input.waitFor({ state: 'visible' })
    await input.fill('Track job applications')
    await window.locator('[data-testid="start-or-ask-go"]').click()
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    await expect(
      window.locator('[data-testid="conversation-row"]').first()
    ).toContainText('Track job applications', { timeout: 10_000 })

    // The nav carries no conversation rows any more (2026-10-08). History is
    // the assistant's, so this is the assertion that the move actually
    // happened rather than being duplicated in two places.
    await expect(window.locator('[data-testid="sidebar-plexii-conversation"]')).toHaveCount(0)

    // Walk away from the hub so the only chat on screen is the panel's.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState().goHome()
    })
    await expect(window.locator('[data-testid="plexii-hub"]')).toHaveCount(0)

    // Open the assistant in sidebar mode — the mode with no rail, which is
    // exactly the case that had no door to history before.
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbAssistantChrome?: {
          getState: () => {
            openPanel: () => void
            setMode: (m: string) => void
            setTab: (t: string) => void
          }
        }
      }
      const st = w.__fbAssistantChrome?.getState()
      st?.setMode('sidebar')
      st?.setTab('chat')
      st?.openPanel()
    })
    await expect(window.locator('[data-testid="assistant-panel"]')).toBeVisible()
    await expect(window.locator('[data-testid="conversation-rail"]')).toHaveCount(0)

    // The header button opens the list; search narrows it, which is the whole
    // reason the list moved here.
    await window.locator('[data-testid="assistant-history-toggle"]').click()
    const list = window.locator('[data-testid="conversation-overlay"]')
    await expect(list).toBeVisible()
    await list.locator('[data-testid="conversation-search"]').fill('job applications')
    await expect(list.locator('[data-testid="conversation-row"]')).toHaveCount(1)
    await list.locator('[data-testid="conversation-row"]').first().click()

    // Picking dismisses the overlay and lands on the thread.
    await expect(list).toHaveCount(0)
    await expect(window.locator('[data-testid="user-turn"]').first()).toContainText(
      'Track job applications'
    )
  })

  test('Escape and the close button both dismiss the history overlay', async () => {
    const { window } = launched
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbAssistantChrome?: {
          getState: () => {
            openPanel: () => void
            setMode: (m: string) => void
            setTab: (t: string) => void
          }
        }
      }
      const st = w.__fbAssistantChrome?.getState()
      st?.setMode('sidebar')
      st?.setTab('chat')
      st?.openPanel()
    })
    const list = window.locator('[data-testid="conversation-overlay"]')

    await window.locator('[data-testid="assistant-history-toggle"]').click()
    await expect(list).toBeVisible()
    await list.locator('[data-testid="conversation-close"]').click()
    await expect(list).toHaveCount(0)

    await window.locator('[data-testid="assistant-history-toggle"]').click()
    await expect(list).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
  })

  // ── Phase 4: interactive blocks ──────────────────────────────────────────

  test('interactive choice blocks render and a tap sends the selection', async () => {
    const { window } = launched
    await window.locator('[data-testid="sidebar-plexii"]').click()
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()

    // Seed an assistant turn carrying a choices block straight into the store
    // (the same __fbChat handle the harness exposes for e2e), so the render +
    // interaction path is exercised without a live model call.
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbChat?: {
          setState: (s: Record<string, unknown>) => void
        }
      }
      const ts = Date.now()
      w.__fbChat?.setState({
        activeConversationId: null,
        messagesByTask: {
          __new__: [{ role: 'assistant', content: 'Which direction should we take?', ts }]
        },
        blocksByMessage: {
          [String(ts)]: [
            {
              type: 'choices',
              id: 'c1',
              prompt: 'Pick a direction',
              options: [
                { id: 'a', label: 'Podcast studio', icon: 'mic' },
                { id: 'b', label: 'Newsletter', icon: 'edit_note' }
              ]
            },
            { type: 'cards', items: [{ icon: 'rocket_launch', title: 'Launch week', body: 'Plan the drop' }] }
          ]
        }
      })
    })

    await expect(window.locator('[data-testid="ui-block-choices"]')).toBeVisible()
    await expect(window.locator('[data-testid="ui-block-cards"]')).toBeVisible()
    const options = window.locator('[data-testid="ui-choice-option"]')
    await expect(options).toHaveCount(2)
    // Tapping an option sends it as the user's next message.
    await options.filter({ hasText: 'Podcast studio' }).click()
    await expect(
      window.locator('[data-testid="user-turn"]').filter({ hasText: 'Podcast studio' })
    ).toBeVisible({ timeout: 8_000 })
  })

  // ── Phase 5: push to desk + conversation linking ─────────────────────────

  test('a desk the conversation produces links to it and survives reopening', async () => {
    const { window } = launched
    // Seed a real persisted conversation through the hero door (the send fails
    // for want of a key, which is fine — the conversation row is what we need).
    await gotoHome()
    const input = window.locator('[data-testid="start-or-ask-input"]')
    await input.waitFor({ state: 'visible' })
    await input.fill('Plan a supper club')
    await window.locator('[data-testid="start-or-ask-go"]').click()
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    await expect(
      window.locator('[data-testid="conversation-row"]').first()
    ).toContainText('Plan a supper club', { timeout: 10_000 })

    // Before any desk exists, the persistent out offers to make one.
    const deskButton = window.locator('[data-testid="chat-turn-into-desk"]')
    await expect(deskButton).toContainText('Turn into desk')

    // Seed an assistant turn carrying a create-task proposal onto the live
    // conversation, so applying it exercises the real executor + link path
    // without a model call.
    await window.evaluate(() => {
      const w = window as unknown as {
        __fbChat?: {
          getState: () => {
            activeConversationId: string | null
            messagesByTask: Record<string, unknown[]>
          }
          setState: (s: Record<string, unknown>) => void
        }
      }
      const st = w.__fbChat?.getState()
      const convId = st?.activeConversationId
      if (!convId) throw new Error('expected a persisted conversation')
      const ts = Date.now()
      const existing = st.messagesByTask[convId] ?? []
      w.__fbChat?.setState({
        messagesByTask: {
          ...st.messagesByTask,
          [convId]: [...existing, { role: 'assistant', content: 'Here is the desk.', ts }]
        },
        proposalsByMessage: {
          [String(ts)]: [
            { id: 'mk-desk', kind: 'create-task', title: 'Supper club', reason: 'the workspace' }
          ]
        }
      })
    })

    // Apply the card — the whole card is the apply button.
    await window.locator('[data-testid="proposal-card-mk-desk"]').click()

    // The produced desk pins to the conversation, and the out becomes a push.
    const chip = window.locator('[data-testid="chat-linked-desk"]')
    await expect(chip).toBeVisible({ timeout: 10_000 })
    await expect(chip).toContainText('Supper club')
    await expect(deskButton).toContainText('Push to desk')

    // The link is durable: leave, come back through history, chip is still there.
    await window.locator('[data-testid="conversation-new"]').click()
    await expect(window.locator('[data-testid="chat-linked-desk"]')).toHaveCount(0)
    await window.locator('[data-testid="conversation-row"]').first().click()
    await expect(window.locator('[data-testid="chat-linked-desk"]')).toContainText('Supper club', {
      timeout: 10_000
    })
  })

  // ── Phase 6: discovery mode + the Home icon verb ─────────────────────────

  test('the Discover icon starts a guided discovery in the hub', async () => {
    const { window } = launched
    await gotoHome()
    // Place the Discover icon widget from the gallery.
    await window.locator('[data-testid="home-customize-toggle"]').click()
    await window.locator('[data-testid="home-add-widget"]').click()
    // A gallery tile opens its detail pane; Add places it, then leave customize.
    await window.locator('[data-testid="home-gallery-discover"]').click()
    await window.locator('[data-testid="home-picker-add"]').click()
    await window.locator('[data-testid="home-customize-toggle"]').click()

    const discover = window.locator('[data-testid="home-discover-start"]')
    await expect(discover).toBeVisible({ timeout: 8_000 })
    await discover.click()

    // Lands on the hub, in discovery, with the mode's own opening.
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    await expect(window.locator('[data-testid="chat-mode-badge"]')).toBeVisible()
    await expect(window.locator('[data-testid="assistant-home"]')).toContainText(
      'What are we building?'
    )
  })

  test('discovery is a mode you can enter and leave in any conversation', async () => {
    // A4 (R19): the control is the conversation-mode chip on the composer —
    // a deliberate pick from its menu, sticky on the conversation. The header
    // keeps only the informational badge.
    const { window } = launched
    await window.locator('[data-testid="sidebar-plexii"]').click()
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    // A normal chat carries no badge, and the chip wears the default mode.
    await expect(window.locator('[data-testid="chat-mode-badge"]')).toHaveCount(0)
    const chip = window.locator('[data-testid="chat-mode-chip"]')
    await expect(chip).toContainText('Chat')
    await chip.click()
    await window.locator('[data-testid="chat-mode-option-discovery"]').click()
    await expect(window.locator('[data-testid="chat-mode-badge"]')).toBeVisible()
    await expect(chip).toContainText('Discovery')
    // And out again — the mode is never a one-way door.
    await chip.click()
    await window.locator('[data-testid="chat-mode-option-chat"]').click()
    await expect(window.locator('[data-testid="chat-mode-badge"]')).toHaveCount(0)
    await expect(chip).toContainText('Chat')
  })

  // ── Phase 2: consolidation + the Plexii name ─────────────────────────────

  test('cmd-shift-K toggles the hub and the header Build button is gone', async () => {
    const { window } = launched
    await gotoHome()
    // The retired one-shot command bar's header trigger must not exist.
    await expect(window.getByRole('button', { name: 'Build with AI' })).toHaveCount(0)
    // The shortcut opens the hub...
    await window.keyboard.press('Meta+Shift+K')
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    // ...and pressed again steps back out.
    await window.keyboard.press('Meta+Shift+K')
    await expect(window.locator('[data-testid="plexii-hub"]')).toHaveCount(0)
  })

  test('the assistant surfaces carry the Plexii name', async () => {
    const { window } = launched
    await window.locator('[data-testid="sidebar-plexii"]').click()
    // DEC-120 replaced the "Plexii" <h2> with the animated wordmark, and this
    // assertion went on asking for the heading — so it had been red ever
    // since, for a reason that was never a bug in the app. The name now lives
    // on the mark itself (PlexiiMark: role="img" aria-label="Plexii"), which
    // is both what a screen reader needs and what makes this checkable.
    await expect(window.getByRole('img', { name: 'Plexii', exact: true }).first()).toBeVisible()
    // The retired names are gone from the chrome.
    await expect(window.getByRole('heading', { name: 'Assistant', exact: true })).toHaveCount(0)
    await expect(window.getByText('Ask PlexiBrain')).toHaveCount(0)
  })

  test('the hub opens, and leaving restores the pill', async () => {
    // The home header's Ask Plexii button was removed by ruling (2026-08-24);
    // the omnibar pill is the one door from home. This test's subject is the
    // hub's open/leave behaviour, so it now enters through the store the way
    // every remaining door does.
    const { window } = launched
    await gotoHome()
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goPlexii: () => void } } }
      w.__fbView?.getState().goPlexii()
    })
    await expect(window.locator('[data-testid="plexii-hub"]')).toBeVisible()
    // Leave the hub: the overlay pill comes back exactly as it was.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
      w.__fbView?.getState().goHome()
    })
    await expect(window.locator('[data-testid="assistant-pill"]')).toBeVisible()
  })
})
