// A real name is required to hold an account — the client's three halves.
//
// B: Create account stays disabled until both names are given.
// C: an existing account with no name is asked for one, and cannot skip.
// D: commenting needs an account, on a LOCAL document too — and signed out the
//    action is REPLACED, not hidden, so nobody is left wondering whether this
//    document supports comments.
//
// The server enforces all three independently (accountNames.ts); these are the
// halves a person actually meets, and the reason each is worth its own test is
// that a disabled button and a hidden one look identical in a passing suite
// unless you assert which.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) }
  )
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const q = (sel: string): HTMLElement | null => document.querySelector(sel)
const setValue = (el: HTMLInputElement, v: string): void => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Mount the launch modal with the account store in a chosen state. */
async function mountModal(state: Record<string, unknown>): Promise<typeof import('../../src/renderer/src/stores/account')> {
  const accountMod = await import('../../src/renderer/src/stores/account')
  act(() => {
    accountMod.useAccountStore.setState({
      bootStatus: 'ready',
      account: null,
      anonymousAllowed: true,
      skippedAt: null,
      ...state
    } as never)
  })
  const { default: LaunchSignInModal } = await import('../../src/renderer/src/components/LaunchSignInModal')
  const { useSignInPrompt } = await import('../../src/renderer/src/stores/signInPrompt')
  act(() => useSignInPrompt.setState({ open: true } as never))
  act(() => root.render(<LaunchSignInModal />))
  await act(async () => {
    await Promise.resolve()
  })
  return accountMod
}

describe('B: sign-up requires a first and last name', () => {
  it('Create account stays disabled until BOTH are given', async () => {
    await mountModal({})
    // Switch to sign-up.
    const signUpTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Sign up')
    expect(signUpTab, 'the sign-up tab is there').toBeTruthy()
    act(() => signUpTab!.click())

    const email = q('[placeholder="you@example.com"]') as HTMLInputElement
    const password = q('[placeholder="at least 8 characters"]') as HTMLInputElement
    const first = q('[data-testid="signup-first-name"]') as HTMLInputElement
    const last = q('[data-testid="signup-last-name"]') as HTMLInputElement
    const submit = q('[data-testid="signin-submit"]') as HTMLButtonElement
    expect(first && last, 'the name fields are offered').toBeTruthy()

    setValue(email, 'ada@example.com')
    setValue(password, 'password12345')
    expect(submit.disabled, 'email and password alone are not enough').toBe(true)

    setValue(first, 'Ada')
    expect(submit.disabled, 'a first name alone is not enough').toBe(true)

    setValue(last, '   ')
    expect(submit.disabled, 'whitespace is not a name').toBe(true)

    setValue(last, 'Lovelace')
    expect(submit.disabled, 'both given: now it submits').toBe(false)
  })

  it('says WHY the name is wanted, not just that it is required', async () => {
    await mountModal({})
    const signUpTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Sign up')
    act(() => signUpTab!.click())
    const why = q('[data-testid="signup-name-why"]')
    expect(why?.textContent).toMatch(/shown to people you share/i)
  })

  it('logging IN is never blocked by it — an account with no name must get in to add one', async () => {
    // The claim is narrow and worth keeping narrow: in LOGIN mode the name
    // fields do not exist, so they cannot gate anything. That matters because
    // the person most likely to have no name is a returning user, and if the
    // requirement reached the login form they could never get in to add one.
    await mountModal({ cachedEmail: 'ada@example.com' })
    const byText = (t: string): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === t)
    act(() => byText('Log in')!.click())
    expect(q('[data-testid="signup-first-name"]'), 'no name field in login mode').toBeNull()
    expect(q('[data-testid="signup-last-name"]')).toBeNull()
    // And the same modal does render them for sign-up, so the absence above
    // is the mode rather than a selector that never matches.
    act(() => byText('Sign up')!.click())
    expect(q('[data-testid="signup-first-name"]'), 'and they ARE there for sign-up').not.toBeNull()
  })
})

