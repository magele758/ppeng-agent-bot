import { test, expect } from './helpers/bot-pair';

test('群聊设置改名称后能保存，不必等历史，保存就在名称旁边 [AC:group-chat-settings-save#AC-1] [AC:group-chat-settings-save#AC-2] [AC:group-chat-settings-save#AC-3]', async ({ page, request, botPair }) => {
  const title = `Settings save ${crypto.randomUUID()}`;
  const renamed = `${title} 已改`;
  const response = await request.post('/api/bot-rooms', {
    data: { title, botIds: botPair.slice(0, 2).map((bot) => bot.id) }
  });
  expect(response.ok()).toBeTruthy();
  const { room } = await response.json();
  try {
    await page.goto('/#/bot');
    await page.getByRole('button', { name: `打开群聊 ${title}`, exact: true }).click();
    await page.getByTestId('play-group-chat').getByRole('button', { name: '群聊设置', exact: true }).click();
    const settings = page.getByTestId('room-settings');
    await expect(settings.getByTestId('room-save')).toBeVisible();
    await expect(settings.getByTestId('room-save')).toBeEnabled({ timeout: 5000 });
    const saveBox = await settings.getByTestId('room-save').boundingBox();
    const titleBox = await settings.getByTestId('room-settings-title').boundingBox();
    const panelBox = await settings.boundingBox();
    expect(saveBox).toBeTruthy();
    expect(titleBox).toBeTruthy();
    expect(panelBox).toBeTruthy();
    expect(saveBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(titleBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 8);
    expect(titleBox!.y + titleBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 8);
    await settings.getByTestId('room-settings-title').fill(renamed);
    await settings.getByTestId('room-save').click();
    await expect(settings.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/bot-rooms/${room.id}`)).json()).room.title).toBe(renamed);
    await page.reload();
    await page.getByRole('button', { name: `打开群聊 ${renamed}`, exact: true }).click();
    await page.getByTestId('play-group-chat').getByRole('button', { name: '群聊设置', exact: true }).click();
    await expect(page.getByTestId('room-settings-title')).toHaveValue(renamed);
  } finally {
    await request.delete(`/api/bot-rooms/${room.id}`);
  }
});
