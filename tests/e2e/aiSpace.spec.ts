// AI Space + Connections, end to end on the built app (docs/ai-space).
//
// Hermetic: the app talks to a local fake Anthropic server on 127.0.0.1
// (AISPACE_ALLOW_LOOPBACK + AISPACE_ANTHROPIC_BASE, honoured only in tests),
// launched through launchApp/launchGuarded so nothing reaches production, and
// in the background so it never takes over the screen.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'
import { startFakeAnthropic, type FakeAnthropic } from '../unit/helpers/aispaceFakeModelApis'

const KEY = 'sk-ant-test-e2e-abcdefghijklmnop'

let fake: FakeAnthropic

test.beforeAll(async () => {
  fake = await startFakeAnthropic({ key: KEY, org: 'org_saasmouth', chunks: ['Start your ', '14-day free trial', ' today.'] })
})
test.afterAll(async () => {
  await fake.close()
})

async function boot() {
  const app = await launchApp({ env: { AISPACE_ALLOW_LOOPBACK: '1', AISPACE_ANTHROPIC_BASE: fake.url } })
  await waitForReady(app.window)
  return app
}

async function goAiSpace(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __fbView: { getState: () => { goAiSpace: () => void } } }).__fbView.getState().goAiSpace())
  await expect(page.getByTestId('ais-home')).toBeVisible()
}

test('a key is checked read-only, a project runs a task, and the result is reviewed and approved', async () => {
  const { window: page, dispose } = await boot()
  try {
    await goAiSpace(page)
    // Connect a key through the real flow: verified with a free model list.
    await page.getByTestId('ais-home-connections').click()
    await expect(page.locator('[data-testid="ais-connections"], [data-testid="connections-view"]').first()).toBeVisible()
    const ctx = await page.evaluate(() => window.api.aiSpace.getContext())
    const added = await page.evaluate(
      ([ws, key]) => window.api.aiSpace.addModelApi({ providerId: 'anthropic', workspaceId: ws, alias: 'SaaSMouth Claude', billedTo: 'SaaSMouth', secret: key }),
      [ctx.workspaces[0].id, KEY] as const
    )
    expect(added.ok).toBe(true)
    expect(JSON.stringify(added)).not.toContain(KEY)
    // The check was the free model list, never a billable call.
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(false)

    // Start a project from Home.
    await goAiSpace(page)
    await page.getByTestId('ais-home-new').click()
    await page.getByTestId('ais-new-project-title').fill('SaaSMouth launch')
    await page.getByTestId('ais-new-project-goal').fill('Launch the offer page')
    await page.getByTestId('ais-new-project-brief').fill('Offer: a 14-day free trial. Audience: agency owners.')
    await page.getByTestId('ais-new-project-create').click()
    await expect(page.getByTestId('ais-desk')).toBeVisible()
    await expect(page.getByTestId('ais-project-title')).toHaveText('SaaSMouth launch')
    await expect(page.getByText('On this Mac only')).toBeVisible()

    // Make the connection the project default (grants it for running models).
    const projectId = await page.getByTestId('ais-desk').getAttribute('data-project')
    await page.evaluate(([p, c]) => window.api.aiSpace.setProjectDefault(p!, c, 'claude-sonnet-5-5'), [projectId, (added as { connection: { id: string } }).connection.id] as const)

    // Ask for a deliverable; the composer says who pays before Send.
    await page.getByTestId('ais-composer-mode-task').click()
    await expect(page.getByTestId('ais-composer-summary')).toContainText('Paid by SaaSMouth')
    await page.getByTestId('ais-composer-title').fill('Site hero')
    await page.getByTestId('ais-composer-kind').selectOption('site')
    await page.getByTestId('ais-composer-text').fill('Write the hero line for the offer page.')
    await page.getByTestId('ais-composer-text').press('Meta+Enter')

    // The run lands as v1 of a new Site output, waiting for review.
    await page.getByTestId('ais-tab-outputs').click()
    await expect(page.getByTestId('ais-output-card')).toContainText('Site hero', { timeout: 15_000 })
    await page.getByTestId('ais-output-card').first().click()
    await expect(page.getByTestId('ais-output-inspector')).toBeVisible()
    await expect(page.getByTestId('ais-output-inspector')).toContainText('14-day free trial')
    await page.getByTestId('ais-approve-version').click()
    await expect(page.getByTestId('ais-output-inspector')).toContainText('Approved')

    // Escape closes the inspector and returns focus to the card that opened it.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('ais-output-inspector')).toBeHidden()
    await expect(page.getByTestId('ais-output-card').first()).toBeFocused()

    // A decision changes the offer; Impact traces it to the hero with evidence.
    await page.evaluate((p) => window.api.aiSpace.recordDecision({ projectId: p!, topic: 'trial', title: 'Trial is 14 days', value: '14 days', approve: true }), projectId)
    await page.evaluate((p) => window.api.aiSpace.recordDecision({ projectId: p!, topic: 'trial', title: 'Client approved a 30-day trial', value: '30 days', approve: true }), projectId)
    await page.getByTestId('ais-tab-impact').click()
    const row = page.getByTestId('ais-impact-row').filter({ hasText: 'Client approved a 30-day trial.' })
    await expect(row).toContainText('Previously 14 days.')
    await expect(row.getByTestId('ais-impact-item').filter({ hasText: 'Site hero' })).toBeVisible()
    // The hero has no recorded link to the decision itself, so it is offered
    // as a possibility, with the exact matching text shown up front.
    await expect(row.locator('mark')).toContainText('14-day')
    // Approved versions are untouched until someone changes them.
    const out = await page.evaluate((p) => window.api.aiSpace.projectView(p!), projectId)
    const hero = out.outputs.find((o) => o.title === 'Site hero')!
    expect(hero.approvedVersionId).toBe(hero.latestVersionId)

    // Nothing ever rendered the key.
    expect(await page.content()).not.toContain(KEY)
  } finally {
    await dispose()
  }
})