describe('C: an account with no name is asked for one', () => {
  const nameless = { id: 'a1', email: 'legacy@example.com', firstName: null, lastName: null }

  it('shows the step, says why, and offers no way out', async () => {
    await mountModal({ account: nameless })
    const step = q('[data-testid="add-your-name"]')
    expect(step, 'the step is shown to a signed-in account with no name').not.toBeNull()
    expect(q('[data-testid="add-your-name-why"]')?.textContent).toMatch(/know who commented/i)
    // Required means required: nothing in it closes it.
    const labels = Array.from(step!.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())
    expect(labels).toEqual(['Save and continue'])
    expect(step!.querySelector('[aria-label="Close"]'), 'no close button').toBeNull()
  })

  it('Save stays disabled until both fields are filled', async () => {
    await mountModal({ account: nameless })
    const save = q('[data-testid="add-name-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    setValue(q('[data-testid="add-name-first"]') as HTMLInputElement, 'Ada')
    expect(save.disabled, 'one name is not a name').toBe(true)
    setValue(q('[data-testid="add-name-last"]') as HTMLInputElement, 'Lovelace')
    expect(save.disabled).toBe(false)
  })

  it('a FAILED save keeps the step up and says so, rather than letting you past', async () => {
    const mod = await mountModal({ account: nameless })
    act(() => mod.useAccountStore.setState({ updateName: async () => false } as never))
    setValue(q('[data-testid="add-name-first"]') as HTMLInputElement, 'Ada')
    setValue(q('[data-testid="add-name-last"]') as HTMLInputElement, 'Lovelace')
    await act(async () => {
      ;(q('[data-testid="add-name-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(q('[data-testid="add-your-name"]'), 'still there').not.toBeNull()
    // The owner's ruling is that this blocks even offline, so the message says
    // a connection is NEEDED rather than inviting a retry that cannot work.
    const msg = q('[data-testid="add-name-error"]')?.textContent ?? ''
    expect(msg).toMatch(/needs a connection/i)
    expect(msg, 'and does not tell someone with no network to keep trying').not.toMatch(/try again/i)
  })

  it('when the connection comes back, Save just works — nothing to restart', async () => {
    const mod = await mountModal({ account: nameless })
    act(() => mod.useAccountStore.setState({ updateName: async () => false } as never))
    setValue(q('[data-testid="add-name-first"]') as HTMLInputElement, 'Ada')
    setValue(q('[data-testid="add-name-last"]') as HTMLInputElement, 'Lovelace')
    await act(async () => {
      ;(q('[data-testid="add-name-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(q('[data-testid="add-name-error"]')).not.toBeNull()

    // What was typed is still there, and Save is still pressable — the two
    // things that make "it goes through when you are back online" true.
    expect((q('[data-testid="add-name-first"]') as HTMLInputElement).value).toBe('Ada')
    expect((q('[data-testid="add-name-last"]') as HTMLInputElement).value).toBe('Lovelace')
    expect((q('[data-testid="add-name-save"]') as HTMLButtonElement).disabled).toBe(false)

    // The connection returns.
    let sent: { firstName: string; lastName: string } | null = null
    act(() =>
      mod.useAccountStore.setState({
        updateName: async (input: { firstName: string; lastName: string }) => {
          sent = input
          mod.useAccountStore.setState({
            account: { ...nameless, firstName: input.firstName, lastName: input.lastName }
          } as never)
          return true
        }
      } as never)
    )
    await act(async () => {
      ;(q('[data-testid="add-name-save"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(sent, 'the same name was sent, with nothing retyped').toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
    expect(q('[data-testid="add-your-name"]'), 'and the step lets go').toBeNull()
  })

  it('an account that HAS a name is not asked, and an account with one of two IS', async () => {
    await mountModal({ account: { ...nameless, firstName: 'Ada', lastName: 'Lovelace' } })
    expect(q('[data-testid="add-your-name"]'), 'a named account is left alone').toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await mountModal({ account: { ...nameless, firstName: 'Ada' } })
    expect(q('[data-testid="add-your-name"]'), 'half a name is still asked for').not.toBeNull()
  })
})

describe('D: commenting needs an account, on a LOCAL document too', () => {
  /** Mount the real doc editor with the comment panel already open. */
  async function mountEditor(props: Record<string, unknown>): Promise<void> {
    // The side panel is minimised by default, and its state is a stored
    // preference — so a test can open it the same way a returning user's
    // choice does, rather than driving the View menu.
    localStorage.setItem('fb.doc.sidePanel.minimized', 'false')
    const { default: DocEditor } = await import('../../src/renderer/src/components/documents/DocEditor')
    act(() =>
      root.render(
        <DocEditor content="<p>Minutes of the meeting.</p>" title="Minutes" onChange={() => {}} {...props} />
      )
    )
    await act(async () => {
      await Promise.resolve()
    })
  }

  /**
   * Open the comments panel the way the UI does from collapsed.
   *
   * The side panel is minimised by default and, while collapsed, shows an
   * EDGE with its own openers (doc-side-panel-open-comments) — the tab
   * buttons do not exist until the panel is expanded, which is why looking
   * for `doc-tab-comments` first found nothing.
   */
  const openComments = (): void => {
    const edge = q('[data-testid="doc-side-panel-open-comments"]') as HTMLElement | null
    if (edge) act(() => edge.click())
    const tab = q('[data-testid="doc-tab-comments"]') as HTMLElement | null
    if (tab) act(() => tab.click())
  }

  const existing = [
    {
      id: 'c1',
      author: 'Ada Lovelace',
      createdAt: Date.now() - 86_400_000,
      body: 'written while signed in, yesterday',
      resolved: false,
      you: false,
      replies: []
    }
  ]

  it('signed OUT, the action is REPLACED rather than hidden', async () => {
    const onSignIn = vi.fn()
    await mountEditor({ comments: existing, canComment: false, onSignIn })
    openComments()

    expect(q('[data-testid="doc-comments-add"]'), 'no add button when signed out').toBeNull()
    const signIn = q('[data-testid="doc-comments-signin"]')
    expect(signIn, 'but the action is still there, explaining itself').not.toBeNull()
    expect(signIn!.textContent).toMatch(/sign in to comment/i)
    act(() => (signIn as HTMLElement).click())
    expect(onSignIn, 'and it opens the sign-in dialog').toHaveBeenCalled()
  })

  it('existing comments stay READABLE when signed out', async () => {
    await mountEditor({ comments: existing, canComment: false, onSignIn: () => {} })
    openComments()
    // The owner's rule: losing the ability to write must not lose the ability
    // to read what is already there.
    expect(document.body.textContent).toContain('written while signed in, yesterday')
    expect(document.body.textContent).toContain('Ada Lovelace')
  })

  it('signed IN, the ordinary add button is back and no sign-in prompt is shown', async () => {
    await mountEditor({ comments: existing, canComment: true, onAddComment: () => {}, onSignIn: () => {} })
    openComments()
    expect(q('[data-testid="doc-comments-add"]')).not.toBeNull()
    expect(q('[data-testid="doc-comments-signin"]')).toBeNull()
  })
})
