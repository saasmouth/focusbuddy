import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
const OUT = '/private/tmp/claude-501/-Users-mymac-Desktop-My-Apps-06-Agentic-Starter-Kit--links-/c4890865-a2f8-44a0-a37f-72c8c3fceb86/scratchpad/shots'
test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })
test('diag2', async () => {
  launched = await launchApp()
  const { window, userDataDir } = launched
  await waitForReady(window)
  execFileSync('node', ['scripts/seed-preview-capability-desk.cjs'], {
    env: { ...process.env, PLEXI_SEED_DB: join(userDataDir, 'focusbuddy.db') }, stdio: 'pipe' })
  await window.reload(); await waitForReady(window)
  await window.setViewportSize({ width: 1680, height: 1020 })
  await window.evaluate(async () => {
    const w = window as any
    await w.__fbNodes.getState().refresh()
    const d = w.__fbNodes.getState().nodes.find((n: any) => n.title.startsWith('Plexii 2.0'))
    w.__fbView.getState().goTask(d.id)
    await new Promise((r) => setTimeout(r, 900))
    const ws = w.__fbWidgets.getState()
    const cw = ws.widgets.find((x: any) => x.kind === 'custom')
    await ws.update(cw.id, { content: JSON.stringify({ spec: '', code: '' }) })
  })
  await window.waitForTimeout(1200)
  await window.locator('[data-testid="custom-widget-wizard-open"]').click()
  await expect(window.locator('[data-testid="custom-widget-wizard"]')).toBeVisible({ timeout: 8000 })
  await window.waitForTimeout(800)
  const info = await window.evaluate(() => {
    const el = document.querySelector('[data-testid="wizard-other-kind"]') as HTMLElement | null
    const wiz = document.querySelector('[data-testid="custom-widget-wizard"]') as HTMLElement | null
    return {
      otherExists: !!el,
      otherRect: el ? el.getBoundingClientRect().toJSON() : null,
      wizRect: wiz ? wiz.getBoundingClientRect().toJSON() : null,
      optCount: document.querySelectorAll('[data-testid^="wizard-opt-"]').length
    }
  })
  console.log('DIAG2', JSON.stringify(info))
  await window.screenshot({ path: `${OUT}/cw-wizard.png` })
})
