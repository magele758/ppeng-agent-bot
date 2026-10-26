import { test, expect } from '@playwright/test';

test('member mentions omit sidebar groups [AC:group-settings-clarity#AC-1]', async ({ page }) => {
  await setup(page);
  const composer = page.getByTestId('play-group-chat').locator('textarea').last();
  await composer.fill('@');
  const choices = page.getByRole('listbox', { name: '选择要 @ 的成员' });
  await expect(choices.getByRole('option')).toHaveCount(2);
  await expect(choices).not.toContainText('开发');
  await choices.getByRole('button', { name: /Alpha/ }).click();
  await expect(composer).toHaveValue('@Alpha ');
});

test('settings are divided and still save [AC:group-settings-clarity#AC-2] [AC:group-settings-clarity#AC-3]', async ({ page }) => {
  await page.setViewportSize({ width: 857, height: 804 });
  const state = await setup(page);
  await page.getByTestId('play-group-chat').getByRole('button', { name: '群聊设置', exact: true }).click();
  const settings = page.getByTestId('room-settings');
  await expect(settings.getByRole('group', { name: '基本信息' })).toBeVisible();
  await expect(settings.locator('textarea')).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /^把 .* 移出群聊$/ })).toHaveCount(2);
  const limits = settings.locator('details').filter({ hasText: '运行限制' });
  await expect(limits).not.toHaveAttribute('open', '');
  await limits.locator('summary').click();
  await limits.getByLabel('最多 Bot 发言次数').fill('9');
  await settings.getByTestId('room-settings-title').fill('Renamed');
  await settings.getByTestId('room-save').click();
  await expect(settings.getByRole('status')).toHaveText('已保存');
  expect(state.room.title).toBe('Renamed');
  expect(state.room.maxBotTurns).toBe(9);
  await expect(settings).toContainText('选择后立即生效');
  const all = settings.getByTestId('group-reply-mode-all-members');
  await all.check();
  await expect(all).toBeChecked();
  await expect(all.locator('..')).toHaveClass(/is-selected/);
  await expect(all).toBeEnabled();
  state.fail = true;
  await settings.getByTestId('group-reply-mode-coordinator').click();
  await expect(all).toBeChecked();
  await expect(settings.getByTestId('group-reply-mode-error')).toBeVisible();
  await page.screenshot({ path: 'test-results/group-settings-clarity-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settings.getByTestId('room-save')).toBeVisible();
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/group-settings-clarity-mobile.png' });
});

async function setup(page: import('@playwright/test').Page) {
  const bots = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
  const state = { room: { id: 'clarity', title: 'Clarity', botIds: ['alpha', 'beta'], hostBotId: 'alpha', status: 'active', maxBotTurns: 6, maxToolCalls: 100, maxCostUsd: 1, replyMode: 'coordinator' }, fail: false };
  await page.route('**/api/bots', r => r.fulfill({ json: { bots } }));
  await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [{ id: 'dev', name: '开发', botIds: ['alpha'] }, { id: 'daily', name: '日常', botIds: [] }] } }));
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [state.room] } }));
  await page.route('**/api/bot-rooms/clarity', r => {
    if (r.request().method() === 'PATCH') {
      if (state.fail) return r.fulfill({ status: 500, json: { error: 'Save failed' } });
      Object.assign(state.room, r.request().postDataJSON());
    }
    return r.fulfill({ json: { room: state.room } });
  });
  await page.route('**/api/bot-rooms/clarity/messages*', r => r.fulfill({ json: { messages: [], hasMore: false, nextCursor: null } }));
  await page.route('**/api/bot-rooms/clarity/turns', r => r.fulfill({ json: { turns: [] } }));
  await page.goto('/#/bot');
  await page.getByRole('button', { name: '打开群聊 Clarity', exact: true }).click();
  return state;
}
