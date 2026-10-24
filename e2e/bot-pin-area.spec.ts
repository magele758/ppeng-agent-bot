import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

type Bot = { id: string; name: string; canonicalSessionId: string };
type PinState = { customized: boolean; ids: string[] };
type Part = { type?: string; text?: string };
type StoredMessage = { role?: string; parts?: Part[] };

const PIN_KEY = 'lab.botPins';

function sidebar(page: Page): Locator {
  return page.locator('#panel-play.active .play-sidebar');
}

function pinArea(page: Page): Locator {
  return sidebar(page).getByTestId('bot-pin-area');
}

function pinByName(page: Page, name: string): Locator {
  return pinArea(page).locator(`[data-testid="bot-pin-item"][data-bot-name="${name}"]`);
}

function groupSection(page: Page, id: string): Locator {
  return page.getByTestId(`functional-group-${id}`);
}

function draggableBot(page: Page, groupId: string, name: string): Locator {
  return groupSection(page, groupId).locator('[draggable="true"]').filter({ hasText: name });
}

test('置顶区在左侧功能分组和未分组上方，群聊不在其中 [AC:bot-pin-area#AC-1]', async ({ page, request }) => {
  const boss = await superBot(request);
  const member = await createBot(request, `Pin member ${stamp()}`);
  const group = await createGroup(request, `Pin group ${stamp()}`);
  const room = await createRoom(request, `Pin room ${stamp()}`, [boss.id, member.id]);
  try {
    await openBotPage(page);
    const area = pinArea(page);
    await expect(area).toHaveCount(1);
    await expect(area).toBeVisible();

    const sideBox = await boxOf(sidebar(page));
    const pinBox = await boxOf(area);
    expect(pinBox.x).toBeGreaterThanOrEqual(sideBox.x - 1);
    expect(pinBox.x + pinBox.width).toBeLessThanOrEqual(sideBox.x + sideBox.width + 1);

    for (const id of [group.id, 'ungrouped']) {
      const section = groupSection(page, id);
      await expect(section).toBeVisible();
      const sectionBox = await boxOf(section);
      expect(pinBox.y + pinBox.height).toBeLessThanOrEqual(sectionBox.y + 2);
    }
    const roomRow = page.getByTestId('play-group-row').filter({ hasText: room.title });
    await expect(roomRow).toBeVisible();
    await expect(area.getByTestId('play-group-row')).toHaveCount(0);
    await expect(area).not.toContainText(room.title);
    const names = await pinNames(page);
    expect(names).not.toContain(room.title);
    expect(names.every((name) => name !== room.title)).toBe(true);
    expect(boss.name).toBe('Super Bot');
  } finally {
    await request.delete(`/api/bot-rooms/${room.id}`);
    await request.delete(`/api/bot-functional-groups/${group.id}`);
    await hideBot(request, member);
  }
});

test('普通 Bot 拖进置顶区后可见、不重复、刷新仍在且原分组不变 [AC:bot-pin-area#AC-2]', async ({ page, request }) => {
  const boss = await superBot(request);
  const bot = await createBot(request, `Pin guest ${stamp()}`);
  const group = await createGroup(request, `Pin home ${stamp()}`);
  await moveToGroup(request, bot.id, group.id);
  try {
    await openBotPage(page, { fresh: true });
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await expect(draggableBot(page, group.id, bot.name)).toHaveCount(1);
    await expect(groupSection(page, 'ungrouped')).not.toContainText(bot.name);

    await draggableBot(page, group.id, bot.name).dragTo(pinArea(page));
    await expect(pinByName(page, bot.name)).toHaveCount(1);
    await expect(pinByName(page, bot.name)).toContainText(bot.name);
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await expect(groupSection(page, group.id).locator(`[data-bot-name="${bot.name}"]`)).toHaveCount(0);
    await expect(groupSection(page, 'ungrouped')).not.toContainText(bot.name);
    expect(await memberIds(request, group.id)).toContain(bot.id);

    await pinByName(page, bot.name).dragTo(pinArea(page));
    await expect(pinByName(page, bot.name)).toHaveCount(1);
    await expect(pinByName(page, boss.name)).toHaveCount(1);

    const pinned = await readPins(page);
    expect(pinned?.customized).toBe(true);
    expect(pinned?.ids.filter((id) => id === bot.id)).toEqual([bot.id]);
    expect(pinned?.ids).toContain(boss.id);

    await page.reload();
    await expect(page.getByTestId('functional-group-ungrouped')).toBeVisible();
    await expect(pinByName(page, bot.name)).toHaveCount(1);
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await expect(groupSection(page, group.id).locator(`[data-bot-name="${bot.name}"]`)).toHaveCount(0);
    await expect(groupSection(page, 'ungrouped')).not.toContainText(bot.name);
    expect(await memberIds(request, group.id)).toContain(bot.id);
    const reloaded = await readPins(page);
    expect(reloaded).toEqual(pinned);
  } finally {
    await request.delete(`/api/bot-functional-groups/${group.id}`);
    await hideBot(request, bot);
  }
});

