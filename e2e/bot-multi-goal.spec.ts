import { test, expect } from '@playwright/test';

let createdBotId = '';
test.afterEach(async ({ request }) => {
  if (createdBotId) await request.delete(`/api/bots/${createdBotId}`);
  createdBotId = '';
});

test('goal settings save without restart and goal controls preserve other work [AC:bot-multi-goal-coordination#AC-14]', async ({ page, request }) => {
  const name = `Goals ${Date.now()}`;
  const response = await request.post('/api/bots', { data: { name } });
  const { bot } = await response.json();
  createdBotId = bot.id;
  const opened = await request.post(`/api/bots/${bot.id}/open`);
  const { session } = await opened.json();
  let settings = { maxConcurrent: 2, defaultBudgetUsd: 10, maxAttempts: 8, maxNoProgress: 3, leaseMs: 60000, preferredStrategy: 'auto' };
  const goals = [
    { id: 'g-login', title: 'Fix login', status: 'running', progress: 'Found invalid cookie', nextStep: 'Verify login', strategy: 'subagent', strategyReason: 'Independent investigation', priority: 0, evidence: ['Reproduced failure'], budgetUsd: 10, costUsd: 1 },
    { id: 'g-deploy', title: 'Watch deployment', status: 'waiting', progress: 'Build running', nextStep: 'Wait for deployment event', priority: 0, evidence: [] }
  ];
  await page.route(`**/api/bots/${bot.id}/goals**`, async route => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON();
      expect(body.sessionId).toBe(session.id);
      settings = { ...settings, ...body };
      await route.fulfill({ json: { settings } });
    } else if (req.method() === 'POST') {
      const body = req.postDataJSON();
      expect(body.sessionId).toBe(session.id);
      goals[0].status = body.action === 'pause' ? 'paused' : 'running';
      await route.fulfill({ json: { goal: goals[0] } });
    } else await route.fulfill({ json: { goals, settings } });
  });
  await page.goto('/#/agents/bots');
  await page.getByRole('listitem').filter({ hasText: name }).click();
  const panel = page.getByTestId('bot-goals');
  await expect(panel).toBeVisible();
  await panel.locator(':scope > summary').click();
  await expect(panel).toContainText('Found invalid cookie');
  await expect(panel).toContainText('Verify login');
  await expect(panel).toContainText('Independent investigation');
  await expect(panel).toContainText('Reproduced failure');
  await panel.getByText('目标设置', { exact: true }).click();
  await panel.getByLabel('同时执行的目标上限').fill('3');
  await panel.getByLabel('每个目标默认预算（美元）').fill('12');
  await panel.getByLabel('执行偏好').selectOption('subagent');
  await panel.getByRole('button', { name: '保存目标设置' }).click();
  await expect(panel.getByRole('status')).toContainText('已保存');
  expect(settings.maxConcurrent).toBe(3);
  expect(settings.defaultBudgetUsd).toBe(12);
  expect(settings.preferredStrategy).toBe('subagent');
  const login = panel.getByTestId('bot-goal-g-login');
  await login.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(login).toContainText('已暂停');
  await expect(panel.getByTestId('bot-goal-g-deploy')).toContainText('等待中');
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: name }).click();
  await panel.locator(':scope > summary').click();
  await panel.getByText('目标设置', { exact: true }).click();
  await expect(panel.getByLabel('同时执行的目标上限')).toHaveValue('3');
  await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话' }).click();
  await expect(page).toHaveURL(/#\/bot/);
  await expect(panel.getByLabel('下一条消息关联的目标')).toBeAttached();
  await panel.locator(':scope > summary').click();
  await panel.getByLabel('下一条消息关联的目标').selectOption('g-login');
  await expect(panel.locator(':scope > summary')).toContainText('Fix login');
});
