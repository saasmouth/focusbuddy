// The confirm dialog's default answer (security, 2026-11-20). A question a stranger
// can trigger -- "Sign in to Plexii as <account>?" from a link -- must default to
// Cancel: it takes the first focus and Enter answers no. And Enter on a focused
// button presses THAT button in every dialog: Tab to Cancel, Enter, used to confirm.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { confirmDialog, PromptDialogHost } from '../../src/renderer/src/components/plexi/PromptDialog'

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<PromptDialogHost />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const q = (id: string): HTMLElement => host.querySelector(`[data-testid="${id}"]`) as HTMLElement
const confirmButton = (): HTMLButtonElement =>
  [...q('prompt-dialog').querySelectorAll('button')].find((b) => b.dataset.testid !== 'prompt-dialog-cancel') as HTMLButtonElement
// Wrapped: an async function returning the answer promise would wait for the answer.
async function ask(cancelIsDefault?: boolean): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>
  await act(async () => {
    answer = confirmDialog({ title: 'Sign in to Plexii as sender@evil.test?', confirmLabel: 'Sign in', cancelIsDefault })
  })
  return { answer }
}
async function enterOn(el: HTMLElement): Promise<void> {
  await act(async () => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    // A button the keydown was not prevented on clicks, as a browser does.
    if (!ev.defaultPrevented && el instanceof HTMLButtonElement) el.click()
  })
}

describe('a confirmation whose default is Cancel', () => {
  it('puts the first focus on Cancel', async () => {
    await ask(true)
    expect(document.activeElement).toBe(q('prompt-dialog-cancel'))
  })

  it('Enter answers no', async () => {
    const { answer } = await ask(true)
    await enterOn(document.activeElement as HTMLElement)
    await expect(answer).resolves.toBe(false)
  })

  it('Enter anywhere but the confirm button answers no, even on the panel', async () => {
    const { answer } = await ask(true)
    await enterOn(q('prompt-dialog'))
    await expect(answer).resolves.toBe(false)
  })

  it('Enter on the confirm button itself answers yes', async () => {
    const { answer } = await ask(true)
    confirmButton().focus()
    await enterOn(confirmButton())
    await expect(answer).resolves.toBe(true)
  })
})

describe('any confirmation', () => {
  it('Enter on the panel still confirms by default', async () => {
    const { answer } = await ask()
    await enterOn(q('prompt-dialog'))
    await expect(answer).resolves.toBe(true)
  })

  it('Tab to Cancel, then Enter, cancels', async () => {
    const { answer } = await ask()
    q('prompt-dialog-cancel').focus()
    await enterOn(q('prompt-dialog-cancel'))
    await expect(answer).resolves.toBe(false)
  })
})
