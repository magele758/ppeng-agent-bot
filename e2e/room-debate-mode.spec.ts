import { test, expect } from '@playwright/test';

test('debate can be chosen and its rounds, order, stances and judge are saved [AC:room-debate-mode#AC-13] [AC:room-debate-mode#AC-1]', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  const state = await setup(page);
  await page.getByTestId('play-group-chat').getByRole('button', { name: '更多', exact: true }).click();
  await page.getByTestId('play-group-chat').getByRole('button', { name: '群聊设置', exact: true }).click();
  const settings = page.getByTestId('room-settings');
  await expect(settings.getByTestId('group-debate-settings')).toHaveCount(0);
  await settings.getByTestId('group-reply-mode-debate').check();
  await expect.poll(() => state.room.replyMode).toBe('debate');

  // Defaults: three rounds, the host judges, the other two take sides in member order.
  const debate = settings.getByTestId('group-debate-settings');
  await expect(debate).toBeVisible();
  await expect(debate.getByTestId('group-debate-rounds')).toHaveValue('3');
  await expect(debate.getByTestId('group-debate-judge')).toHaveValue('default');
  await expect(debate.getByTestId('group-debate-row-alpha').getByRole('checkbox')).not.toBeChecked();
  await expect(debate.getByTestId('group-debate-row-beta').getByRole('checkbox')).toBeChecked();
  await expect(debate.getByTestId('group-debate-summary')).toHaveText('一场辩论共 7 条发言，其中最后一条是 Alpha 的裁决。');
  await expect(debate.getByLabel('Beta 的立场')).toHaveAttribute('placeholder', '正方');
  await expect(debate.getByLabel('Gamma 的立场')).toHaveAttribute('placeholder', '反方');

  await debate.getByTestId('group-debate-rounds').fill('2');
  await debate.getByRole('button', { name: '把 Gamma 上移', exact: true }).click();
  await debate.getByLabel('Gamma 的立场').fill('猫更好');
  await debate.getByLabel('Beta 的立场').fill('狗更好');
  await expect(debate.getByTestId('group-debate-summary')).toHaveText('一场辩论共 5 条发言，其中最后一条是 Alpha 的裁决。');
  await page.screenshot({ path: 'test-results/room-debate-settings.png', fullPage: true });
  await debate.getByTestId('group-debate-save').click();
  await expect(debate.getByTestId('group-debate-save-state')).toHaveText('已保存');
  expect(state.room.debate).toEqual({ rounds: 2, participants: [{ botId: 'gamma', stance: '猫更好' }, { botId: 'beta', stance: '狗更好' }] });

  // Fewer than two debaters cannot be saved, and the reason is shown.
  await debate.getByTestId('group-debate-row-beta').getByRole('checkbox').uncheck();
  await expect(debate.getByTestId('group-debate-issue')).toHaveText('至少需要两名参与者。');
  await expect(debate.getByTestId('group-debate-save')).toBeDisabled();
  expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('a running debate shows the round and who is speaking [AC:room-debate-mode#AC-13] [AC:room-debate-mode#AC-3]', async ({ page }) => {
  const state = await setup(page);
  state.messages = [
    { id: 'm1', roomId: 'debate', seq: 1, sender: { type: 'user', id: 'u', name: 'u' }, text: '猫好还是狗好', attachmentIds: [], createdAt: new Date().toISOString(), turnId: 't1' },
    { id: 'm2', roomId: 'debate', seq: 2, sender: { type: 'bot', id: 'beta', name: 'Beta' }, text: '猫更独立。', attachmentIds: [], createdAt: new Date().toISOString(), turnId: 't1' }
  ];
  state.turns = [{ id: 't1', status: 'running', botIds: ['beta', 'gamma', 'alpha'], cursor: 0, replyMode: 'debate', debate: { rounds: 3, participants: [{ botId: 'beta', stance: '正方' }, { botId: 'gamma', stance: '反方' }], judgeBotId: 'alpha', speeches: 6, step: 3 } }];
  await page.reload();
  await page.getByRole('button', { name: '打开群聊 Debate', exact: true }).click();
  const chat = page.getByTestId('play-group-chat');
  await expect(chat.getByTestId('play-group-debate-progress')).toHaveText('辩论进行中：第 2 / 3 轮');
  await expect(chat.getByTestId('play-group-speaking')).toContainText('Gamma');
  await page.screenshot({ path: 'test-results/room-debate-running.png' });
});

async function setup(page: import('@playwright/test').Page) {
  const bots = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }, { id: 'gamma', name: 'Gamma' }];
  const state: { room: Record<string, unknown>; messages: unknown[]; turns: unknown[] } = {
    room: { id: 'debate', title: 'Debate', botIds: ['alpha', 'beta', 'gamma'], hostBotId: 'alpha', status: 'active', maxBotTurns: 0, maxToolCalls: 100, maxCostUsd: 1, replyMode: 'coordinator' },
    messages: [],
    turns: []
  };
  await page.route('**/api/bots', r => r.fulfill({ json: { bots } }));
  await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [] } }));
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [state.room] } }));
  await page.route('**/api/bot-rooms/debate', r => {
    if (r.request().method() === 'PATCH') Object.assign(state.room, r.request().postDataJSON());
    return r.fulfill({ json: { room: state.room } });
  });
  await page.route('**/api/bot-rooms/debate/messages*', r => r.fulfill({ json: { messages: state.messages, hasMore: false, nextCursor: null } }));
  await page.route('**/api/bot-rooms/debate/turns', r => r.fulfill({ json: { turns: state.turns } }));
  await page.goto('/#/bot');
  await page.getByRole('button', { name: '打开群聊 Debate', exact: true }).click();
  return state;
}
