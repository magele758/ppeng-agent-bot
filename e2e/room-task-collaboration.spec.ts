import { test, expect } from './helpers/bot-pair';

test('task collaboration setting persists after reload and leaves old modes selectable [AC:room-task-collaboration#AC-1]', async ({ page, request, botPair }) => {
  const response = await request.post('/api/bot-rooms', { data: { title: `Collaboration-${crypto.randomUUID()}`, botIds: botPair.slice(0, 2).map(bot => bot.id) } });
  expect(response.ok()).toBeTruthy();
  const { room } = await response.json();
  try {
    await page.goto('/#/bot');
    await page.getByRole('button', { name: `打开群聊 ${room.title}`, exact: true }).click();
    await page.getByTestId('play-group-chat').getByRole('button', { name: '群聊设置', exact: true }).click();
    await page.getByTestId('group-reply-mode-task-collaboration').check();
    await expect.poll(async () => (await (await request.get(`/api/bot-rooms/${room.id}`)).json()).room.replyMode).toBe('task-collaboration');
    await page.reload();
    await page.getByRole('button', { name: `打开群聊 ${room.title}`, exact: true }).click();
    await page.getByTestId('play-group-chat').getByRole('button', { name: '群聊设置', exact: true }).click();
    await expect(page.getByTestId('group-reply-mode-task-collaboration')).toBeChecked();
    await expect(page.getByTestId('group-reply-mode-coordinator')).toBeEnabled();
    await expect(page.getByTestId('group-reply-mode-all-members')).toBeEnabled();
  } finally {
    await request.delete(`/api/bot-rooms/${room.id}`);
  }
});