test('未自定义时置顶区已有 Super Bot [AC:bot-pin-area#AC-3]', async ({ page, request }) => {
  const boss = await superBot(request);
  await openBotPage(page, { fresh: true });
  await expect(pinByName(page, 'Super Bot')).toHaveCount(1);
  await expect(pinByName(page, 'Super Bot')).toContainText('Super Bot');
  await expect(pinByName(page, 'Super Bot')).toHaveAttribute('data-bot-name', 'Super Bot');
  await expect(groupSection(page, 'ungrouped').locator('[data-bot-name="Super Bot"]')).toHaveCount(0);
  await expect(pinArea(page)).toHaveCount(1);
  const state = await readPins(page);
  if (state !== null) expect(state).toEqual({ customized: false, ids: [] });
  expect(boss.name).toBe('Super Bot');
  const names = await pinNames(page);
  expect(names).toEqual(['Super Bot']);
});

test('拖出置顶区后刷新不回来，原分组保留，Super Bot 也可以取消 [AC:bot-pin-area#AC-4]', async ({ page, request }) => {
  const boss = await superBot(request);
  const bot = await createBot(request, `Pin leave ${stamp()}`);
  const group = await createGroup(request, `Pin stay ${stamp()}`);
  await moveToGroup(request, bot.id, group.id);
  try {
    await openBotPage(page);
    await page.evaluate(({ key, ids }) => {
      localStorage.setItem(key, JSON.stringify({ customized: true, ids }));
    }, { key: PIN_KEY, ids: [boss.id, bot.id] });
    await page.reload();
    await expect(pinByName(page, bot.name)).toHaveCount(1);
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await expect(groupSection(page, group.id).locator(`[data-bot-name="${bot.name}"]`)).toHaveCount(0);
    await expect(groupSection(page, 'ungrouped').locator('[data-bot-name="Super Bot"]')).toHaveCount(0);
    expect(await memberIds(request, group.id)).toContain(bot.id);

    await pinByName(page, bot.name).dragTo(page.locator('.play-main-col'));
    await expect(pinByName(page, bot.name)).toHaveCount(0);
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await expect(groupSection(page, group.id)).toContainText(bot.name);
    await expect(groupSection(page, 'ungrouped')).not.toContainText(bot.name);
    await page.reload();
    await expect(pinByName(page, bot.name)).toHaveCount(0);
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await expect(groupSection(page, group.id)).toContainText(bot.name);
    let state = await readPins(page);
    expect(state?.customized).toBe(true);
    expect(state?.ids ?? []).not.toContain(bot.id);
    expect(state?.ids).toContain(boss.id);

    await pinByName(page, boss.name).dragTo(page.locator('.play-main-col'));
    await expect(pinByName(page, boss.name)).toHaveCount(0);
    await expect(groupSection(page, 'ungrouped')).toContainText(boss.name);
    await page.reload();
    await expect(pinByName(page, boss.name)).toHaveCount(0);
    await expect(pinByName(page, bot.name)).toHaveCount(0);
    await expect(groupSection(page, 'ungrouped')).toContainText(boss.name);
    await expect(groupSection(page, group.id)).toContainText(bot.name);
    state = await readPins(page);
    expect(state?.customized).toBe(true);
    expect(state?.ids ?? []).not.toContain(boss.id);
    expect(state?.ids ?? []).not.toContain(bot.id);
  } finally {
    await request.delete(`/api/bot-functional-groups/${group.id}`);
    await hideBot(request, bot);
  }
});

