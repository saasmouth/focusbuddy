import { test, expect, type ElectronApplication } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { launchApp, waitForReady } from './_helpers'

// ws-v-3 external markdown editing (mdExternal.ts + authProtocol.ts +
// ExternalMdEditorView.tsx). Verifies against the BUILT app:
//   1. Deep-link round trip: plexii://edit-md?path=<seeded .md> opens the
//      editor surface, a typed sentence autosaves back to the same file on
//      disk as markdown, header shows "Saved to file".
//   2. Scope: a path outside the ops workspace root shows the honest
//      "Cannot open this document" state and the file is never touched.
//   3. Refusals: non-.md path, '..' traversal, relative path, and
//      write-without-prior-read are all refused with the real error.
//
// Deep-link delivery note: the operator's production PlexiDesk.app is
// installed and RUNNING on this machine and owns the plexii:// scheme in
// LaunchServices, so a shell `open "plexii://..."` would be routed to the
// production app, not this isolated test instance. We therefore deliver the
// URL by emitting the same 'open-url' event macOS itself fires — which is
// the exact entry point authProtocol.ts registers — and everything from URL
// parsing onward (parseEditMdUrl -> broadcastMdEdit -> renderer
// 'mdext:incoming-path' -> view store -> editor -> mdext IPC) is exercised
// for real. Only the LaunchServices hop itself is not driven.
//
// Writes only to the seeded round-trip file and /tmp fixtures, per dispatch.

const SEEDED = '/Applications/agentic-starter-kit-main/projects/worksuite/outputs/mdext-roundtrip-test.md'
const OUTSIDE = '/tmp/outside-root.md'

async function sendDeepLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: eapp }, u) => {
    // Same signature macOS uses: (event, url). preventDefault is all the
    // handler touches on the event.
    eapp.emit('open-url', { preventDefault: () => {} }, u)
  }, url)
}

test('deep link opens seeded md; typed sentence autosaves to disk as markdown', async () => {
  test.setTimeout(120_000)
  const before = readFileSync(SEEDED, 'utf-8')
  expect(before).toContain('Round trip test')

  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await sendDeepLink(app, `plexii://edit-md?path=${SEEDED}`)

    // Editor surface opens on the file: header carries name + full path.
    await expect(window.locator('text=mdext-roundtrip-test.md').first()).toBeVisible({
      timeout: 10_000
    })
    await expect(window.getByText(SEEDED, { exact: true })).toBeVisible()

    // Seeded content rendered in the Tiptap surface.
    const editor = window.locator('.ProseMirror', { hasText: 'Round trip test' })
    await expect(editor).toBeVisible({ timeout: 10_000 })

    // Type a distinctive sentence at the end of the document.
    const sentence = 'The quartz heron filed its ninth amendment at dawn MDEXT-E2E-7431.'
    await editor.click()
    await window.keyboard.press('ControlOrMeta+ArrowDown')
    await window.keyboard.press('Enter')
    await window.keyboard.type(sentence)

    // Autosave fires 800ms after the last keystroke; header returns to the
    // honest saved state.
    await expect(window.locator('text=Saved to file')).toBeVisible({ timeout: 15_000 })
    // Poll the real file on disk until the sentence lands.
    await expect
      .poll(() => readFileSync(SEEDED, 'utf-8'), { timeout: 10_000 })
      .toContain('MDEXT-E2E-7431')

    const after = readFileSync(SEEDED, 'utf-8')
    expect(after).toContain('Round trip test')
    expect(after).toContain(sentence)
    // Atomic write cleaned up its temp file.
    expect(existsSync(`${SEEDED}.plexitmp`)).toBe(false)
    console.log(`[mdext] file after save:\n${after}`)
  } finally {
    await dispose()
  }
})

test('path outside the workspace root is refused with the honest error; file untouched', async () => {
  test.setTimeout(120_000)
  const canary = `# Outside root canary\n\nDo not touch. ${Date.now()}\n`
  writeFileSync(OUTSIDE, canary, 'utf-8')

  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)
    await sendDeepLink(app, `plexii://edit-md?path=${OUTSIDE}`)

    await expect(window.locator('text=Cannot open this document')).toBeVisible({
      timeout: 10_000
    })
    await expect(window.locator('text=outside the ops workspace')).toBeVisible()

    // Belt and braces: the IPC surface itself refuses both read and write.
    const readRes = await window.evaluate(
      (p) =>
        (
          window as unknown as {
            api: { mdext: { read: (p: string) => Promise<{ ok: boolean; error?: string }> } }
          }
        ).api.mdext.read(p),
      OUTSIDE
    )
    expect(readRes.ok).toBe(false)
    expect(readRes.error).toContain('outside the ops workspace')

    const writeRes = await window.evaluate(
      (p) =>
        (
          window as unknown as {
            api: {
              mdext: { write: (p: string, c: string) => Promise<{ ok: boolean; error?: string }> }
            }
          }
        ).api.mdext.write(p, 'HIJACKED'),
      OUTSIDE
    )
    expect(writeRes.ok).toBe(false)
    expect(writeRes.error).toContain('outside the ops workspace')

    // File on disk is byte-identical and no temp file appeared.
    expect(readFileSync(OUTSIDE, 'utf-8')).toBe(canary)
    expect(existsSync(`${OUTSIDE}.plexitmp`)).toBe(false)
    console.log('[mdext] outside-root file untouched, honest error shown')
  } finally {
    await dispose()
  }
})

test('non-md, traversal, relative and write-without-read are all refused', async () => {
  test.setTimeout(120_000)
  const before = readFileSync(SEEDED, 'utf-8')

  const { app, window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Deep link to an in-root path that is not .md → honest refusal screen.
    await sendDeepLink(
      app,
      'plexii://edit-md?path=/Applications/agentic-starter-kit-main/projects/worksuite/outputs/notes.txt'
    )
    await expect(window.locator('text=Cannot open this document')).toBeVisible({
      timeout: 10_000
    })
    await expect(window.locator('text=only .md files')).toBeVisible()

    const call = (fn: 'read' | 'write', p: string, c?: string) =>
      window.evaluate(
        (args) => {
          const api = (
            window as unknown as {
              api: {
                mdext: {
                  read: (p: string) => Promise<{ ok: boolean; error?: string }>
                  write: (p: string, c: string) => Promise<{ ok: boolean; error?: string }>
                }
              }
            }
          ).api.mdext
          return args.fn === 'read' ? api.read(args.p) : api.write(args.p, args.c ?? '')
        },
        { fn, p, c }
      )

    // '..' traversal refused even when it still ends .md.
    const trav = await call(
      'read',
      '/Applications/agentic-starter-kit-main/projects/../projects/worksuite/outputs/mdext-roundtrip-test.md'
    )
    expect(trav.ok).toBe(false)
    expect(trav.error).toContain('traversal')

    // Relative path refused.
    const rel = await call('read', 'projects/worksuite/outputs/mdext-roundtrip-test.md')
    expect(rel.ok).toBe(false)
    expect(rel.error).toContain('absolute')

    // Write to a valid in-root file this session never read → refused, file intact.
    const blind = await call('write', SEEDED, 'BLIND WRITE MUST NOT LAND')
    expect(blind.ok).toBe(false)
    expect(blind.error).toContain('never read')
    expect(readFileSync(SEEDED, 'utf-8')).toBe(before)
    console.log('[mdext] all four refusals returned the real error; seeded file intact')
  } finally {
    await dispose()
  }
})
