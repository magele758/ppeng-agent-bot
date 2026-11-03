import { test, expect } from '@playwright/test';

test('Bot message island opens a solid dialog across skins and widths [AC:bot-dialog-solid#AC-1] [AC:bot-relay-island#AC-1] [AC:bot-relay-island#AC-2]', async ({ page }) => {
  const id = 'solid-dialog-test';
  const session = { id, title: '弹窗验收', mode: 'chat', status: 'idle', agentId: 'general', metadata: {} };
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: [session] } }));
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`), r => r.fulfill({ json: { session, messages: [{ id: 'm1', seq: 1, role: 'user', parts: [{ type: 'text', text: 'Message from 4090 bot / bot_test: 健康检查结果\n\n- 服务正常\n- 消息正文清晰可读' }] }], latestAssistant: '' } }));
  await page.route('**/api/approvals**', r => r.fulfill({ json: { approvals: [] } }));
  await page.goto('/#/chat');
  await page.getByRole('button', { name: /弹窗验收/ }).first().click();
  for (const [skin, width] of [['minimal', 921], ['cyberpunk', 921], ['minimal', 390]] as const) {
    await page.setViewportSize({ width, height: 804 });
    await page.evaluate(s => document.documentElement.setAttribute('data-skin', s), skin);
    const entry = page.locator('.bot-relay-strip');
    await expect(entry).not.toContainText('健康检查结果');
    await expect(entry).toHaveCSS('border-radius', '999px');
    await expect(entry).toHaveCSS('background-image', 'none');
    await expect(entry).toHaveAttribute('aria-expanded', 'false');
    const box = await entry.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/relay-island-${skin}-${width}.png` });
    await entry.focus();
    if (width === 390) await entry.click(); else await page.keyboard.press('Enter');
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
    await expect(entry).toBeFocused();
    await expect(entry).toHaveAttribute('aria-expanded', 'false');
  }
});
