import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const createdBotIds: string[] = [];
async function createBot(request: APIRequestContext) {
  const response = await request.post('/api/bots', { data: { name: `First guide ${crypto.randomUUID()}` } });
  expect(response.status()).toBe(201);
  const bot = (await response.json()).bot;
  createdBotIds.push(bot.id);
  return bot;
}
test.afterEach(async ({ request }) => {
  for (const id of createdBotIds.splice(0)) {
    await request.patch(`/api/bots/${id}`, { data: { hidden: true } });
  }
});
async function selectBot(page: Page, id: string) {
  await page.locator(`#sessionListMini [data-bot-id="${id}"] .list-item--session`).click();
}

test('existing conversation never shows first-task guide with assistant-only history pages [AC:bot-first-task-dismissal#AC-1]', async ({ page, request }) => {
  const bot = await createBot(request);
  await page.route(new RegExp(`/api/sessions/${bot.canonicalSessionId}(?:\\?|$)`), route => route.fulfill({ json: {
    session: { id: bot.canonicalSessionId, agentId: bot.agentId, status: 'idle', metadata: {} },
    messages: Array.from({ length: 40 }, (_, i) => ({ id: `assistant-${i}`, seq: 100 + i, role: 'assistant', parts: [{ type: 'text', text: `既有对话 ${i}` }] })),
    hasMore: true, nextCursor: 100,
  } }));
  await page.goto('/#/bot');
  await selectBot(page, bot.id);
  await expect(page.locator('#playMessages')).toContainText('既有对话');
  await expect(page.getByTestId('bot-first-task')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#playMessages')).toContainText('既有对话');
  await expect(page.getByTestId('bot-first-task')).toHaveCount(0);
});

for (const width of [1280, 820]) {
  test(`guide dismisses with keyboard and stays dismissed per Bot at ${width}px [AC:bot-first-task-dismissal#AC-2] [AC:bot-first-task-dismissal#AC-3] [AC:bot-first-task-dismissal#AC-5]`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 804 });
    const bot = await createBot(request), other = await createBot(request);
    await page.goto('/#/bot');
    await selectBot(page, bot.id);
    const guide = page.getByTestId('bot-first-task');
    await expect(guide).toBeVisible();
    const input = page.locator('#playInput');
    await input.fill('保留这份未发送的草稿');
    const writes: string[] = [];
    page.on('request', req => { if (req.method() === 'POST' && /\/messages/.test(req.url())) writes.push(req.url()); });
    await guide.getByRole('button', { name: '关闭首次任务引导', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(guide).toHaveCount(0);
    await expect(input).toHaveValue('保留这份未发送的草稿');
    await expect(input).toBeInViewport();
    expect(writes).toEqual([]);
    await page.reload();
    await expect(page.locator('#playTitle')).toHaveText(bot.name);
    await expect(guide).toHaveCount(0);
    await selectBot(page, other.id);
    await expect(guide).toBeVisible();
    await selectBot(page, bot.id);
    await expect(page.locator('#playTitle')).toHaveText(bot.name);
    await expect(guide).toHaveCount(0);
    await expect(input).toBeInViewport();
  });
}

test('examples only fill the composer and sending the first message retires the guide [AC:bot-first-task-dismissal#AC-4]', async ({ page, request }) => {
  const bot = await createBot(request);
  await page.goto('/#/bot'); await selectBot(page, bot.id);
  const guide = page.getByTestId('bot-first-task');
  let sends = 0;
  page.on('request', req => { if (req.method() === 'POST' && /\/messages/.test(req.url())) sends++; });
  await guide.getByRole('button', { name: '整理我提供的材料', exact: true }).click();
  await expect(page.locator('#playInput')).toHaveValue(/材料/);
  expect(sends).toBe(0);
  await expect(guide.getByRole('link', { name: '检查软件连接' })).toHaveAttribute('href', /focus=connections/);
  await page.locator('#playInput').fill('First guide test message');
  await page.locator('#btnSend').click();
  await expect(guide).toHaveCount(0);
  await expect(page.locator('#playMessages')).toContainText('First guide test message');
  await page.reload();
  await expect(page.locator('#playMessages')).toContainText('First guide test message');
  await expect(guide).toHaveCount(0);
});
