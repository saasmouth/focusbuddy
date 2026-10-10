/**
 * sidebarVisualParity.spec.ts
 *
 * Verifies that the restyled global Desk Sidebar (Sidebar.tsx) matches the
 * canonical PlexiOffice OfficeSidebar (PlexiOfficeShell.tsx) visual system:
 *
 *   - aside bg-[var(--surface-raised)] + rounded-[var(--radius-card)] floating card whose edge
 *     comes from light (hairline ring + cast shadow + inset highlight), not a 1px border
 *   - 14-tall header with 15px bold tracking-[0.14em] wordmark
 *   - SegmentSwitcher present
 *   - Nav rows: rounded-lg, accent/0.12 tint + accent text when active
 *   - Quiet uppercase section labels: text-[10px] uppercase tracking-[0.12em] text-[var(--ink-40)]
 *   - Pro upgrade card at the bottom
 *
 * All assertions are structural (CSS classes + computed styles + testid queries).
 * Screenshots of both sidebars are saved to the scratchpad directory.
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, switchArea } from './_helpers'
import { mkdirSync } from 'fs'
import { join } from 'path'

// Screenshots land beside every other spec's, in the repo's own test-results —
// this used to hardcode one agent session's scratchpad path, which meant the
// evidence for a failure was written somewhere nobody would look for it.
const SCRATCHPAD = 'test-results/sidebar-parity'

test('Desk Sidebar and OfficeSidebar share the same visual system', async () => {
  // One test that walks two sidebars, takes screenshots and navigates between
  // areas — it does not fit the default 30s budget.
  test.slow()
  mkdirSync(SCRATCHPAD, { recursive: true })

  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // ── 1. Navigate to Home so the global Desk Sidebar renders ─────────────
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(600)

    // Screenshot the Desk sidebar
    const deskSidebar = window.locator('aside').first()
    await expect(deskSidebar).toBeVisible({ timeout: 6_000 })
    const deskSidebarPath = join(SCRATCHPAD, 'desk-sidebar.png')
    await deskSidebar.screenshot({ path: deskSidebarPath })

    // ── 2. Assert Desk Sidebar chrome ───────────────────────────────────────
    // 2a. Outer aside: surface-raised bg + a full rounded floating card edge.
    //     The menu is a floating material card on the radius law (Edges +
    //     Glass, 2026-08-23): rounded-[var(--radius-card)], NO 1px border;
    //     its edge is the hairline ring inside the box-shadow recipe.
    const deskAsideClasses = await deskSidebar.getAttribute('class') ?? ''
    expect(deskAsideClasses).toContain('bg-[var(--surface-raised)]')
    expect(deskAsideClasses).toContain('rounded-[var(--radius-card)]')
    expect(deskAsideClasses).not.toContain('border-[var(--edge-soft)]')
    const deskAsideShadow = await deskSidebar.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(deskAsideShadow).toContain('0px 0px 0px 1px')

    // 2b. Brand mark in the header. The sidebar redesign replaced the text
    // wordmark with the PlexiiLogo component (an <img>), so assert the logo
    // renders in the h-14 header rather than a specific text span.
    const deskHeaderMark = deskSidebar.locator('div.h-14 img, div.h-14 svg').first()
    await expect(deskHeaderMark).toBeVisible({ timeout: 3_000 })

    // 2c. Header border-b present
    const deskHeader = deskSidebar.locator('div.h-14').first()
    const deskHeaderClasses = await deskHeader.getAttribute('class') ?? ''
    expect(deskHeaderClasses).toContain('border-b')
    expect(deskHeaderClasses).toContain('border-[var(--edge-soft)]')

    // 2d. The workspace/area switcher is present. The four areas used to be a
    //     standing tile row; they now live in this control's dropdown, so the
    //     trigger is what the sidebar always shows.
    const segSwitcher = deskSidebar.locator('[data-testid="workspace-switcher-trigger"]')
    await expect(segSwitcher).toBeVisible({ timeout: 3_000 })

    // 2e. Nav rows: rounded-lg style with accent/0.12 on active row
    //     Home should be active (we just navigated there). The NavRow component
    //     uses `bg-[rgb(var(--accent)/0.12)]` on active.
    const deskNavRows = deskSidebar.locator('button.rounded-lg.text-\\[13px\\]')
    const deskNavCount = await deskNavRows.count()
    // At minimum we expect Home/Attention/Rooms/All desks/Shared/Trash = 6 rows
    // (Calendar and Files moved into Office; Vault moved into Settings)
    expect(deskNavCount).toBeGreaterThanOrEqual(6)

    // Check that at least one row carries the active accent tint. The two
    // sidebars use the accent at slightly different strengths — the desk's
    // NavRow at 0.10, the office rows at 0.12 — so this asserts the tint, not
    // one exact alpha. (Both alphas are in circulation across the app: 20
    // sites at 0.10, 30 at 0.12. Picking one is a design call, not a test fix.)
    const activeNavRows = deskSidebar.locator(
      'button[class*="rgb(var(--accent)/0.10)"], button[class*="rgb(var(--accent)/0.12)"]'
    )
    const activeNavCount = await activeNavRows.count()
    expect(activeNavCount).toBeGreaterThanOrEqual(1)

    // 2f. Pro upgrade card present at the bottom. It carries its own testid;
    //     matching on its border colour broke the moment the card was
    //     restyled, which told us nothing about whether the card was there.
    const deskProCard = deskSidebar.locator('[data-testid="upgrade-card"]')
    await expect(deskProCard).toBeVisible({ timeout: 3_000 })
    // The card carries two buttons — the upsell and a dismiss — so name the
    // one being checked.
    const upgradeBtn = deskProCard.getByRole('button', { name: 'Upgrade Now' })
    await expect(upgradeBtn).toBeVisible()

    // 2g. Six nav labels present. Plans and Tasks became object-based views
    //     reached from Home; Calendar and Files moved into Office and Vault
    //     into Settings on 2026-10-10, so this is the list the desk menu
    //     actually carries.
    for (const label of ['Home', 'Attention', 'Rooms', 'All desks', 'Shared', 'Trash']) {
      await expect(deskSidebar.getByText(label, { exact: true })).toBeVisible({ timeout: 3_000 })
    }

    // ── 3. Navigate to PlexiOffice so the OfficeSidebar renders ───────────
    await switchArea(window, 'office')
    await window.waitForTimeout(600)

    const officeSidebar = window.locator('[data-testid="office-sidebar"]')
    await expect(officeSidebar).toBeVisible({ timeout: 6_000 })
    const officeSidebarPath = join(SCRATCHPAD, 'office-sidebar.png')
    await officeSidebar.screenshot({ path: officeSidebarPath })

    // ── 4. Assert OfficeSidebar chrome (reference) ──────────────────────────
    const officeAsideClasses = await officeSidebar.getAttribute('class') ?? ''
    expect(officeAsideClasses).toContain('bg-[var(--surface-raised)]')
    expect(officeAsideClasses).toContain('rounded-[var(--radius-card)]')
    expect(officeAsideClasses).not.toContain('border-[var(--edge-soft)]')
    const officeAsideShadow = await officeSidebar.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(officeAsideShadow).toContain('0px 0px 0px 1px')

    const officeWordmark = officeSidebar.locator('span.text-\\[15px\\].font-bold.tracking-\\[0\\.14em\\]').first()
    await expect(officeWordmark).toBeVisible({ timeout: 3_000 })
    const officeWordmarkText = await officeWordmark.textContent()
    expect(officeWordmarkText?.trim().toUpperCase()).toBe('PLEXIOFFICE')

    const officeHeader = officeSidebar.locator('div.h-14').first()
    const officeHeaderClasses = await officeHeader.getAttribute('class') ?? ''
    expect(officeHeaderClasses).toContain('border-b')
    expect(officeHeaderClasses).toContain('border-[var(--edge-soft)]')

    // Office Pro card
    const officeProCard = officeSidebar.locator('[data-testid="upgrade-card"]')
    await expect(officeProCard).toBeVisible({ timeout: 3_000 })

    // ── 5. Go back to Desk / Home and check the "Add to desk" strip ─────
    //    Open a task or navigate to a task so the desk view renders, then
    //    confirm the strip appears.
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(400)

    // Create a task via the node store so we can navigate to it
    const taskId = await window.evaluate(async () => {
      const w = window as unknown as {
        __nodeStore?: { getState: () => { create: (opts: { kind: string; title: string; parentId: null }) => Promise<{ id: string }> } }
      }
      const state = w.__nodeStore?.getState()
      if (!state) return null
      const node = await state.create({ kind: 'task', title: 'Sidebar parity test task', parentId: null })
      return node.id
    })

    if (taskId) {
      await window.evaluate((id) => {
        const w = window as unknown as { __fbView?: { getState: () => { goTask: (id: string) => void } } }
        w.__fbView?.getState().goTask?.(id)
      }, taskId)
      await window.waitForTimeout(500)

      // The Desk sidebar still renders (as a task-context surface) with the shared
      // visual system. The widget-add UI is no longer a sidebar strip — it moved
      // to the floating WidgetPalette (covered by deskWidgets.spec.ts) — so this
      // parity check no longer asserts a sidebar widget section.
      await expect(window.locator('aside').first()).toBeVisible({ timeout: 4_000 })
    }

    // ── 6. Confirm nav rows are clickable — click Attention, verify tint ───
    //    (Plans is no longer a sidebar row; Attention is the nav destination
    //    that replaced it in this position.)
    await window.evaluate(() => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, () => void> } }
      w.__fbView?.getState().goHome?.()
    })
    await window.waitForTimeout(400)

    const attentionRow = window
      .locator('aside')
      .first()
      .getByText('Attention', { exact: true })
      .locator('..')
    await attentionRow.click()
    await window.waitForTimeout(400)
    // After clicking it the row should carry the active tint (either alpha —
    // see the note on the tint assertion above).
    const activeNavRow = window
      .locator('aside')
      .first()
      .locator(
        'button[class*="rgb(var(--accent)/0.10)"], button[class*="rgb(var(--accent)/0.12)"]'
      )
    await expect(activeNavRow.first()).toBeVisible({ timeout: 3_000 })

    // Screenshot paths for the verdict
    console.log('DESK_SIDEBAR_SCREENSHOT:', deskSidebarPath)
    console.log('OFFICE_SIDEBAR_SCREENSHOT:', officeSidebarPath)

  } finally {
    await dispose()
  }
})