test('a personal project is absent from a work context, in Home and in search', async () => {
  const { window: page, dispose } = await boot()
  try {
    const work = await page.evaluate(() => window.api.aiSpace.createWorkspace('work', 'SaaSMouth'))
    const ctx = await page.evaluate(() => window.api.aiSpace.getContext())
    const personal = ctx.workspaces.find((w) => w.kind === 'personal')!
    await page.evaluate(([w]) => window.api.aiSpace.createProject({ workspaceId: w, title: 'Wedding speech', goal: 'secret plans' }), [personal.id] as const)
    await page.evaluate(([w]) => window.api.aiSpace.createProject({ workspaceId: w, title: 'Client launch', goal: 'launch plans' }), [work.id] as const)
    await page.evaluate(([w]) => window.api.aiSpace.setContext([w]), [work.id] as const)
    await goAiSpace(page)
    await expect(page.getByTestId('ais-home-project')).toHaveCount(1)
    await expect(page.getByTestId('ais-home-project')).toContainText('Client launch')
    await expect(page.getByTestId('ais-home')).not.toContainText('Wedding speech')
    const hits = await page.evaluate(() => window.api.aiSpace.search('plans'))
    expect(hits.map((h) => h.title)).toEqual(['Client launch'])
  } finally {
    await dispose()
  }
})

test('Impact works by keyboard alone, and with reduced motion', async () => {
  const { window: page, dispose } = await boot()
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const ctx = await page.evaluate(() => window.api.aiSpace.getContext())
    const desk = await page.evaluate(() => window.api.nodes.create({ parentId: null, kind: 'task', title: 'Launch desk' }))
    const p = await page.evaluate(([w, d]) => window.api.aiSpace.createProject({ workspaceId: w, title: 'Launch', brief: 'Offer a 14-day trial.', deskId: d }), [ctx.workspaces[0].id, desk.id] as const)
    const blog = await page.evaluate((pid) => window.api.aiSpace.createOutput({ projectId: pid, kind: 'document', title: 'Blog post', content: 'Our fourteen-day trial lets agencies test everything.' }), p.id)
    expect(blog).toBeTruthy()
    await page.evaluate((pid) => window.api.aiSpace.recordDecision({ projectId: pid, topic: 'trial', title: 'Trial is 14 days', value: '14 days', approve: true }), p.id)
    await page.evaluate((pid) => window.api.aiSpace.recordDecision({ projectId: pid, topic: 'trial', title: 'Client approved a 30-day trial', value: '30 days', approve: true }), p.id)
    await page.evaluate((d) => (window as unknown as { __fbView: { getState: () => { goTask: (id: string) => void } } }).__fbView.getState().goTask(d), desk.id)
    // Switch the Desk to AI Space through the real view selector.
    await page.getByTestId('view-selector-btn').first().click()
    await page.getByTestId('view-opt-ai').click()
    await expect(page.getByTestId('ais-desk')).toBeVisible()
    await page.getByTestId('ais-tab-overview').focus()
    await page.keyboard.press('End')
    await expect(page.getByTestId('ais-tab-impact')).toHaveAttribute('aria-selected', 'true')
    const row = page.getByTestId('ais-impact-row').first()
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    // Reduced motion: the inspector appears without its slide animation.
    await row.getByRole('button', { name: 'Blog post' }).click()
    const anim = await page.getByTestId('ais-inspector').evaluate((el) => getComputedStyle(el).animationName)
    expect(anim).toBe('none')
  } finally {
    await dispose()
  }
})
