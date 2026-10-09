/**
 * E2E spec: restyleVisual — captures the restyled folders/desks/tasks
 * surfaces (commit a49a0d9) across all four theme modes so a human/AI
 * reviewer can check for theme regressions (flat grey patches ignoring
 * the theme, unreadable contrast, broken layout, orphaned light boxes on
 * a dark background).
 *
 * One Electron instance is launched once; theme switches are done via the
 * same localStorage keys + reload path the in-app theme picker uses
 * (see lib/theme.ts loadTheme/saveTheme/applyTheme), so no relaunch is
 * needed per theme.
 *
 * Screenshots land in the scratchpad's restyle-shots/<theme>-<surface>.png
 * (NOT under this project's test-results/, which Playwright wipes clean at
 * the start of every run — a sibling debug spec run would otherwise delete
 * these screenshots before a human/AI reviewer gets to look at them):
 *   sidebar   — global Desk sidebar with folders/tasks
 *   newnode   — NewNodeDialog open
 *   alltasks  — All Tasks view with near/overdue StatusPill chips
 *   gallery   — Desk gallery with 2+ desks
 *   canvas    — Task canvas chrome (FloatingToolbar + ZoomControls + breadcrumb)
 */

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import { mkdirSync } from 'fs'
import { join } from 'path'

const SHOTS_DIR =
  '/private/tmp/claude-501/-Applications-agentic-starter-kit-main/08400787-884c-474c-8ae7-9f9d75902fea/scratchpad/restyle-shots'

const THEMES: Array<{ mode: string; accent: string }> = [
  { mode: 'light', accent: 'violet' },
  { mode: 'dark', accent: 'violet' },
  { mode: 'futuristic', accent: 'violet' },
  { mode: 'atelier', accent: 'heritage' }
]

