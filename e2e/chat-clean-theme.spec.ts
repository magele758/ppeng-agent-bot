import { expect, test } from '@playwright/test';

test('经典浅色使用干净的阅读底色 [AC:chat-clean-theme#AC-1] [AC:chat-clean-theme#AC-2]', async ({ page }) => {
  await page.goto('/');
  await page.locator('.lab-shell').first().waitFor();
  await page.evaluate(() => {
    Object.assign(document.documentElement.dataset, { theme: 'light', skin: 'classic' });
    const panel = document.createElement('section');
    panel.id = 'theme-sample';
    panel.className = 'chat-panel-body';
    panel.innerHTML = '<div class="chat-bubble__body chat-bubble__md"><p>示例</p></div><div class="chat-turn chat-turn--user"><div class="chat-bubble">问题</div></div><div class="chat-composer"><button>+</button><div class="chat-composer-field">消息</div></div>';
    document.querySelector('.lab-shell')!.append(panel);
  });
  await expect(page.locator('#theme-sample .chat-turn--user .chat-bubble')).toHaveCSS('border-radius', '18px', {timeout:1500});
  const field = await page.locator('#theme-sample .chat-composer-field').boundingBox();
  const button = await page.locator('#theme-sample button').boundingBox();
  expect(field!.y + field!.height).toBeLessThanOrEqual(button!.y);
  await expect(page.locator('body')).toHaveCSS('background-image', 'none', {timeout:1500});
  await expect(page.locator('#theme-sample p')).toHaveCSS('color', 'rgb(51, 60, 57)');
  await expect(page.locator('#theme-sample .chat-composer')).toHaveCSS('box-shadow', 'none');
});

test('会话与群聊使用同一选择样式和输入布局 [AC:chat-clean-theme#AC-3]', async ({ page }) => {
  const room = { id: 'layout', title: 'Layout', botIds: ['writer'], hostBotId: 'writer', status: 'active' };
  await page.route('**/api/bot-rooms', route => route.fulfill({ json: { rooms: [room] } }));
  await page.route('**/api/bot-rooms/layout', route => route.fulfill({ json: { room } }));
  await page.route('**/api/bot-rooms/layout/messages*', route => route.fulfill({ json: { messages: [], hasMore: false } }));
  await page.route('**/api/bot-rooms/layout/turns', route => route.fulfill({ json: { turns: [] } }));
  await page.goto('/#/bot');
  const row = page.locator('.list-item--group').filter({ hasText: 'Layout' }).first();
  await row.click();
  await page.evaluate(() => Object.assign(document.documentElement.dataset, { theme: 'light', skin: 'classic' }));
  await expect(row).toHaveCSS('border-radius', '12px');
  await expect(row).toHaveCSS('background-color', 'rgb(240, 243, 241)');
  const panel = page.getByTestId('play-group-chat');
  const form = panel.locator('.play-group-composer');
  const field = await form.locator('textarea').boundingBox();
  const send = await form.locator('button[type="submit"]').boundingBox();
  expect(field!.y + field!.height).toBeLessThanOrEqual(send!.y);
  const track = await panel.locator('.chat-feed__track').boundingBox();
  const composer = await form.boundingBox();
  expect(composer!.x).toBeCloseTo(track!.x, 0);
  expect(composer!.width).toBeCloseTo(track!.width, 0);
});
