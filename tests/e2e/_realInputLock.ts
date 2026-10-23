// One spec at a time may own the screen and the keyboard.
//
// A spec that posts REAL input (CGEvents through the macOS window server:
// _macMouse.postMouse, _macPasteboard.postKeyToPid) needs its window in front
// and focused for as long as it runs: it pins the window on top and steals
// focus. Two such specs on two workers take the window from each other, and a
// press then lands in the other app, or nowhere. That is how red176 saw
// drawShortcutsNative NK-1/2/4/5 and edgePanRestingPointer ERP-5 fail together
// at --workers=2 (ERP-5 and NK-4 started within a second of each other), and
// pass on the next run when they happened not to overlap.
//
// So each real-input spec holds this lock from its beforeAll to its afterAll.
// It is a directory (mkdir is atomic across processes) carrying the holder's
// pid; a lock whose holder has died is taken over, so a crashed worker cannot
// wedge the suite. Waiting is on the lock's state, polled, not a fixed sleep.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Overridable so the lock's own unit test never touches a running suite's lock.
const LOCK = process.env.PLEXII_REAL_INPUT_LOCK || join(tmpdir(), 'plexii-e2e-real-input.lock')

function holderAlive(): boolean {
  try {
    const pid = Number(readFileSync(join(LOCK, 'pid'), 'utf8'))
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockAgeMs(): number {
  try {
    return Date.now() - statSync(LOCK).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Wait until this worker owns real input. Call from beforeAll, with a hook
 * timeout that covers another real-input spec finishing first.
 */
export async function acquireRealInput(label: string, timeoutMs = 170_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(LOCK)
      writeFileSync(join(LOCK, 'pid'), String(process.pid))
      writeFileSync(join(LOCK, 'label'), label)
      return
    } catch {
      // Held. A holder that died gives it up; a lock with no pid yet is a
      // holder between its mkdir and its write, unless it has been so a while.
      if (!holderAlive() && lockAgeMs() > 1_000) rmSync(LOCK, { recursive: true, force: true })
    }
    if (Date.now() - start > timeoutMs) {
      let holder = '?'
      try {
        holder = readFileSync(join(LOCK, 'label'), 'utf8')
      } catch {
        /* gone between the check and the read */
      }
      throw new Error(`${label}: real input is still held by ${holder} after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Give real input back. Call from afterAll; only the holder removes the lock. */
export function releaseRealInput(): void {
  try {
    if (Number(readFileSync(join(LOCK, 'pid'), 'utf8')) === process.pid) rmSync(LOCK, { recursive: true, force: true })
  } catch {
    /* not held */
  }
}
