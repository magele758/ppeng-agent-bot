import { test, expect } from '@playwright/test';

test('Lab saves external Agent grants and executor changes take effect immediately [AC:external-agent-task-handoff#AC-5]', async ({ page, request }) => {
  const path = '/api/external-agents/settings';
  const before = await request.get(path);
  expect(before.ok()).toBeTruthy();
  const settings = (await before.json()).settings;
  const id = `e2e-${Date.now()}`;
  const token = `handoff-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  try {
    await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
    await page.goto('/#/settings/integrations');
    const card = page.locator('#card-externalAgents');
    await expect(card).toBeVisible();
    await card.getByRole('switch', { name: '启用外部任务交接', exact: true }).check();
    await card.getByRole('button', { name: '添加接入方', exact: true }).click();
    const client = card.locator('[data-external-agent-client]').last();
    await client.getByLabel('接入方标识', { exact: true }).fill(id);
    await client.getByLabel('名称', { exact: true }).fill('E2E handoff');
    await client.getByLabel('接入凭证', { exact: true }).fill(token);
    await client.getByLabel('允许的执行者', { exact: true }).fill('general');
    await client.getByLabel('默认执行者', { exact: true }).fill('general');
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await expect(card.getByRole('status')).toBeVisible();
    await expect(client.getByLabel('接入凭证', { exact: true })).toHaveValue('');
    const submitted = await request.post('/api/external-agent/v1/tasks', {
      headers: { authorization: `Bearer ${token}` },
      data: { source: id, sourceTaskId: '1', goal: 'Reply with ready' }
    });
    expect(submitted.status()).toBe(202);
    const taskId = (await submitted.json()).task.id;
    await expect.poll(async () => {
      const r = await request.get(`/api/external-agent/v1/tasks/${taskId}`, { headers: { authorization: `Bearer ${token}` } });
      return (await r.json()).task.status;
    }).toBe('completed');
    await client.getByLabel('允许的执行者', { exact: true }).fill('main');
    await client.getByLabel('默认执行者', { exact: true }).fill('main');
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await expect(card.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    const denied = await request.post('/api/external-agent/v1/tasks', {
      headers: { authorization: `Bearer ${token}` },
      data: { source: id, sourceTaskId: '2', goal: 'Reply with ready', agentId: 'general' }
    });
    expect(denied.status()).toBe(403);
    await page.reload();
    await expect(card.locator('[data-external-agent-client]').last().getByLabel('默认执行者', { exact: true })).toHaveValue('main');
    await card.screenshot({ path: test.info().outputPath('settings.png') });
  } finally {
    await request.patch(path, { data: settings });
  }
});
