import { test, expect, type Page } from '@playwright/test';

async function openGroup(page: Page) {
  await page.setViewportSize({ width: 857, height: 804 });
  const bots = Array.from({ length: 9 }, (_, i) => ({ id: `member${i}`, name: `Member ${i}` }));
  const room = { id: 'active-header', title: 'Active header', botIds: bots.slice(0, 3).map(b => b.id), hostBotId: bots[0].id, status: 'active', maxBotTurns: 8, maxToolCalls: 100, maxCostUsd: 1 };
  const active = ['member0', 'member8'];

  await page.route('**/api/bots', r => r.fulfill({ json: { bots } }));
  await page.route('**/api/bot-work/status', r => r.fulfill({ json: { bots: bots.map(bot => ({ bot, activeWorkCount: active.includes(bot.id) ? 1 : 0 })) } }));
  await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [{ id: 'dev', name: 'Dev', botIds: ['member0', 'member1'] }] } }));
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [room] } }));
  await page.route('**/api/bot-rooms/active-header', r => r.fulfill({ json: { room } }));
  await page.route('**/api/bot-rooms/active-header/messages*', r => r.fulfill({ json: { messages: [], hasMore: false, nextCursor: null } }));
  await page.route('**/api/bot-rooms/active-header/turns', r => r.fulfill({ json: { turns: [] } }));
  await page.goto('/#/bot');
  await page.getByRole('button', { name: '打开群聊 Active header', exact: true }).click();
}

test('connection notice floats without shifting navigation or content [AC:group-chat-stable-layout#AC-1]', async ({ page }) => {
  let offline = false;
  await page.route('**/api/bot-work/status', route => offline
    ? route.abort()
    : route.fulfill({ json: { bots: [] } }));
  await page.goto('/#/bot');
  const rail = page.locator('.lab-rail');
  const main = page.locator('#lab-main');
  await expect(rail).toBeVisible();
  const positions = async () => Promise.all([rail, main].map(el => el.evaluate(node => node.getBoundingClientRect().top)));
  const before = await positions();
  await page.waitForResponse(r => r.url().endsWith('/api/bot-work/status') && r.ok());
  offline = true;
  const notice = page.getByTestId('bot-work-connection');
  await expect(notice.locator('time')).toBeVisible();
  expect(await positions()).toEqual(before);
  await expect(notice).toHaveCSS('pointer-events', 'none');
  offline = false;
  await expect(notice).toHaveCount(0);
  expect(await positions()).toEqual(before);
});

test('group message text has no inner frame and send sits alongside it [AC:group-chat-stable-layout#AC-2]', async ({ page }) => {
  await openGroup(page);
  const form = page.getByTestId('composer-drop-target').filter({ has: page.getByTestId('play-group-send') });
  const text = form.locator('textarea');
  await text.fill('第一行\n第二行');
  await text.focus();
  const box = (await text.boundingBox())!;
  const button = (await form.getByTestId('play-group-send').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(button.x + 1);
  expect(button.y).toBeLessThan(box.y + box.height);
  await expect(text).toHaveCSS('border-top-width', '0px');
  await expect(text).toHaveCSS('box-shadow', 'none');
});
