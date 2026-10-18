import { test, expect } from '@playwright/test';

test('Bot tasks retain existing history and dispatch work from Tasks [AC:bot-entry-simplification#AC-5]', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  let assigned = false;
  const oldTask = { id: 'task-existing', targetBotId: 'test-bot', input: '既有工作', status: 'completed', result: '历史结果仍然可读' };
  await page.route('**/api/bots', route => route.fulfill({ json: { bots: [{ id: 'test-bot', name: '测试执行 Bot', agentId: 'general' }] } }));
  await page.route('**/api/bot-work/tasks?*', route => route.fulfill({ json: { tasks: [oldTask, ...(assigned ? [{ id: 'new-task', targetBotId: 'test-bot', input: '新的工作', status: 'queued' }] : [])], activeTasks: [], historyTasks: [oldTask] } }));
  await page.route('**/api/bot-work/tasks/task-existing', route => route.fulfill({ json: { task: oldTask } }));
  await page.route('**/api/bot-work/tasks', async route => { expect(route.request().postDataJSON().targetBotId).toBe('test-bot'); assigned = true; await route.fulfill({ json: { task: { id: 'new-task' } } }); });
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await expect(panel.getByRole('heading', { name: 'Bot 任务', exact: true })).toBeVisible();
  await expect(panel.getByTestId('bot-team-work-lead')).toContainText('功能分组');
  await expect(panel.getByTestId('bot-team-work-lead')).toContainText('群聊');
  await panel.getByRole('button', { name: '详情', exact: true }).click();
  await expect(panel.getByText('历史结果仍然可读')).toBeVisible();
  await panel.getByRole('combobox', { name: '执行 Bot', exact: true }).selectOption('test-bot');
  await panel.getByLabel('工作内容', { exact: true }).fill('新的工作');
  await panel.getByRole('button', { name: '分派任务', exact: true }).click();
  await expect(panel.getByText('测试执行 Bot: 新的工作')).toBeVisible();
});

test('Bot global limits live in Settings with save and failure feedback [AC:bot-entry-simplification#AC-6]', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  let context = 65536; let perBot = 20; let fail = false;
  await page.route('**/api/bot-context-settings', async route => {
    if (route.request().method() !== 'GET') {
      if (fail) return route.fulfill({ status: 500, json: { error: '限制保存失败' } });
      context = route.request().postDataJSON().fallbackContextTokens;
    }
    await route.fulfill({ json: { settings: { fallbackContextTokens: context } } });
  });
  await page.route('**/api/bot-work/settings', async route => {
    if (route.request().method() !== 'GET') perBot = route.request().postDataJSON().perBot;
    await route.fulfill({ json: { settings: { perBot, perPrincipal: 200 } } });
  });
  await page.goto('/#/settings/behavior');
  const panel = page.getByTestId('bot-global-limits');
  await expect(panel.getByRole('heading', { name: 'Bot 运行限制', exact: true })).toBeVisible();
  await expect(panel.getByLabel('保守上下文窗口', { exact: true })).toHaveValue('65536');
  await panel.getByLabel('每个 Bot 最大待处理数', { exact: true }).fill('30');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('已保存，立即生效');
  await page.reload();
  await expect(panel.getByLabel('每个 Bot 最大待处理数', { exact: true })).toHaveValue('30');
  fail = true;
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('限制保存失败');
  await expect(panel.getByText('已保存，立即生效')).toHaveCount(0);
});
