/**
 * Visual smoke test: design-token migration of PlexiSuiteHome + ProductHome.
 * Confirms the launcher renders, product navigation works, and planned tiles
 * still show their status badge. No pixel audit — render + navigation only.
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

test('1. PlexiSuite home renders: hero, product tiles, no blank screen', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Navigate to PlexiSuite home
    await window.getByRole('button', { name: 'PlexiiSuite' }).first().click()
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8000 })

    // Hero wordmark
    await expect(window.locator('[data-testid="hero-plexidesk"]')).toBeVisible({ timeout: 5000 })

    // At least one product tile is visible
    await expect(window.locator('[data-testid="product-tile-plexisearch"]')).toBeVisible({ timeout: 5000 })

    // No JS errors at this point — confirmed by the view rendering (a crash would leave a blank)
  } finally {
    await dispose()
  }
})

test('2. Product home renders and Open button navigates to product view', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await window.getByRole('button', { name: 'PlexiiSuite' }).first().click()
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8000 })

    // Click a ready product tile
    await window.locator('[data-testid="product-tile-plexisearch"]').click()
    await expect(window.locator('[data-testid="product-home-plexisearch"]')).toBeVisible({ timeout: 6000 })

    // The product home must have content (hero + some card structure — not blank)
    const homeText = await window.locator('[data-testid="product-home-plexisearch"]').innerText()
    expect(homeText.length).toBeGreaterThan(10)

    // Open button navigates to the product view
    await window.locator('[data-testid="open-plexisearch"]').click()
    await expect(window.locator('[data-testid="plexisearch-view"]')).toBeVisible({ timeout: 6000 })
  } finally {
    await dispose()
  }
})

test('3. Coming-soon tile renders status badge and upvote affordance', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await window.getByRole('button', { name: 'PlexiiSuite' }).first().click()
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8000 })

    // plexiops is the only planned product in the suite catalog (status: 'planned').
    // Its tile renders greyed with a status badge and an UpvoteButton.
    // UpvoteButton carries data-testid="upvote-plexiops".
    const tile = window.locator('[data-testid="product-tile-plexiops"]')
    await expect(tile).toBeVisible({ timeout: 5000 })

    // Status badge text (STATUS_LABEL['planned'] = 'Planned')
    await expect(tile).toContainText(/planned/i)

    // Upvote affordance rendered inside the tile
    const upvoteBtn = window.locator('[data-testid="upvote-plexiops"]')
    await expect(upvoteBtn).toBeVisible({ timeout: 3000 })
  } finally {
    await dispose()
  }
})
