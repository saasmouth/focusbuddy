import { beforeEach, describe, expect, test, vi } from 'vitest'

// The deterministic action bridge (A6/B1, R27/R29). These locks prove the
// rules in CODE, with a controllable fake webContents: the kill switch wins
// over every action, the step ceiling holds, the R29 bans refuse on both
// acting paths (indexed AND coordinates — the fallback can never bypass a
// ban), and the download guard cancels an agent-driven download. The
// in-page walker's records are fabricated here. Its built-app probe
// (_plexiiA6Bridge.spec.ts) drove it through IPC handles no product code used;
// both were retired in 4.3.41, so nothing exercises the walker in a real page.

interface FakeWc {
  id: number
  destroyed: boolean
  executeJavaScript: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  getURL: () => string
  capturePage: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  session: { on: ReturnType<typeof vi.fn> }
  // Input rides the CDP debugger (sendInputEvent misses on webview guests).
  debugger: { isAttached: () => boolean; attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> }
}

const fakes = new Map<number, FakeWc>()

function makeWc(id: number): FakeWc {
  const wc: FakeWc = {
    id,
    destroyed: false,
    executeJavaScript: vi.fn().mockResolvedValue(null),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: () => 'https://example.test/page',
    capturePage: vi.fn(),
    isDestroyed: () => wc.destroyed,
    session: { on: vi.fn() },
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn().mockResolvedValue(undefined) }
  }
  fakes.set(id, wc)
  return wc
}

vi.mock('electron', () => ({
  webContents: {
    fromId: (id: number) => fakes.get(id) ?? null
  }
}))

import {
  createAgentRun,
  stopAgentRun,
  endAgentRun,
  getAgentRun,
  isAgentDrivenWc,
  performAgentAction,
  refusalFor,
  HARD_STEP_CEILING,
  type PageElement
} from '../../src/main/ai/browserActions'

function el(overrides: Partial<PageElement> = {}): PageElement {
  return {
    idx: 0,
    tag: 'button',
    type: 'button',
    role: '',
    label: 'Do it',
    value: '',
    href: '',
    bounds: { x: 10, y: 10, w: 100, h: 30 },
    disabled: false,
    editable: false,
    isPassword: false,
    isPayment: false,
    isFileInput: false,
    isSubmit: false,
    inCaptcha: false,
    formHasPassword: false,
    formHasPayment: false,
    ...overrides
  }
}

beforeEach(() => {
  fakes.clear()
})

describe('refusalFor — the R29 rules, pure', () => {
  test('a plain button click is allowed', () => {
    expect(refusalFor('click', el())).toBeNull()
  })
  test('typing into a plain text field is allowed', () => {
    expect(refusalFor('type', el({ tag: 'input', type: 'text', editable: true }))).toBeNull()
  })
  test('typing into a username field of a login form is allowed (the password is the line)', () => {
    expect(
      refusalFor('type', el({ tag: 'input', type: 'text', editable: true, formHasPassword: true }))
    ).toBeNull()
  })
  test('typing into a password field refuses: credential_field', () => {
    expect(refusalFor('type', el({ isPassword: true }))).toBe('credential_field')
  })
  test('typing into a card field refuses: payment_field', () => {
    expect(refusalFor('type', el({ isPayment: true }))).toBe('payment_field')
  })
  test('clicking the submit of a form with a password refuses: credential_submit', () => {
    expect(refusalFor('click', el({ isSubmit: true, formHasPassword: true }))).toBe('credential_submit')
  })
  test('clicking the submit of a payment form refuses: payment_submit', () => {
    expect(refusalFor('click', el({ isSubmit: true, formHasPayment: true }))).toBe('payment_submit')
  })
  test('a non-submit click inside a payment form is allowed (reading around is fine)', () => {
    expect(refusalFor('click', el({ formHasPayment: true }))).toBeNull()
  })
  test('clicking a file input refuses: file_transfer', () => {
    expect(refusalFor('click', el({ isFileInput: true }))).toBe('file_transfer')
  })
  test('anything inside a captcha container refuses, whatever the action', () => {
    expect(refusalFor('click', el({ inCaptcha: true }))).toBe('captcha')
    expect(refusalFor('type', el({ inCaptcha: true }))).toBe('captcha')
    expect(refusalFor('select', el({ inCaptcha: true }))).toBe('captcha')
  })
})

describe('the kill switch and the run registry', () => {
  test('a stopped run refuses every action, immediately', async () => {
    makeWc(7)
    const run = createAgentRun(7)
    stopAgentRun(run.id)
    const r = await performAgentAction(run.id, { kind: 'read_page' })
    expect(r.ok).toBe(false)
    expect(r.refused).toBe('run_stopped')
  })
  test('an unknown run refuses', async () => {
    const r = await performAgentAction('nope', { kind: 'read_page' })
    expect(r.refused).toBe('run_unknown')
  })
  test('an ended run is gone', async () => {
    makeWc(8)
    const run = createAgentRun(8)
    endAgentRun(run.id)
    expect(getAgentRun(run.id)).toBeNull()
    const r = await performAgentAction(run.id, { kind: 'read_page' })
    expect(r.refused).toBe('run_unknown')
  })
  test('isAgentDrivenWc: true only while a live, un-aborted run drives the wc', () => {
    makeWc(9)
    const run = createAgentRun(9)
    expect(isAgentDrivenWc(9)).toBe(true)
    stopAgentRun(run.id)
    expect(isAgentDrivenWc(9)).toBe(false)
    endAgentRun(run.id)
  })
  test('the hard step ceiling refuses the action past it', async () => {
    makeWc(10)
    const run = createAgentRun(10)
    getAgentRun(run.id)!.steps = HARD_STEP_CEILING
    const r = await performAgentAction(run.id, { kind: 'read_page' })
    expect(r.refused).toBe('step_ceiling')
    endAgentRun(run.id)
  })
  test('a stop lands DURING a wait, within the slice, not after the full delay', async () => {
    makeWc(11)
    const run = createAgentRun(11)
    const started = Date.now()
    const pending = performAgentAction(run.id, { kind: 'wait', ms: 5000 })
    setTimeout(() => stopAgentRun(run.id), 50)
    const r = await pending
    expect(r.refused).toBe('run_stopped')
    expect(Date.now() - started).toBeLessThan(1500)
    endAgentRun(run.id)
  })
})