test('restyled surfaces render correctly across all four themes', async () => {
  mkdirSync(SHOTS_DIR, { recursive: true })
  const { window, dispose } = await launchApp()

  try {
    await waitForReady(window)

    // ------------------------------------------------------------------ //
    // Seed data once: a folder with an overdue + a near-due task (so       //
    // StatusPill chips show in All Tasks and in the sidebar), plus two     //
    // more top-level desks so the gallery shows 2+ cards.                  //
    // ------------------------------------------------------------------ //
    const now = Date.now()
    const DAY = 86_400_000
    const seeded = await window.evaluate(async ({ now, DAY }) => {
      const api = (
        window as unknown as {
          api: { nodes: { create: (d: Record<string, unknown>) => Promise<{ id: string }> } }
        }
      ).api
      const folder = await api.nodes.create({
        parentId: null,
        kind: 'folder',
        title: 'Visual Test Folder'
      })
      const overdueTask = await api.nodes.create({
        parentId: folder.id,
        kind: 'task',
        title: 'Overdue Visual Task',
        dueDate: now - 2 * DAY
      })
      const soonTask = await api.nodes.create({
        parentId: folder.id,
        kind: 'task',
        title: 'Due Soon Visual Task',
        dueDate: now + DAY
      })
      const deskTwo = await api.nodes.create({
        parentId: null,
        kind: 'folder',
        title: 'Visual Test Desk Two'
      })
      const deskThree = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: 'Visual Test Desk Three'
      })
      return {
        folderId: folder.id,
        overdueId: overdueTask.id,
        soonId: soonTask.id,
        deskTwoId: deskTwo.id,
        deskThreeId: deskThree.id
      }
    }, { now, DAY })
    console.log('Seeded for visual pass:', JSON.stringify(seeded))

    for (const { mode, accent } of THEMES) {
      console.log(`--- Capturing theme: ${mode} ---`)

      // Go to the suite landing view BEFORE reloading. The view store
      // persists the last view (persistView) across reloads, and
      // waitForReady's readiness canary is the h2 "PlexiDesk" heading, which
      // only lives on PlexiSuiteHome (the 'suite' view — the app's actual
      // default boot view). Reloading while parked on 'home' or a canvas
      // view would make waitForReady time out despite the app being fully
      // loaded, since neither of those views renders that heading.
      await window.evaluate(() => {
        const w = window as unknown as { __fbView?: { getState: () => { goSuite: () => void } } }
        w.__fbView?.getState().goSuite()
      })
      await window.waitForTimeout(200)

      // Apply the theme the same way the in-app picker does: persist to the
      // localStorage keys lib/theme.ts reads (fb.theme.mode / fb.theme.accent),
      // then reload so applyTheme() runs from loadTheme() on boot.
      await window.evaluate(
        ({ mode, accent }) => {
          localStorage.setItem('fb.theme.mode', mode)
          localStorage.setItem('fb.theme.accent', accent)
        },
        { mode, accent }
      )
      await window.reload()
      await waitForReady(window)
      // A capture spec with no assertions passes on ANY screen. It did: past
      // the third reload every boot was charged as an app open, the fourth met
      // the account-required sign-in wall, and the futuristic and atelier
      // "surfaces" were screenshots of that modal. So each capture now checks
      // it is looking at the surface it names, and the wall is not up.
      await expect(window.locator('[role="dialog"][aria-label="Sign in to PlexiDesk"]')).toHaveCount(0)

      // (a) Sidebar with folders/tasks — go Home so the sidebar renders
      //     alongside the ordinary workspace dashboard with the seeded tree
      //     visible (the sidebar itself is global chrome, present on every
      //     view, but Home is the most representative "at rest" surface).
      await window.evaluate(() => {
        const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
        w.__fbView?.getState().goHome()
      })
      await window.waitForTimeout(500)
      await expect(window.locator('[data-testid="sidebar-dock"]')).toBeVisible()
      await window.screenshot({ path: join(SHOTS_DIR, `${mode}-sidebar.png`), fullPage: false })

      // (b) NewNodeDialog open
      await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:command-new-task')))
      await window.waitForTimeout(400)
      await expect(window.locator('[data-testid="newnode-name"]')).toBeVisible()
      await window.screenshot({ path: join(SHOTS_DIR, `${mode}-newnode.png`), fullPage: false })
      // Close it (Escape / click Cancel) before moving on.
      await window.keyboard.press('Escape').catch(() => {})
      const cancelBtn = window.getByRole('button', { name: 'Cancel' })
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click().catch(() => {})
      }
      await window.waitForTimeout(300)

      // (c) All Tasks with near/overdue StatusPill chips
      await window.evaluate(() => {
        const w = window as unknown as {
          __fbView?: { getState: () => { goAllTasks: () => void } }
        }
        w.__fbView?.getState().goAllTasks()
      })
      await window.waitForTimeout(500)
      await expect(window.getByText('All Tasks', { exact: true })).toBeVisible()
      await window.screenshot({ path: join(SHOTS_DIR, `${mode}-alltasks.png`), fullPage: false })

      // (d) Desk gallery with 2+ desks
      await window.evaluate(() => {
        const w = window as unknown as {
          __fbView?: { getState: () => { goProject: (id: string) => void } }
        }
        w.__fbView?.getState().goProject('no-such-desk-restyle-visual')
      })
      await window.waitForTimeout(600)
      await expect(window.locator('[data-testid="desk-gallery"]')).toBeVisible()
      await window.screenshot({ path: join(SHOTS_DIR, `${mode}-gallery.png`), fullPage: false })

      // (e) Task canvas chrome: FloatingToolbar + ZoomControls + breadcrumb
      await window.evaluate((id) => {
        const w = window as unknown as {
          __fbView?: { getState: () => { goProject: (id: string) => void } }
        }
        w.__fbView?.getState().goProject(id)
      }, seeded.folderId)
      await window.waitForTimeout(700)
      await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible()
      await window.screenshot({ path: join(SHOTS_DIR, `${mode}-canvas.png`), fullPage: false })
    }

    console.log('All theme screenshots captured in', SHOTS_DIR)
  } finally {
    await dispose()
  }
})
