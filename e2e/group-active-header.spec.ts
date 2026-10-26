import { test, expect } from '@playwright/test';

test.describe('active header [AC:group-active-header#AC-1] [AC:group-active-header#AC-2] [AC:group-active-header#AC-3]', () => {
for (const size of [3, 7]) {
  test(`working-only header and settings member management with ${size} members [AC:group-active-header#AC-1] [AC:group-active-header#AC-2] [AC:group-active-header#AC-3]`, async ({ page }) => {
    await page.setViewportSize({ width: 857, height: 804 });
    const bots = Array.from({ length: 9 }, (_, i) => ({ id: `member${i}`, name: `Member ${i}` }));
    const room = { id: 'active-header', title: 'Active header', botIds: bots.slice(0, size).map(b => b.id), hostBotId: bots[0].id, status: 'active', maxBotTurns: 8, maxToolCalls: 100, maxCostUsd: 1 };
    let active = ['member0', 'member8'];
    let fail = false;
    await page.route('**/api/bots', r => r.fulfill({ json: { bots } }));
    await page.route('**/api/bot-work/status', r => r.fulfill({ json: { bots: bots.map(bot => ({ bot, activeWorkCount: active.includes(bot.id) ? 1 : 0 })) } }));
    await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [{ id: 'dev', name: 'Dev', botIds: ['member0', 'member1'] }] } }));
    await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [room] } }));
    await page.route('**/api/bot-rooms/active-header', r => r.fulfill({ json: { room } }));
    await page.route('**/api/bot-rooms/active-header/messages*', r => r.fulfill({ json: { messages: [], hasMore: false, nextCursor: null } }));
    await page.route('**/api/bot-rooms/active-header/turns', r => r.fulfill({ json: { turns: [] } }));
    await page.route('**/api/bot-rooms/active-header/members**', r => {
      if (fail) return r.fulfill({ status: 500, json: { error: 'save failed' } });
      if (r.request().method() === 'POST') room.botIds.push(r.request().postDataJSON().botId);
      else room.botIds = room.botIds.filter(id => !r.request().url().endsWith('/' + id));
      return r.fulfill({ json: { room } });
    });
    await page.goto('/#/bot');
    await page.getByRole('button', { name: '打开群聊 Active header', exact: true }).click();
    const panel = page.getByTestId('play-group-chat');
    const strip = panel.getByTestId('room-working-members');
    await expect(strip.locator('.play-group-working__name')).toHaveText('Member 0');
    await expect(strip.locator('[data-face-mood]')).toHaveCount(1);
    await expect(panel.getByLabel('加入 Bot')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^把 .* 移出群聊$/ })).toHaveCount(0);
    await expect(panel.getByTestId('room-shared-context')).toHaveCount(0);
    active = [];
    await expect(strip).toHaveCount(0);
    active = ['member1'];
    await expect(strip.locator('.play-group-working__name')).toHaveText('Member 1');
    await panel.getByRole('button', { name: '群聊设置', exact: true }).click();
    const settings = panel.getByTestId('room-settings');
    await expect(settings.getByLabel('加入 Bot')).toBeVisible();
    await expect(settings.getByTestId('room-shared-context')).toBeVisible();
    if (size === 7) {
      const search = settings.getByTestId('play-group-member-search');
      await search.fill('Member 0');
      await expect(settings.getByRole('button', { name: '把 Member 0 移出群聊', exact: true })).toBeVisible();
      await expect(settings.getByRole('button', { name: '把 Member 1 移出群聊', exact: true })).toHaveCount(0);
      await search.fill('');
    }
    await settings.getByLabel('加入 Bot').selectOption('member7');
    await settings.getByRole('button', { name: '加入', exact: true }).click();
    await expect(settings.getByRole('button', { name: '把 Member 7 移出群聊', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: '把 Member 7 移出群聊', exact: true }).click();
    await expect(settings.getByRole('button', { name: '把 Member 7 移出群聊', exact: true })).toHaveCount(0);
    fail = true;
    await settings.getByLabel('加入 Bot').selectOption('member7');
    await settings.getByRole('button', { name: '加入', exact: true }).click();
    await expect(settings).toContainText('没能更新群成员');
    fail = false;
    if (size === 3) {
      await settings.getByRole('button', { name: '把 Member 2 移出群聊', exact: true }).click();
      await expect(settings.getByRole('button', { name: '把 Member 0 移出群聊', exact: true })).toBeDisabled();
    }
    await panel.getByRole('button', { name: '群聊设置', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(strip.locator('.play-group-working__name')).toHaveText('Member 1');
    await page.screenshot({ path: `test-results/group-active-header-${size}.png` });
  });
}

});
