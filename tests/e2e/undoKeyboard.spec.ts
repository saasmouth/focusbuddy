import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// The real keyboard path for the unified undo: create a folder through the actual
// sidebar dialog (which records an undo via the node store), then Cmd-Z removes
// it and Cmd-Shift-Z brings it back. Proves the global handler -> action history
// -> store -> DB chain works end to end through genuine UI, not just the API.

test('UNDO-KEY — create via UI, Cmd-Z removes it, Cmd-Shift-Z restores it', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const name = `UndoKey ${Date.now()}`

    // The sidebar opens the create dialog on this command event.
    await window.evaluate(() => window.dispatchEvent(new Event('fb:command-new-task')))
    const nameInput = window.getByTestId('newnode-name')
    await expect(nameInput).toBeVisible({ timeout: 5000 })
    await nameInput.fill(name)
    await window.keyboard.press('Enter') // submits the form -> store.create (records undo)

    // It shows up in the sidebar.
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 5000 })

    // Creating a desk opens it and offers to set it up ("Let me set up your
    // desk", on by default since 994b9eb3, and ai_task_setup is on every
    // tier), and that dialog names the desk: "for: <name>".
    const setup = window.getByRole('dialog', { name: 'Let me set up your desk' })
    await expect(setup).toBeVisible({ timeout: 5000 })
    await expect(setup).toContainText(`for: ${name}`)

    // Drop focus off any text field so Cmd-Z hits the global structural-undo
    // handler (it deliberately yields to inputs/editors).
    await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    await window.keyboard.press('Meta+KeyZ')
    // Undoing the create removes the desk, and with it the dialog offering to
    // set that desk up. It used to stay open, still reading "for: <the desk
    // that is gone>" (and so this very assertion failed on it).
    await expect(setup).toHaveCount(0, { timeout: 5000 })
    await expect(window.getByText(name)).toHaveCount(0, { timeout: 5000 })

    await window.keyboard.press('Meta+Shift+KeyZ')
    await expect(window.getByText(name).first()).toBeVisible({ timeout: 5000 })

    // TEXT-FIELD YIELD: Cmd-Z while focus is in a text input must do the input's
    // own native undo, NOT the structural node undo — so the folder we created
    // stays put while the typed text is what gets undone.
    await window.evaluate(() => window.dispatchEvent(new Event('fb:command-new-task')))
    const typing = window.getByTestId('newnode-name')
    await expect(typing).toBeVisible({ timeout: 5000 })
    await typing.fill('temporary typing')
    await typing.press('Meta+KeyZ') // focus is in the input -> native text undo
    await expect(window.getByText(name).first()).toBeVisible() // structural undo did NOT fire
    await typing.press('Escape')
  } finally {
    await dispose()
  }
})
