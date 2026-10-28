import { test, expect } from '@playwright/test';

test.describe('Chat basics', () => {
  test('the sent message shows at once with a waiting placeholder, before the reply arrives [AC:chat-basics#AC-1]', async ({
    page
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/chat/stream', async (route) => {
      await held;
      await route.continue();
    });

    await page.goto('/#/chat');
    const content = `e2e optimistic ${Date.now()}`;
    await page.getByLabel('消息内容').fill(content);
    await page.getByRole('button', { name: '发送' }).click();

    const box = page.locator('#playMessages');
    await expect(box.locator('.chat-turn--user .chat-bubble__body').last()).toContainText(content);
    await expect(page.locator('#playInput')).toHaveValue('');
    await expect(box.locator('.chat-turn--streaming .chat-stream-placeholder')).toHaveText('…');

    release();
    await expect(box.locator('.chat-turn--streaming')).toHaveCount(0, { timeout: 60_000 });
  });

  test('the reply comes back over the event stream and stays in the conversation once done [AC:chat-basics#AC-2]', async ({ page }) => {
    await page.goto('/#/chat');
    const content = `e2e stream ${Date.now()}`;
    const streamed = page.waitForResponse((res) => res.url().includes('/api/chat/stream'));
    await page.getByLabel('消息内容').fill(content);
    await page.getByRole('button', { name: '发送' }).click();

    const res = await streamed;
    expect(res.headers()['content-type']).toContain('text/event-stream');
    expect(await res.text()).toContain('event: result');

    const box = page.locator('#playMessages');
    await expect(box.locator('.chat-turn--streaming')).toHaveCount(0, { timeout: 60_000 });
    await expect(box.locator('.chat-turn--user .chat-bubble__body').last()).toContainText(content);
    await expect(box.locator('.chat-turn--assistant .chat-bubble__body').last()).not.toBeEmpty();
  });

  test('a new conversation shows up in the session list and its history survives a reload [AC:chat-basics#AC-3] [AC:chat-basics#AC-4]', async ({
    page
  }) => {
    await page.goto('/#/chat');
    const content = `e2e history ${Date.now()}`;
    await page.getByLabel('消息内容').fill(content);
    await page.getByRole('button', { name: '发送' }).click();

    const box = page.locator('#playMessages');
    await expect(box.locator('.chat-turn--streaming')).toHaveCount(0, { timeout: 60_000 });
    const item = page.locator('#sessionListMini .list-item--session', { hasText: content });
    await expect(item).toBeVisible();

    await page.reload();
    await page.locator('#sessionListMini .list-item--session', { hasText: content }).click();
    await expect(box.locator('.chat-turn--user .chat-bubble__body').first()).toContainText(content);
    await expect(box.locator('.chat-turn--assistant .chat-bubble__body').last()).not.toBeEmpty();
  });
});