test('点击置顶项打开原来的对话且可以继续发消息 [AC:bot-pin-area#AC-5]', async ({ page, request }) => {
  test.setTimeout(180_000);
  const boss = await superBot(request);
  const peer = await createBot(request, `Pin peer ${stamp()}`);
  const room = await createRoom(request, `Pin chat ${stamp()}`, [boss.id, peer.id]);
  const first = `pin-origin-${stamp()}`;
  const second = `pin-follow-${stamp()}`;
  try {
    await openBotPage(page, { fresh: true });
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    await pinByName(page, boss.name).click();
    await expect(page.locator('#playTitle')).toContainText(boss.name);
    await expect(page.getByTestId('play-group-chat')).toHaveCount(0);
    await expect(page.locator('.play-main').getByLabel('消息内容')).toBeEnabled();

    await sendOnCanonical(page, request, boss, first);
    await page.getByRole('button', { name: `打开群聊 ${room.title}`, exact: true }).click();
    await expect(page.getByTestId('play-group-chat')).toBeVisible();

    await pinByName(page, boss.name).click();
    await expect(page.getByTestId('play-group-chat')).toHaveCount(0);
    await expect(page.locator('.play-main.chat-panel')).not.toHaveAttribute('hidden');
    await expect(page.locator('#playTitle')).toContainText(boss.name);
    await expect(page.locator('#playMessages')).toContainText(first);
    await expect(page.locator('.play-main').getByLabel('消息内容')).toBeEnabled();

    await sendOnCanonical(page, request, boss, second);
    const detail = await sessionDetail(request, boss.canonicalSessionId);
    const transcript = messageText(detail.messages);
    expect(transcript).toContain(first);
    expect(transcript).toContain(second);
    const again = await superBot(request);
    expect(again.canonicalSessionId).toBe(boss.canonicalSessionId);
    expect(again.id).toBe(boss.id);
  } finally {
    await request.delete(`/api/bot-rooms/${room.id}`);
    await hideBot(request, peer);
  }
});

test('拖入文字、文件或落到置顶区外空白不会产生无名字空项 [AC:bot-pin-area#AC-6]', async ({ page, request }) => {
  const boss = await superBot(request);
  const bot = await createBot(request, `Pin list ${stamp()}`);
  try {
    await openBotPage(page, { fresh: true });
    await expect(pinByName(page, boss.name)).toHaveCount(1);
    const before = await pinNames(page);
    expect(before.every((name) => name.trim().length > 0)).toBe(true);

    await dropOn(pinArea(page), { text: `loose text ${stamp()}` });
    await dropOn(pinArea(page), { fileName: `pin-drop-${stamp()}.txt` });
    await dropOn(page.locator('.play-main-col'), { text: `outside ${stamp()}` });
    await dropOn(page.locator('#playTitle'), { fileName: `outside-${stamp()}.txt` });
    await draggableBot(page, 'ungrouped', bot.name).dragTo(page.locator('.play-main-col'));

    const after = await pinNames(page);
    expect(after).toEqual(before);
    expect(after.every((name) => name.trim().length > 0)).toBe(true);
    await expect(page.locator('[data-testid="bot-pin-item"][data-bot-name=""]')).toHaveCount(0);
    await expect(page.locator('[data-testid="bot-pin-item"]:not([data-bot-name])')).toHaveCount(0);
    const roster = (await listBots(request)).map((item) => item.name);
    expect(after.every((name) => roster.includes(name))).toBe(true);

    await pinByName(page, boss.name).click();
    await expect(page.locator('#playTitle')).toContainText(boss.name);
    await draggableBot(page, 'ungrouped', bot.name).click();
    await expect(page.locator('#playTitle')).toContainText(bot.name);
    await expect(groupSection(page, 'ungrouped')).toContainText(bot.name);
    await expect(page.locator('.play-main').getByLabel('消息内容')).toBeEnabled();
  } finally {
    await hideBot(request, bot);
  }
});

test('中英文下置顶区标题、空状态和提示跟随界面语言 [AC:bot-pin-area#AC-7]', async ({ page, request }) => {
  await superBot(request);
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ customized: true, ids: [] }));
  }, PIN_KEY);
  await openBotPage(page);
  await expect(pinArea(page).getByTestId('bot-pin-item')).toHaveCount(0);

  const chinese = await pinChrome(page);
  expect(hasHan(chinese.heading)).toBe(true);
  expect(hasHan(chinese.rest)).toBe(true);

  await page.getByTestId('language-toggle').first().getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
  const english = await pinChrome(page);
  expect(hasHan(english.heading)).toBe(false);
  expect(hasHan(english.rest)).toBe(false);
  expect(english.heading).toMatch(/[A-Za-z]/);
  expect(english.rest).toMatch(/[A-Za-z]/);
  expect(english.heading).not.toBe(chinese.heading);
  expect(english.rest).not.toBe(chinese.rest);
  expect(chinese.heading).not.toContain(english.heading);
  expect(english.heading).not.toContain(chinese.heading);
  expect(chinese.rest).not.toContain(english.rest);
  expect(english.rest).not.toContain(chinese.rest);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
  await expect(pinArea(page).getByTestId('bot-pin-item')).toHaveCount(0);
  expect(await pinChrome(page)).toEqual(english);

  await page.getByTestId('language-toggle').first().getByRole('button', { name: '中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', /^zh/);
  expect(await pinChrome(page)).toEqual(chinese);
});

function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function superBot(request: APIRequestContext): Promise<Bot> {
  const res = await request.get('/api/bot-work/default');
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
  const { bot } = JSON.parse(raw) as { bot: Bot };
  expect(bot.name).toBe('Super Bot');
  return bot;
}

