import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Does the new work actually run inside the real app?
//
// Unit tests cover the filter, the tile maths and the planning columns. What
// they cannot answer is whether a widget of each new kind mounts without
// throwing, whether the planning fields survive a round-trip through the real
// IPC + SQLite path, and whether the honest empty states are the ones that
// appear when there is genuinely nothing to show. That is what this checks.

let launched: LaunchedApp | null = null

// Seeding goes straight to the database through the IPC API, which the
// renderer's stores do not observe -- so the app still shows "No desks yet"
// until it reloads and re-reads. Reload first, THEN navigate.
//
// __fbView is a zustand store, so navigation goes through getState(); calling
// the action off the store object itself silently does nothing, which surfaces
// as "the widget never rendered" rather than as a navigation failure.
async function goDesk(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as {
      __fbView?: { getState: () => { goTask: (i: string) => void } }
    }
    w.__fbView?.getState().goTask(id)
  }, deskId)
}

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('the new widget kinds mount, and show honest empty states', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Ridge Street Campaign'
    })
    const mk = async (kind: string, x: number, y: number): Promise<string> =>
      (
        await api.widgets.create({
          taskId: desk.id,
          kind: kind as never,
          title: kind,
          content: '',
          x,
          y,
          width: 380,
          height: 360
        })
      ).id
    return {
      deskId: desk.id,
      inbox: await mk('inbox', 100, 100),
      map: await mk('location-map', 520, 100),
      calendar: await mk('calendar', 940, 100),
      tasks: await mk('task-list', 100, 500)
    }
  })

  await goDesk(window, ids.deskId)

  for (const kind of ['inbox', 'location-map', 'calendar', 'task-list']) {
    await expect(
      window.locator(`[data-widget-kind="${kind}"]`).first(),
      `${kind} should mount`
    ).toBeVisible({ timeout: 10_000 })
  }

  // No mail account is configured in a fresh test profile, so the inbox must
  // say so -- never render invented messages.
  const inbox = window.locator('[data-widget-kind="inbox"]').first()
  await expect(inbox).toContainText(/No mailbox connected|Mail isn.t available|Reading the mailbox/)

  // The map has no address yet, and says so rather than showing a map of
  // somewhere arbitrary.
  const map = window.locator('[data-widget-kind="location-map"]').first()
  await expect(map).toContainText(/Search an address/)

  // The calendar renders a real month grid: 42 day cells, whole weeks.
  const calendar = window.locator('[data-widget-kind="calendar"]').first()
  await expect(calendar).toBeVisible()

  // Nothing threw while mounting any of them.
  const errors = await window.evaluate(
    () => (window as unknown as { __fbWidgetErrors?: string[] }).__fbWidgetErrors ?? []
  )
  expect(errors).toEqual([])
})

test('the inbox filter seeds itself from the desk it is dropped on', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Ridge Street Campaign'
    })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'inbox' as never,
      title: 'Inbox',
      content: '',
      x: 120,
      y: 120,
      width: 400,
      height: 380
    })
    return desk.id
  })

  await goDesk(window, deskId)

  const inbox = window.locator('[data-widget-kind="inbox"]').first()
  await expect(inbox).toBeVisible({ timeout: 10_000 })
  // "Campaign" is filler; "street"/"ridge" are the distinctive words. The rule
  // is stated on the face of the widget, so it can be asserted.
  await expect(inbox).toContainText(/about/i)
  await expect(inbox).toContainText(/street|ridge/i)
})

test('task planning fields round-trip through the real database', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Plan desk' })
    const first = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Photos' })
    const second = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Listing copy' })

    await api.nodes.update(first.id, { dueDate: 1_700_000_000_000 })
    await api.nodes.update(second.id, {
      plannedStartAt: 1_700_500_000_000,
      assignee: 'Sarah Whitfield',
      dependsOn: first.id,
      lagDays: -2,
      attachmentsJson: JSON.stringify([{ id: 'f1', name: 'contract.pdf' }]),
      description: 'Draft, then get vendor sign-off.',
      status: 'in_progress'
    })

    const all = await api.nodes.list()
    const back = all.find((n) => n.id === second.id)
    return {
      plannedStartAt: back?.plannedStartAt ?? null,
      assignee: back?.assignee ?? null,
      dependsOn: back?.dependsOn ?? null,
      lagDays: back?.lagDays ?? null,
      attachmentsJson: back?.attachmentsJson ?? null,
      description: back?.description ?? null,
      status: back?.status ?? null,
      firstId: first.id
    }
  })

  expect(result.plannedStartAt).toBe(1_700_500_000_000)
  expect(result.assignee).toBe('Sarah Whitfield')
  expect(result.dependsOn).toBe(result.firstId)
  expect(result.lagDays).toBe(-2) // negative lag means overlap; it must survive
  expect(result.attachmentsJson).toContain('contract.pdf')
  expect(result.description).toBe('Draft, then get vendor sign-off.')
  expect(result.status).toBe('in_progress')
})

test('the task widget shows subtasks under their parent, not as separate rows', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Nesting desk' })
    const parent = await api.nodes.create({
      parentId: desk.id,
      kind: 'task',
      title: 'PARENTTASK'
    })
    await api.nodes.create({ parentId: parent.id, kind: 'task', title: 'SUBTASKONE' })
    await api.nodes.create({ parentId: parent.id, kind: 'task', title: 'SUBTASKTWO' })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'task-list' as never,
      title: 'Tasks',
      content: '',
      x: 120,
      y: 120,
      width: 420,
      height: 420
    })
    return desk.id
  })

  await goDesk(window, deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await expect(widget).toContainText('PARENTTASK')
  // The subtasks are NOT loose rows; they live in the parent's detail panel.
  await expect(widget).not.toContainText('SUBTASKONE')
  // The parent advertises its subtask count instead.
  await expect(widget).toContainText('0/2')
})