describe('the single door over both paths', () => {
  test('a gone browser refuses: browser_gone', async () => {
    const wc = makeWc(12)
    const run = createAgentRun(12)
    wc.destroyed = true
    const r = await performAgentAction(run.id, { kind: 'read_page' })
    expect(r.refused).toBe('browser_gone')
    endAgentRun(run.id)
  })
  test('an indexed click on a banned element refuses without touching the page', async () => {
    const wc = makeWc(13)
    const run = createAgentRun(13)
    wc.executeJavaScript.mockResolvedValue(el({ isSubmit: true, formHasPayment: true, label: 'Pay now' }))
    const r = await performAgentAction(run.id, { kind: 'click', elementIndex: 0 })
    expect(r.refused).toBe('payment_submit')
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
    endAgentRun(run.id)
  })
  test('an allowed indexed click presses and releases at the element centre, via CDP', async () => {
    const wc = makeWc(14)
    const run = createAgentRun(14)
    wc.executeJavaScript.mockResolvedValue(el({ bounds: { x: 100, y: 200, w: 50, h: 20 } }))
    const r = await performAgentAction(run.id, { kind: 'click', elementIndex: 0 })
    expect(r.ok).toBe(true)
    const events = wc.debugger.sendCommand.mock.calls
    expect(events[0][0]).toBe('Input.dispatchMouseEvent')
    expect(events.map((c) => c[1].type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(events[1][1]).toMatchObject({ x: 125, y: 210, button: 'left', clickCount: 1 })
    endAgentRun(run.id)
  })
  test('click_at hit-tests: the coordinate path cannot bypass a ban', async () => {
    const wc = makeWc(15)
    const run = createAgentRun(15)
    wc.executeJavaScript.mockResolvedValue(el({ isPassword: false, isFileInput: true, label: 'Upload' }))
    const r = await performAgentAction(run.id, { kind: 'click_at', x: 40, y: 40 })
    expect(r.refused).toBe('file_transfer')
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
    endAgentRun(run.id)
  })
  test('type_text classifies the focused element: a focused password field refuses', async () => {
    const wc = makeWc(16)
    const run = createAgentRun(16)
    wc.executeJavaScript.mockResolvedValue(el({ isPassword: true, editable: true }))
    const r = await performAgentAction(run.id, { kind: 'type_text', text: 'hunter2' })
    expect(r.refused).toBe('credential_field')
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled()
    endAgentRun(run.id)
  })
  test('press_key Enter with a login form focused refuses: credential_submit', async () => {
    const wc = makeWc(17)
    const run = createAgentRun(17)
    wc.executeJavaScript.mockResolvedValue(el({ editable: true, formHasPassword: true }))
    const r = await performAgentAction(run.id, { kind: 'press_key', key: 'Enter' })
    expect(r.refused).toBe('credential_submit')
    endAgentRun(run.id)
  })
  test('typing refuses on a non-editable element', async () => {
    const wc = makeWc(18)
    const run = createAgentRun(18)
    wc.executeJavaScript.mockResolvedValue(el({ editable: false }))
    const r = await performAgentAction(run.id, { kind: 'type', elementIndex: 0, text: 'hi' })
    expect(r.refused).toBe('bad_input')
    endAgentRun(run.id)
  })
  test('an element that vanished between snapshot and act refuses: element_gone', async () => {
    const wc = makeWc(19)
    const run = createAgentRun(19)
    wc.executeJavaScript.mockResolvedValue(null)
    const r = await performAgentAction(run.id, { kind: 'click', elementIndex: 3 })
    expect(r.refused).toBe('element_gone')
    endAgentRun(run.id)
  })
})

describe('the download guard', () => {
  test('a download started by an agent-driven wc is cancelled and counted', () => {
    const wc = makeWc(20)
    const run = createAgentRun(20)
    const handler = wc.session.on.mock.calls.find((c) => c[0] === 'will-download')?.[1] as (
      e: { preventDefault: () => void },
      item: unknown,
      w: { id: number }
    ) => void
    expect(handler).toBeTruthy()
    const prevent = vi.fn()
    handler({ preventDefault: prevent }, {}, { id: 20 })
    expect(prevent).toHaveBeenCalled()
    expect(getAgentRun(run.id)!.downloadsCancelled).toBe(1)
    // Not agent-driven → untouched.
    const prevent2 = vi.fn()
    handler({ preventDefault: prevent2 }, {}, { id: 999 })
    expect(prevent2).not.toHaveBeenCalled()
    endAgentRun(run.id)
  })
})
