import { test, expect } from '@playwright/test';

test('inbox shows the full proposed message and target before approval [AC:bot-product-p0#AC-4]', async ({ page }) => {
  let pending = true;
  const content = `Actual outgoing message ${'detail '.repeat(70)}END-OF-MESSAGE`;
  await page.route('**/api/approvals**', route => {
    if (route.request().method() === 'POST') { pending = false; return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { approvals: pending ? [{
      id: 'p0-approval', sessionId: 'p0-source', toolName: 'send_message', reason: 'Send the reviewed report',
      status: 'pending', args: { receiveId: 'project-team', text: content, apiKey: 'not-for-display' },
    }] : [] } });
  });
  await page.goto('/#/tasks/inbox');
  const preview = page.getByTestId('approval-action-preview');
  await expect(preview).toContainText('project-team');
  await expect(preview).toContainText('END-OF-MESSAGE');
  await preview.locator('summary').click();
  await expect(preview).not.toContainText('not-for-display');
  await page.locator('#listApprovals').getByRole('button', { name: /批准/ }).click();
  await expect(preview).toHaveCount(0);
});

test('unknown task requires explicit verification before retry and links to its own connections [AC:bot-product-p0#AC-5]', async ({ page }) => {
  let task = { id: 'p0-unknown', targetBotId: 'worker', input: 'Reconcile external operation', status: 'unknown' };
  const attempts: unknown[] = [];
  await page.route('**/api/bot-work/tasks?*', route => route.fulfill({ json: { tasks: [task], activeTasks: [task], historyTasks: [] } }));
  await page.route('**/api/bot-work/tasks/p0-unknown', route => route.fulfill({ json: { task } }));
  await page.route('**/api/bot-work/tasks/p0-unknown/retry', route => {
    attempts.push(route.request().postDataJSON());
    task = { ...task, status: 'queued' };
    return route.fulfill({ json: { task } });
  });
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await panel.getByRole('button', { name: '详情', exact: true }).click();
  const detail = panel.locator('aside');
  await expect(detail.getByRole('link', { name: '检查连接与核对软件操作' })).toHaveAttribute('href', '#/agents/bots?bot=worker&focus=connections');
  await expect(detail.getByRole('button', { name: '重试', exact: true })).toBeDisabled();
  expect(attempts).toEqual([]);
  await detail.getByRole('checkbox').check();
  await detail.getByRole('button', { name: '重试', exact: true }).click();
  await expect(detail).toContainText('排队中');
  expect(attempts).toEqual([{ confirmUnknown: true }]);
});

test('cancelled task explains that completed effects are not undone after refresh [AC:bot-product-p0#AC-8]', async ({ page }) => {
  let task = { id: 'p0-cancel', targetBotId: 'worker', input: 'Work to stop', status: 'running' };
  await page.route('**/api/bot-work/tasks?*', route => route.fulfill({ json: {
    tasks: [task], activeTasks: task.status === 'running' ? [task] : [], historyTasks: task.status === 'cancelled' ? [task] : [],
  } }));
  await page.route('**/api/bot-work/tasks/p0-cancel', route => route.fulfill({ json: { task } }));
  await page.route('**/api/bot-work/tasks/p0-cancel/cancel', route => {
    task = { ...task, status: 'cancelled' };return route.fulfill({ json: { task } });
  });
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await panel.getByRole('button', { name: '详情', exact: true }).click();
  await expect(panel.locator('aside')).toContainText('此前已生效的外部操作不会因此撤销');
});
