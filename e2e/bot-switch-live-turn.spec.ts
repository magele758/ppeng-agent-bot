import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

type Bot = { id: string; name: string; canonicalSessionId: string };
async function bot(request: APIRequestContext, name: string): Promise<Bot> {
  const response = await request.post('/api/bots', { data: { name } });
  expect(response.status()).toBe(201);
  return (await response.json()).bot;
}
let pair: [Bot, Bot];
test.beforeAll(async ({ request }) => {
  pair = [await bot(request, 'Switch fixture A ' + Date.now()), await bot(request, 'Switch fixture B ' + Date.now())];
});
test.beforeEach(async ({ request }) => {
  for (const selected of pair) await request.patch(`/api/bots/${selected.id}`, { data: { hidden: false } });
});
async function select(page: Page, selected: Bot) {
  await page.getByTestId('functional-group-ungrouped').locator(`[data-bot-id="${selected.id}"]`).getByRole('button').first().click();
  await expect(page.locator('#playTitle')).toContainText(selected.name);
}

test('switching Bot hides the old pending turn and ignores its late stream result [AC:bot-switch-live-turn#AC-1] [AC:bot-switch-live-turn#AC-2] [AC:bot-switch-live-turn#AC-3]', async ({ page, request }) => {
  const stamp = Date.now();
  const [a, b] = pair;
  const history = `B history ${stamp}`;
  await request.post(`/api/sessions/${b.canonicalSessionId}/messages`, { data: { message: history, autoRun: false } });
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/api/sessions/${a.canonicalSessionId}/stream`, async route => {
    arrived();
    await held;
    await route.fulfill({ contentType: 'text/event-stream', body:
      `event: model\ndata: ${JSON.stringify({type: 'text_delta', delta: 'OLD STREAM ANSWER'})}\n\n` +
      `event: result\ndata: ${JSON.stringify({session: {id: a.canonicalSessionId}})}\n\n` });
  });
  try {
    await page.goto('/#/bot');
    await expect(page.getByTestId('functional-group-ungrouped')).toBeVisible();
    await select(page, a);
    const message = `A pending ${stamp}`;
    await page.locator('.play-main').getByLabel('消息内容').fill(message);
    await page.locator('.play-main').getByRole('button', {name: '发送', exact: true}).click();
    await started;
    await expect(page.locator('#playMessages')).toContainText(message);
    await select(page, b);
    await expect(page.locator('#playMessages')).toContainText(history);
    await expect(page.locator('#playMessages')).not.toContainText(message);
    const response = page.waitForResponse(`**/api/sessions/${a.canonicalSessionId}/stream`);
    release();
    await response;
    await expect(page.locator('#playTitle')).toContainText(b.name);
    await expect(page.locator('#playMessages')).toContainText(history);
    await expect(page.locator('#playMessages')).not.toContainText('OLD STREAM ANSWER');
    // A subsequent user action must still target B after the old response completes.
    const next = page.waitForRequest(`**/api/sessions/${b.canonicalSessionId}/stream`);
    await page.locator('.play-main').getByLabel('消息内容').fill(`B next ${stamp}`);
    await page.locator('.play-main').getByRole('button', {name: '发送', exact: true}).click();
    await next;
  } finally {
    release();
    await request.patch(`/api/bots/${a.id}`, {data: {hidden: true}});
    await request.patch(`/api/bots/${b.id}`, {data: {hidden: true}});
  }
});

test('switching between two running Bots follows B after its transcript loads [AC:refresh-keeps-agent-run#AC-3] [AC:bot-switch-live-turn#AC-4]', async ({ page, request }) => {
  const stamp = Date.now();
  const [a, b] = pair;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const follows = new Set<string>();
  for (const selected of [a, b]) {
    await page.route(`**/api/sessions/${selected.canonicalSessionId}?*`, async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.session.status = 'running';
      await route.fulfill({ response, json: data });
    });
    await page.route(`**/api/sessions/${selected.canonicalSessionId}/stream`, async route => {
      follows.add(selected.id);
      await held;
      await route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    });
  }
  try {
    await page.goto('/#/bot');
    await select(page, a);
    await expect.poll(() => follows.has(a.id)).toBe(true);
    await select(page, b);
    await expect.poll(() => follows.has(b.id), { timeout: 3000 }).toBe(true);
  } finally {
    release();
    await request.patch(`/api/bots/${a.id}`, { data: { hidden: true } });
    await request.patch(`/api/bots/${b.id}`, { data: { hidden: true } });
  }
});

test('late failed A transcript cannot clear the selected B conversation [AC:bot-switch-live-turn#AC-4]', async ({ page, request }) => {
  const stamp = Date.now();
  const [a, b] = pair;
  const history = `Kept B history ${stamp}`;
  await request.post(`/api/sessions/${b.canonicalSessionId}/messages`, { data: { message: history, autoRun: false } });
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/api/sessions/${a.canonicalSessionId}?*`, async route => {
    arrived();
    await held;
    await route.fulfill({ status: 500, json: { error: 'delayed A load failure' } });
  });
  try {
    await page.goto('/#/bot');
    await page.getByTestId('functional-group-ungrouped').locator(`[data-bot-id="${a.id}"]`).getByRole('button').first().click();
    await started;
    await select(page, b);
    await expect(page.locator('#playMessages')).toContainText(history);
    const failed = page.waitForResponse(response => response.url().includes(`/api/sessions/${a.canonicalSessionId}?`) && response.status() === 500);
    release();
    await failed;
    await expect(page.locator('#playTitle')).toContainText(b.name);
    await expect(page.locator('#playMessages')).toContainText(history);
  } finally {
    release();
    await request.patch(`/api/bots/${a.id}`, { data: { hidden: true } });
    await request.patch(`/api/bots/${b.id}`, { data: { hidden: true } });
  }
});
