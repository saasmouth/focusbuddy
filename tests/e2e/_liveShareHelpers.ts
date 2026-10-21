import { expect, type Page } from '@playwright/test'

// Live sharing through the real Share sheet, as a person does it today.
//
// The sheet's "Specific people" section (LiveDeskSharing) used to be a bare
// email field and an Add button (livedesk-email / livedesk-add). It is now
// SharePeoplePicker: type into the search, pick the person (a directory member,
// or "Invite <email>" for someone outside the directory), then press Share.
// Every live-sharing spec goes through here so the next change to that picker
// is one edit, not six.

/** Open the Share sheet for a desk from its card in the Desks index. */
export async function openDeskShareSheet(window: Page, deskId: string): Promise<void> {
  // The desk sidebar's "All desks" row. Scoped to the sidebar: on Home the
  // hero and the dashboard rail carry an "All desks" button too, and an
  // unscoped role query matches all three.
  await window.locator('[data-testid="desk-sidebar"]').getByRole('button', { name: 'All desks', exact: true }).click()
  await expect(window.locator('[data-testid="desks-index-view"]')).toBeVisible({ timeout: 8_000 })
  const card = window.locator(`[data-testid="index-card-${deskId}"]`)
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('button[title="Create a public link — anyone with it can view this desk"]').click()
  await expect(window.getByText('Live sharing (real-time)')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="share-picker-search"]')).toBeVisible()
}

/** Stage one person by email: a directory match if there is one, else an email invite. */
export async function stagePersonByEmail(window: Page, email: string): Promise<void> {
  await window.locator('[data-testid="share-picker-search"]').fill(email)
  const member = window.locator('[data-testid="share-picker-member"]').filter({ hasText: email })
  const invite = window.locator('[data-testid="share-picker-invite-email"]')
  const pick = member.or(invite).first()
  await expect(pick).toBeVisible({ timeout: 5_000 })
  await pick.click()
  await expect(window.locator('[data-testid="share-picker-chips"]')).toBeVisible()
  await expect(window.locator('[data-testid="share-picker-submit"]')).toBeEnabled()
}

/**
 * Share the open sheet's desk live with an existing account, and wait for the
 * grant. An existing account is granted at once and listed with a "Remove
 * access" control; an address with no account would be listed as pending with
 * "Revoke access" instead, so this also proves the server resolved the person.
 */
export async function shareLiveWithAccount(window: Page, email: string): Promise<void> {
  await stagePersonByEmail(window, email)
  await window.locator('[data-testid="share-picker-submit"]').click()
  await expect(window.getByText('Shared with 1 person.')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('button[title="Remove access"]').first()).toBeVisible({ timeout: 8_000 })
}
