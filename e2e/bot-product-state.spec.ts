import { test, expect } from './helpers/bot-pair';

test('Bot list and chat header expose the same queued and blocked work [AC:bot-product-p0#AC-2]', async ({ page, botPair: bots }) => {
  await page.route('**/api/bot-work/status', route => route.fulfill({ json: { bots: bots.map(bot => ({
    bot, activeWorkCount: 2, pending: 3, status: 'waiting_approval', taskCounts: { waiting_approval: 1, unknown: 1 },
  })) } }));
  await page.goto('/#/bot');
  const row = page.locator('#sessionListMini .list-item--bot-chat').filter({ has: page.getByTestId(`bot-work-summary-${bots[0].id}`) });
  const summary = row.getByTestId(`bot-work-summary-${bots[0].id}`);
  await expect(summary).toContainText('已接收 · 排队 3');
  await expect(summary).toContainText('等待你处理 1');
  await expect(summary).toContainText('结果待核对 1');
  await row.click();
  await expect(page.locator('.chat-panel-header').getByTestId(`bot-work-summary-${bots[0].id}`)).toHaveText(await summary.innerText());
});

test('connection loss preserves last work and reconnects without reporting idle [AC:bot-product-p0#AC-3]', async ({ page, botPair: bots }) => {
  let disconnected = false;
  let count = 1;
  await page.route('**/api/bot-work/status', route => disconnected
    ? route.abort()
    : route.fulfill({ json: { bots: bots.map(bot => ({ bot, activeWorkCount: bot.id === bots[0].id ? count : 0 })) } }));
  await page.goto('/#/bot');
  const row = page.locator('#sessionListMini .list-item--bot-chat').filter({ has: page.getByTestId(`bot-work-summary-${bots[0].id}`) });
  await expect(row.locator('[data-face-working]').first()).toHaveAttribute('data-face-working', 'true');
  disconnected = true;
  await expect(page.getByTestId('bot-work-connection')).toContainText('暂不可确认');
  await expect(page.getByTestId('bot-work-connection').locator('time')).toHaveAttribute('datetime', /T/);
  await expect(row.locator('[data-face-working]').first()).toHaveAttribute('data-face-working', 'true');
  disconnected = false; count = 0;
  await expect(page.getByTestId('bot-work-connection')).toHaveCount(0);
  await expect(row.locator('[data-face-working]').first()).toHaveAttribute('data-face-working', 'false');
});

test('task detail receives refreshed outcome and failed polling is visible [AC:bot-product-p0#AC-3]', async ({ page }) => {
  let disconnected = false;
  let task = { id: 'p0-state', targetBotId: 'super-bot', input: 'P0 retained work', status: 'running' };
  await page.route('**/api/bot-work/tasks?*', route => disconnected ? route.abort() : route.fulfill({ json: {
    tasks: [task], activeTasks: task.status === 'running' ? [task] : [], historyTasks: task.status === 'running' ? [] : [task],
  } }));
  await page.route('**/api/bot-work/tasks/p0-state', route => route.fulfill({ json: { task } }));
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await panel.locator('article').filter({ hasText: task.input }).getByRole('button', { name: '详情', exact: true }).click();
  await expect(panel.locator('aside')).toContainText('执行中');
  disconnected = true;
  await expect(panel.getByTestId('bot-task-connection')).toContainText('暂不可确认');
  await expect(panel.locator('aside')).toContainText('执行中');
  task = { ...task, status: 'failed' }; disconnected = false;
  await expect(panel.getByTestId('bot-task-connection')).toHaveCount(0);
  await expect(panel.locator('aside')).toContainText('失败');
});

test('retrying an unconfirmed dispatch reuses its acceptance identity [AC:bot-product-p0#AC-1]', async ({ page, botPair: bots }) => {
  const submissions: Array<{ idempotencyKey: string }> = [];
  await page.route('**/api/bot-work/tasks?*', route => route.fulfill({ json: { tasks: [], activeTasks: [], historyTasks: [] } }));
  await page.route('**/api/bot-work/tasks', route => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'Connection interrupted after acceptance' } });
  });
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await panel.getByRole('combobox').selectOption(bots[0].id);
  await panel.getByLabel('工作内容', { exact: true }).fill('Do this work once');
  await panel.getByRole('button', { name: '分派任务', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button', { name: '分派任务', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].idempotencyKey).toBe(submissions[0].idempotencyKey);
});
