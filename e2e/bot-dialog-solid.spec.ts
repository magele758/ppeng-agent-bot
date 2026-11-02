import { test, expect } from '@playwright/test';

test('Bot message dialog stays solid across skins and closes [AC:bot-dialog-solid#AC-1]', async ({ page }) => {
  const id = 'solid-dialog-test';
  const session = { id, title: '弹窗验收', mode: 'chat', status: 'idle', agentId: 'general', metadata: {} };
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: [session] } }));
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`), r => r.fulfill({ json: { session, messages: [{ id: 'm1', seq: 1, role: 'user', parts: [{ type: 'text', text: 'Message from 4090 bot / bot_test: 健康检查结果\n\n- 服务正常\n- 消息正文清晰可读' }] }], latestAssistant: '' } }));
  await page.route('**/api/approvals**', r => r.fulfill({ json: { approvals: [] } }));
  await page.goto('/#/chat');
  await page.getByRole('button', { name: /弹窗验收/ }).first().click();
  for (const skin of ['minimal', 'cyberpunk']) {
    await page.evaluate(s => document.documentElement.setAttribute('data-skin', s), skin);
    await page.locator('.bot-relay-strip').click();
    const dialog = page.locator('.bot-entry-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('background-image', 'none');
    await expect(dialog).toHaveCSS('backdrop-filter', 'none');
    const color = await dialog.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(color).toMatch(/^rgb\(/);
    await expect(dialog.getByText('服务正常', { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/bot-dialog-solid-${skin}.png` });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});
