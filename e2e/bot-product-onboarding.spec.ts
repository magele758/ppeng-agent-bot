import { test, expect } from '@playwright/test';
import { allocateBot, openFirstBot, presentAsNewBotUser } from './helpers/bot-first-task';

test('a new Bot offers a first task without claiming unconnected software [AC:bot-product-p1#AC-1] [AC:bot-product-p1#AC-2]', async ({ page, request }) => {
  await presentAsNewBotUser(page);
  const held = await allocateBot(request);
  try {
  const bot = held.bot;
  await openFirstBot(page, bot.id);
  await page.locator('#sessionListMini .list-item--bot-chat').filter({ hasText: bot.name }).click();
  const guide = page.getByTestId('bot-first-task');
  await expect(guide).toContainText('第一件事');
  await guide.getByRole('button', { name: '整理我提供的材料', exact: true }).click();
  await expect(page.locator('#playInput')).toHaveValue(/材料/);
  await expect(guide.getByRole('link', { name: '检查软件连接' })).toHaveAttribute('href', /focus=connections/);
  } finally {
    await held.release();
  }
});

test('guided HTTP binding persists and reports an unsuccessful check honestly [AC:bot-product-p1#AC-3] [AC:bot-product-p1#AC-5] [AC:bot-product-p1#AC-6] [AC:bot-product-p1#AC-8]', async ({ page, request }) => {
  const { bot } = await (await request.post('/api/bots', { data: { name: `Guided connection ${crypto.randomUUID()}` } })).json();
  await page.route(`**/api/bots/${bot.id}/connections/guided-http/probe`, route => route.fulfill({ json: {
    connection: { connectorId: 'guided-http', health: 'unavailable', healthReason: 'authorization_required', lastProbeAt: new Date().toISOString(), tools: [] },
  } }));
  await page.goto(`/#/agents/bots?bot=${encodeURIComponent(bot.id)}&focus=connections`);
  const wizard = page.getByTestId('bot-connection-wizard');
  await wizard.getByLabel('连接名称', { exact: true }).fill('guided-http');
  await wizard.getByLabel('操作名称', { exact: true }).fill('guided_http_read');
  await wizard.getByLabel('能完成的任务', { exact: true }).fill('Read project status');
  await wizard.getByLabel('服务地址', { exact: true }).fill('https://example.com/status');
  await wizard.getByRole('button', { name: '保存连接', exact: true }).click();
  const row = page.getByTestId('bot-connections').locator('article').filter({ has: page.getByRole('heading', { name: 'guided-http', exact: true }) });
  await expect(row).toContainText('Read project status');
  await expect(row).toContainText('已配置');
  await expect(row).toContainText('读取信息（GET）');
  await expect(row).toContainText('尚未验证');
  await row.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByTestId('bot-connections')).toContainText('连接验证未通过');
  await page.reload();
  await expect(row).toContainText('Read project status');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(wizard.getByRole('button', { name: 'Save connection', exact: true })).toBeVisible();
});

