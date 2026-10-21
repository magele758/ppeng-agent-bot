import { test, expect } from '@playwright/test';

// Controlled API responses cover UI state transitions; backend recovery is tested separately.
test('a known task finishing after loading older history remains visible [AC:default-super-bot#AC-8]', async ({ page }) => {
  let paged = false;
  const current = { id: 'recovery-current', targetBotId: 'super-bot', input: 'Known task finishes after pagination', status: 'running' };
  const older = { id: 'recovery-older', targetBotId: 'super-bot', input: 'Older closed task', status: 'completed' };
  await page.route('**/api/bot-work/tasks?*', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('cursor')) {
      paged = true;
      return route.fulfill({ json: { tasks: [current, older], activeTasks: [current], historyTasks: [older], nextCursor: null, hasMore: false } });
    }
    const task = paged ? { ...current, status: 'completed', result: 'Recovered final result' } : current;
    return route.fulfill({ json: { tasks: [task], activeTasks: paged ? [] : [task], historyTasks: paged ? [task] : [], nextCursor: paged ? null : 'older', hasMore: !paged } });
  });
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await expect(panel.locator('article').filter({ hasText: current.input })).toContainText('执行中');
  await panel.getByTestId('bot-work-history-toggle').click();
  await panel.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(panel.locator('article').filter({ hasText: current.input })).toContainText('已完成', { timeout: 10000 });
  await expect(panel.locator('article').filter({ hasText: older.input })).toBeVisible();
});

test('a cancelled routine with unconfirmed effects still requires explicit retry verification [AC:bot-routine-lifecycle#AC-3]', async ({ page, request }) => {
  const { bot } = await (await request.post('/api/bots', { data: { name: `Recovery UI ${Date.now()}` } })).json();
  const { job } = await (await request.post('/api/cron/jobs', { data: { botId: bot.id, name: 'Recovery UI fixture', prompt: 'Reply ready.', onceAt: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC' } })).json();
  const retryBodies: unknown[] = [];
  let run = { id: 'fixture-cancelled-unknown', status: 'cancelled', requiresEffectVerification: true, scheduledAt: new Date().toISOString(), attempt: 1 };
  await page.route(`**/api/cron/jobs/${job.id}/runs*`, route => route.fulfill({ json: { runs: [run] } }));
  await page.route('**/api/cron/runs/fixture-cancelled-unknown/retry', route => {
    const body = route.request().postDataJSON(); retryBodies.push(body);
    if (body.confirmUnknown !== true) return route.fulfill({ status: 400, json: { error: 'Effect verification required' } });
    run = { ...run, status: 'queued', requiresEffectVerification: false, attempt: 2 };
    return route.fulfill({ status: 202, json: { run } });
  });
  await page.goto('/#/agents/bots');
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page.getByTestId('bot-detail').getByRole('button', { name: '展开或收起：定时任务' }).click();
  const panel = page.locator('.bot-cron-panel');
  await panel.getByRole('button', { name: '运行记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '重试', exact: true })).toBeDisabled();
  expect(retryBodies).toEqual([]);
  await panel.getByLabel('已核对外部副作用，允许重新执行', { exact: true }).check();
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(() => retryBodies).toEqual([{ confirmUnknown: true }]);
  await expect(panel.getByText('排队中', { exact: true })).toBeVisible();
});
