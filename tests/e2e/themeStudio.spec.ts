import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Theme studio: open from Settings → switch the interface font (a curated a11y
// face) and set a custom accent colour. Both apply live to the document root
// (--font-sans / data-font, --accent / data-accent), proving the reskin is real
// and not just stored.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('theme studio switches the UI font and sets a custom accent live', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Open Settings, then the Theme studio.
  await window.getByRole('button', { name: 'Appearance settings' }).click()
  await window.locator('[data-testid="open-theme-studio"]').click()
  await expect(window.locator('[data-testid="theme-builder"]')).toBeVisible()

  // Switch to Atkinson Hyperlegible.
  await window.locator('[data-testid="themestudio-font-atkinson"]').click()
  await window.waitForTimeout(150)
  const fontState = await window.evaluate(() => {
    const root = document.documentElement
    return {
      dataFont: root.getAttribute('data-font'),
      fontSans: getComputedStyle(root).getPropertyValue('--font-sans')
    }
  })
  expect(fontState.dataFont).toBe('atkinson')
  expect(fontState.fontSans).toContain('Atkinson Hyperlegible')

  // Set a custom accent via the hex field — a colour none of the presets use.
  const hex = window.locator('[data-testid="themestudio-custom-hex"]')
  await hex.fill('#0ea5e9')
  await window.waitForTimeout(200)
  const accentState = await window.evaluate(() => {
    const root = document.documentElement
    return {
      dataAccent: root.getAttribute('data-accent'),
      accent: getComputedStyle(root).getPropertyValue('--accent').trim()
    }
  })
  expect(accentState.dataAccent).toBe('custom')
  // #0ea5e9 → "14 165 233" as the space-separated rgb triplet the tokens use.
  expect(accentState.accent).toBe('14 165 233')

  // Persisted to localStorage so it survives a reload.
  const persisted = await window.evaluate(() => ({
    font: localStorage.getItem('fb.theme.font'),
    accent: localStorage.getItem('fb.theme.accent'),
    custom: localStorage.getItem('fb.theme.customAccent')
  }))
  expect(persisted.font).toBe('atkinson')
  expect(persisted.accent).toBe('custom')
  expect(persisted.custom).toBe('#0ea5e9')
})

test('gemstone theme applies live and re-tints to a gem accent', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.getByRole('button', { name: 'Appearance settings' }).click()
  await window.locator('[data-testid="open-theme-studio"]').click()
  await expect(window.locator('[data-testid="theme-builder"]')).toBeVisible()

  // Selecting Gemstone toggles the .gemstone class onto the document root and
  // resolves to a dark effective theme. The class is what every .gemstone CSS
  // rule keys off, so its presence proves the reskin is live, not just stored.
  await window.locator('[data-testid="themestudio-mode-gemstone"]').click()
  await window.waitForTimeout(700) // ride out the theme ritual veil
  const themeState = await window.evaluate(() => {
    const root = document.documentElement
    const roomOverlay = getComputedStyle(document.body, '::after')
    return {
      hasGemstone: root.classList.contains('gemstone'),
      isDark: root.classList.contains('dark'),
      persisted: localStorage.getItem('fb.theme.mode'),
      roomOverlayImage: roomOverlay.backgroundImage,
      roomOverlayAnimation: roomOverlay.animationName
    }
  })
  expect(themeState.hasGemstone).toBe(true)
  expect(themeState.isDark).toBe(true)
  expect(themeState.persisted).toBe('gemstone')
  // Regression: Gemstone used to draw a fixed repeating-linear-gradient on
  // body::after. Its diagonal lattice crossed every dashboard surface and
  // read as a faint diamond overlay over the whole app.
  expect(themeState.roomOverlayImage).toBe('none')
  expect(themeState.roomOverlayAnimation).toBe('none')

  // The Ruby preset accent (added for Gemstone) resolves to its dark-variant
  // rgb triplet and drives the shared --accent token the whole theme reads.
  await window.locator('[data-testid="themestudio-accent-ruby"]').click()
  await window.waitForTimeout(700)
  const accent = await window.evaluate(() => {
    const root = document.documentElement
    return {
      dataAccent: root.getAttribute('data-accent'),
      accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
      stillGemstone: root.classList.contains('gemstone')
    }
  })
  expect(accent.dataAccent).toBe('ruby')
  expect(accent.accent).toBe('248 113 132') // ruby dark base
  expect(accent.stillGemstone).toBe(true)
})

test('theme studio deep customisation drives background, glass and icon vars', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.getByRole('button', { name: 'Appearance settings' }).click()
  await window.locator('[data-testid="open-theme-studio"]').click()
  await expect(window.locator('[data-testid="theme-builder"]')).toBeVisible()

  // Gradient background → root gets data-desk-bg + a linear-gradient image var.
  await window.locator('[data-testid="themestudio-bg-gradient"]').click()
  await window.waitForTimeout(150)
  const bg = await window.evaluate(() => {
    const root = document.documentElement
    return {
      attr: root.getAttribute('data-desk-bg'),
      image: root.style.getPropertyValue('--fb-desk-bg')
    }
  })
  expect(bg.attr).toBe('1')
  expect(bg.image).toContain('linear-gradient')

  // Glass blur slider drives the shared scale variable.
  await window.locator('[data-testid="themestudio-glass-blur"]').fill('150')
  await window.waitForTimeout(120)
  const blurScale = await window.evaluate(() =>
    document.documentElement.style.getPropertyValue('--fb-glass-blur-scale').trim()
  )
  expect(parseFloat(blurScale)).toBeCloseTo(1.5, 1)

  // Icon weight + outlined style drive the global icon vars.
  await window.locator('[data-testid="themestudio-icon-weight-700"]').click()
  await window.locator('[data-testid="themestudio-icon-fill-outlined"]').click()
  await window.waitForTimeout(120)
  const icon = await window.evaluate(() => {
    const root = document.documentElement
    return {
      wght: root.style.getPropertyValue('--fb-icon-wght').trim(),
      fill: root.style.getPropertyValue('--fb-icon-fill').trim()
    }
  })
  expect(icon.wght).toBe('700')
  expect(icon.fill).toBe('0')

  // Reset clears the custom background entirely.
  await window.locator('[data-testid="themestudio-reset"]').click()
  await window.waitForTimeout(150)
  const afterReset = await window.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-desk-bg'),
    fill: document.documentElement.style.getPropertyValue('--fb-icon-fill').trim()
  }))
  expect(afterReset.attr).toBeNull()
  expect(afterReset.fill).toBe('1')
})