test('first delivery can be revised with a persistent source version [AC:bot-product-p1#AC-7] [AC:bot-product-p2#AC-1]', async ({ page, request }) => {
  const { bot } = await (await request.post('/api/bots', { data: { name: `First delivery ${crypto.randomUUID()}` } })).json();
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-team-work');
  await panel.getByLabel('执行 Bot', { exact: true }).selectOption(bot.id);
  await panel.getByLabel('工作内容', { exact: true }).fill('Reply ready.');
  await panel.getByRole('button', { name: '分派任务', exact: true }).click();
  let taskId = '';
  await expect.poll(async () => {
    const { tasks } = await (await request.get('/api/bot-work/tasks')).json();
    const task = tasks.find((row: { targetBotId: string }) => row.targetBotId === bot.id);
    taskId = task?.id ?? '';
    return task?.status;
  }).toBe('completed');
  const { task } = await (await request.get(`/api/bot-work/tasks/${taskId}`)).json();
  expect(task.delivery.report).toBeTruthy();
  await panel.getByTestId('bot-work-history-toggle').click();
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.locator('article').filter({ hasText: bot.name }).getByRole('button', { name: '详情', exact: true }).click();
  const delivery = panel.getByTestId('bot-task-delivery');
  await expect(delivery.locator('.markdown-body')).toHaveText(task.delivery.report);
  await expect(delivery).toContainText('目标尚未验证');
  await expect(delivery.getByRole('link', { name: '导出报告', exact: true })).toBeVisible();
  await delivery.getByRole('button', { name: '基于此版本继续修改', exact: true }).click();
  await expect(panel).toContainText(`将沿用任务 ${taskId}`);
  await panel.getByLabel('工作内容', { exact: true }).fill('Add a short conclusion.');
  const revised = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/bot-work/tasks'));
  await panel.getByRole('button', { name: '分派任务', exact: true }).click();
  const created = (await (await revised).json()).task;
  const latest = await (await request.get(`/api/bot-work/tasks/${created.id}`)).json();
  expect(latest.task.sourceDelivery).toEqual({ taskId, attempt: task.delivery.attempt });
  const original = await (await request.get(`/api/bot-work/tasks/${taskId}`)).json();
  expect(original.task.delivery).toEqual(task.delivery);
});

test('separate guided connections never overwrite each other’s saved credential [AC:bot-product-p1#AC-6]', async ({ page, request }) => {
  const { bot } = await (await request.post('/api/bots', { data: { name: `Credential isolation ${crypto.randomUUID()}` } })).json();
  const secretPaths: string[] = [];
  await page.route('**/api/secrets/*', route => {
    secretPaths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/bots/${bot.id}/connections/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ json: { connection: {} } }) : route.continue());
  await page.goto(`/#/agents/bots?bot=${bot.id}&focus=connections`);
  const wizard = page.getByTestId('bot-connection-wizard');
  for (const name of ['first', 'second']) {
    await wizard.getByLabel('连接名称', { exact: true }).fill(name);
    await wizard.getByLabel('操作名称', { exact: true }).fill(`${name}_read`);
    await wizard.getByLabel('能完成的任务', { exact: true }).fill('Read status');
    await wizard.getByLabel('服务地址', { exact: true }).fill('https://example.com/status');
    await wizard.getByLabel('访问密钥（可选，仅保存不回显）', { exact: true }).fill(`test-only-${name}`);
    await wizard.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(wizard.getByLabel('访问密钥（可选，仅保存不回显）', { exact: true })).toHaveValue('');
  }
  expect(secretPaths).toHaveLength(2);
  expect(secretPaths[0]).not.toBe(secretPaths[1]);
});

test('OpenAPI file form grants only selected read scope without hand-written tool definitions [AC:bot-product-p1#AC-3] [AC:bot-product-p1#AC-5]', async ({ page, request }) => {
  const { bot } = await (await request.post('/api/bots', { data: { name: `File connection ${crypto.randomUUID()}` } })).json();
  await page.goto(`/#/agents/bots?bot=${bot.id}&focus=connections`);
  const wizard = page.getByTestId('bot-connection-wizard');
  await wizard.getByLabel('连接方式', { exact: true }).selectOption('openapi');
  await wizard.getByLabel('连接名称', { exact: true }).fill('file-api');
  await wizard.getByLabel('选择接口说明文件', { exact: true }).setInputFiles({
    name: 'api.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      openapi: '3.0.0', servers: [{ url: 'https://example.com' }],
      paths: { '/status': { get: { operationId: 'file_read', summary: 'Read status' } },
        '/update': { post: { operationId: 'file_write', summary: 'Update status' } } },
    })),
  });
  await wizard.getByRole('button', { name: '保存连接', exact: true }).click();
  const row = page.getByTestId('bot-connections').locator('article').filter({ has: page.getByRole('heading', { name: 'file-api', exact: true }) });
  await expect(row).toContainText('Read status');
  await expect(row).not.toContainText('Update status');
  const { connections } = await (await request.get(`/api/bots/${bot.id}/connections`)).json();
  expect(connections[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['file_read']);
});