async function createBot(request: APIRequestContext, name: string): Promise<Bot> {
  const res = await request.post('/api/bots', { data: { name } });
  const raw = await res.text();
  expect(res.status(), raw).toBe(201);
  return (JSON.parse(raw) as { bot: Bot }).bot;
}

async function createGroup(request: APIRequestContext, name: string): Promise<{ id: string; name: string }> {
  const res = await request.post('/api/bot-functional-groups', { data: { name } });
  const raw = await res.text();
  expect(res.status(), raw).toBe(201);
  return (JSON.parse(raw) as { group: { id: string; name: string } }).group;
}

async function createRoom(request: APIRequestContext, title: string, botIds: string[]): Promise<{ id: string; title: string }> {
  const res = await request.post('/api/bot-rooms', { data: { title, botIds, hostBotId: botIds[0] } });
  const raw = await res.text();
  expect(res.status(), raw).toBe(201);
  return (JSON.parse(raw) as { room: { id: string; title: string } }).room;
}

async function memberIds(request: APIRequestContext, groupId: string): Promise<string[]> {
  const res = await request.get('/api/bot-functional-groups');
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
  const { groups } = JSON.parse(raw) as { groups: { id: string; botIds: string[] }[] };
  return groups.find((group) => group.id === groupId)?.botIds ?? [];
}

async function moveToGroup(request: APIRequestContext, botId: string, groupId: string): Promise<void> {
  const res = await request.put(`/api/bots/${botId}/functional-group`, { data: { groupId } });
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
}

async function hideBot(request: APIRequestContext, bot: Bot): Promise<void> {
  await request.patch(`/api/bots/${bot.id}`, { data: { hidden: true } });
  await request.delete(`/api/sessions/${bot.canonicalSessionId}`);
}

async function listBots(request: APIRequestContext): Promise<Bot[]> {
  const res = await request.get('/api/bots');
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
  return (JSON.parse(raw) as { bots: Bot[] }).bots;
}

async function openBotPage(page: Page, options?: { fresh?: boolean }): Promise<void> {
  await page.goto('/#/bot');
  if (options?.fresh) {
    await page.evaluate((key) => localStorage.removeItem(key), PIN_KEY);
    await page.reload();
  }
  await expect(page.locator('#nav-bot')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('functional-group-ungrouped')).toBeVisible();
}

async function readPins(page: Page): Promise<PinState | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as PinState;
  }, PIN_KEY);
}

async function pinNames(page: Page): Promise<string[]> {
  return pinArea(page).getByTestId('bot-pin-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-bot-name') ?? ''));
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  return box!;
}

async function dropOn(target: Locator, payload: { text?: string; fileName?: string }): Promise<void> {
  await target.evaluate((el, spec) => {
    const transfer = new DataTransfer();
    if (spec.text != null) transfer.setData('text/plain', spec.text);
    if (spec.fileName) transfer.items.add(new File(['pin-drop'], spec.fileName, { type: 'text/plain' }));
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, payload);
}

async function pinChrome(page: Page): Promise<{ heading: string; rest: string }> {
  const area = pinArea(page);
  await expect(area.getByTestId('bot-pin-item')).toHaveCount(0);
  const headingNode = area.getByRole('heading').first();
  await expect(headingNode).toBeVisible();
  const heading = norm(await headingNode.innerText());
  const rest = norm((await area.innerText()).replace(heading, ''));
  expect(heading.length).toBeGreaterThan(0);
  expect(rest.length).toBeGreaterThan(0);
  return { heading, rest };
}

function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

async function sessionDetail(request: APIRequestContext, sessionId: string): Promise<{ messages?: StoredMessage[] }> {
  const res = await request.get(`/api/sessions/${sessionId}`);
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
  return JSON.parse(raw) as { messages?: StoredMessage[] };
}

function messageText(messages: StoredMessage[] | undefined): string {
  return (messages ?? [])
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

async function sendOnCanonical(page: Page, request: APIRequestContext, bot: Bot, text: string): Promise<void> {
  const pending = page.waitForRequest((req) => req.method() === 'POST' && /\/stream$/.test(new URL(req.url()).pathname));
  await page.locator('.play-main').getByLabel('消息内容').fill(text);
  await page.locator('.play-main').getByRole('button', { name: '发送', exact: true }).click();
  const req = await pending;
  expect(new URL(req.url()).pathname).toBe(`/api/sessions/${bot.canonicalSessionId}/stream`);
  await expect(page.locator('#playMessages .chat-turn--user .chat-bubble__body').filter({ hasText: text })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => messageText((await sessionDetail(request, bot.canonicalSessionId)).messages), { timeout: 60_000 }).toContain(text);
}
