import { test, expect, type Locator } from '@playwright/test';

test('created Bot appearance and optional fields persist across reload, picker, chat and room [AC:bot-face-first-creation#AC-3]', async ({ page, request }) => {
  for (const custom of [true, false]) {
    const name = `Face persisted ${custom ? 'custom' : 'generated'} ${Date.now()}`;
    await page.goto('/#/agents/bots');
    await page.getByTestId('bot-create-open').click();
    const form = page.getByRole('form', { name: '新建 Bot', exact: true });
    await form.getByTestId('bot-create-name').fill(name);
    if (custom) {
      await form.getByTestId('bot-create-title').fill('Persistent face title');
      await form.getByTestId('bot-create-description').fill('Persistent face description');
      await form.getByRole('button', { name: '六边形', exact: true }).click();
      await form.getByRole('button', { name: '蓝', exact: true }).click();
    }
    const preview = form.getByTestId('bot-face-choice-preview');
    const shape = await preview.getAttribute('data-bot-shape');
    const color = await preview.getAttribute('data-bot-color');
    expect(shape).not.toBe('empty'); expect(color).not.toBe('empty');
    const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/bots');
    await form.getByTestId('bot-create-submit').click();
    const response = await createdResponse; expect(response.status()).toBe(201);
    const { bot } = await response.json();
    await expect(form).toHaveCount(0);
    await page.reload();
    const { bots } = await (await request.get('/api/bots')).json();
    const saved = bots.find((item: { id: string }) => item.id === bot.id);
    expect(saved.name).toBe(name);
    if (custom) {
      expect(saved.title).toBe('Persistent face title'); expect(saved.description).toBe('Persistent face description');
      expect(saved.faceShape).toBe(shape); expect(saved.faceColor).toBe(color);
    }
    expect(saved.avatar ?? null).toBeNull();
    const verify = async (face: Locator) => {
      await expect(face).toHaveAttribute('data-bot-shape', shape!);
      await expect(face).toHaveAttribute('data-bot-color', color!);
      await expect(face).toHaveAttribute('data-face-working', 'false');
    };
    await page.getByTestId(`bot-card-${bot.id}`).click();
    await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话', exact: true }).click();
    const row = page.locator('#sessionListMini .list-item--bot-chat').filter({ has: page.locator('.session-item__title').getByText(name, { exact: true }) });
    await verify(row.locator('[data-bot-shape]').first());
    await verify(page.locator('.chat-panel-header--bot [data-bot-shape]'));
    await verify(page.getByTestId('composer-bot-face'));
    const other = bots.find((item: { id: string; hidden?: boolean }) => item.id !== bot.id && !item.hidden);
    const roomResult = await request.post('/api/bot-rooms', { data: { title: `Face room ${bot.id}`, botIds: [bot.id, other.id], hostBotId: bot.id } });
    expect(roomResult.ok()).toBeTruthy();
    await page.reload();
    await page.getByRole('button', { name: `打开群聊 Face room ${bot.id}`, exact: true }).click();
    await verify(page.getByTestId(`room-member-face-${bot.id}`));
  }
});
