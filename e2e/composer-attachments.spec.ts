import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

type Surface = 'chat' | 'bot' | 'group';

type Bot = { id: string; name: string; canonicalSessionId: string };

type Room = { id: string; title: string };

let alpha: Bot;
let beta: Bot;
let room: Room;

test.beforeAll(async ({ request }) => {
  alpha = await createBot(request, `附件甲 ${stamp()}`);
  beta = await createBot(request, `附件乙 ${stamp()}`);
  room = await createRoom(request, `附件群 ${stamp()}`, [alpha.id, beta.id], alpha.id);
});
test.afterAll(async ({ request }) => {
  if (room?.id) await request.delete(`/api/bot-rooms/${room.id}`);
  for (const bot of [alpha, beta]) if (bot?.id) await request.patch(`/api/bots/${bot.id}`, { data: { hidden: true } });
});

test('三处消息框忽略拖放并保留草稿和发送能力 [AC:composer-drop-retirement-soak-isolation#AC-1]', async ({ page }) => {
  for (const surface of ['chat', 'bot', 'group'] as const) {
    await openSurface(page, surface);
    const text = `保留草稿 ${surface} ${stamp()}`;
    await composerInput(page, surface).fill(text);
    for (const kind of ['file', 'folder', 'text', 'url']) {
      const cancelled = await composerInput(page, surface).evaluate((target, kind) => {
        const transfer = new DataTransfer();
        if (kind === 'text' || kind === 'url') transfer.setData(kind === 'url' ? 'text/uri-list' : 'text/plain', 'https://example.com');
        else transfer.items.add(new File(['context'], 'dropped.txt', { type: 'text/plain' }));
        if (kind === 'folder') Object.defineProperty(transfer.items[0], 'webkitGetAsEntry', { value: () => ({ isDirectory: true, name: 'folder', createReader: () => ({ readEntries: (done: (entries: unknown[]) => void) => done([]) }) }) });
        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        return !target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, kind);
      expect(cancelled).toBe(true);
      await expect(composerInput(page, surface)).toHaveValue(text);
      await expect(page.locator('.is-drop-over, [data-testid="composer-context-chip"]')).toHaveCount(0);
    }
    if (surface === 'group') await expect(page.getByTestId('play-group-chat').getByRole('button', { name: '附件', exact: true })).toHaveCount(0);
    await composerInput(page, surface).fill(text + ' 可发送');
    const response = page.waitForResponse(res => isSend(res.url(), res.request().method(), surface));
    await dropTarget(page, surface).locator(surface === 'group' ? '[data-testid="play-group-send"]' : '#btnSend').click();
    const result = await response;
    expect(result.ok()).toBe(true);
    expect(result.request().postDataJSON().contextSources ?? []).toEqual([]);
    await expect((surface === 'group' ? page.getByTestId('play-group-chat') : page.locator('#playMessages')).locator('.chat-turn--user').filter({ hasText: text })).toBeVisible();
  }
});

for (const surface of ['chat', 'bot'] as const) {
 test.describe(surface, () => {
  test('加号附件可添加移除并发送，失败不会误报成功 [AC:composer-drop-retirement-soak-isolation#AC-2]', async ({ page, request }) => {
    await openSurface(page, surface);
    await page.getByRole('button', { name: '附件', exact: true }).click();
    const ids: string[] = [];
    let sessionId = '';
    for (const name of ['keep.txt', 'remove.txt']) {
      const uploaded = page.waitForResponse(res => res.url().includes('/attachments/ingest-base64'), { timeout: 15_000 });
      await page.locator('#playImageFile').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('附件原句 ' + name) });
      const res = await uploaded;
      expect(res.ok()).toBe(true);
      sessionId = new URL(res.url()).pathname.split('/')[3];
      ids.push((await res.json()).attachment.id);
      await expect(page.locator('#pendingImages .pending-img-row')).toHaveCount(ids.length);
    }
    await page.locator('#pendingImages .pending-img-row').last().getByRole('button').click();
    await expect(page.locator('#pendingImages .pending-img-row')).toHaveCount(1);
    const uploadedImage = page.waitForResponse(res => res.url().includes('/attachments/ingest-base64'), { timeout: 15_000 });
    await page.locator('#playImageFile').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
    const imageResponse = await uploadedImage;
    expect(imageResponse.ok()).toBe(true);
    const imageBody = await imageResponse.json();
    const imageId = imageBody.attachment?.imageAssetId || imageBody.imageAsset?.id;
    expect(imageId).toBeTruthy();
    await expect(page.locator('#pendingImages .pending-img-row')).toHaveCount(3);
    const remoteAttachment = await request.post(`/api/sessions/${sessionId}/attachments/ingest-base64`, { data: { dataBase64: Buffer.from('URL attachment').toString('base64'), mimeType: 'text/plain', fileName: 'remote.txt' } });
    expect(remoteAttachment.ok()).toBe(true);
    const remoteBody = await remoteAttachment.json();
    // Keep the browser test independent of public network availability.
    await page.route('**/attachments/fetch-url', route => route.fulfill({ json: remoteBody }));
    await page.locator('#playImageUrl').fill('https://example.com/remote.txt');
    await page.locator('#composerAttachPanel button').last().click();
    await expect(page.locator('#pendingImages .pending-img-row')).toHaveCount(4);
    await page.unroute('**/attachments/fetch-url');
    await page.route('**/attachments/fetch-url', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '附件读取失败' }) }));
    await page.locator('#playImageUrl').fill('https://example.com/missing.txt');
    await page.locator('#composerAttachPanel button').last().click();
    await expect(page.locator('#playStatus')).toHaveClass(/err/);
    await expect(page.locator('#pendingImages .pending-img-row')).toHaveCount(4);
    await composerInput(page, surface).fill(`附件发送 ${stamp()}`);
    const sent = page.waitForResponse(res => isSend(res.url(), res.request().method(), surface));
    await page.locator('#btnSend').click();
    const res = await sent;
    expect(res.ok()).toBe(true);
    expect(res.request().postDataJSON().attachmentIds).toEqual([ids[0], imageBody.attachment.id, remoteBody.attachment.id]);
    expect(res.request().postDataJSON().imageAssetIds).toEqual([imageId]);
  });
 });
}

test('历史文件和文件夹上下文刷新后仍属于原 Bot [AC:composer-drop-retirement-soak-isolation#AC-3]', async ({ page, request }) => {
  const text = `历史上下文 ${stamp()}`;
  const contextSources = [{ kind: 'file', name: 'history.txt', text: 'old file' }, { kind: 'folder', name: 'history-folder', entries: [{ path: 'a.txt', text: 'old folder' }] }];
  const response = await request.post(`/api/sessions/${alpha.canonicalSessionId}/messages`, { data: { message: text, contextSources } });
  expect(response.ok()).toBe(true);
  await openSurface(page, 'bot');
  for (let attempt = 0; attempt < 2; attempt++) {
    const turn = page.locator('#playMessages .chat-turn--user').filter({ hasText: text });
    await expect(turn.getByTestId('composer-message-context')).toHaveCount(2);
    await expect(turn).toContainText('history.txt');
    await expect(turn).toContainText('history-folder');
    if (attempt === 0) { await page.reload(); await openSurface(page, 'bot'); }
  }
  const other = await request.get(`/api/sessions/${beta.canonicalSessionId}`);
  expect(JSON.stringify((await other.json()).messages)).not.toContain(text);
});

function stamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createBot(request: APIRequestContext, name: string): Promise<Bot> {
  const res = await request.post('/api/bots', { data: { name } });
  const raw = await res.text();
  expect(res.status(), raw).toBe(201);
  return (JSON.parse(raw) as { bot: Bot }).bot;
}

async function createRoom(
  request: APIRequestContext,
  title: string,
  botIds: string[],
  hostBotId: string
): Promise<Room> {
  const res = await request.post('/api/bot-rooms', { data: { title, botIds, hostBotId } });
  const raw = await res.text();
  expect(res.status(), raw).toBe(201);
  return (JSON.parse(raw) as { room: Room }).room;
}

async function openChat(page: Page): Promise<void> {
  await page.goto('/#/chat');
  await expect(dropTarget(page, 'chat')).toBeVisible();
}

async function openBot(page: Page, name: string): Promise<void> {
  await page.goto('/#/bot');
  const row = page.locator('#sessionListMini .list-item--bot-chat').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.locator('#playTitle')).toContainText(name);
  await expect(dropTarget(page, 'bot')).toBeVisible();
  await expect(page.getByTestId('play-group-chat')).toHaveCount(0);
}

async function openGroup(page: Page): Promise<void> {
  await page.goto('/#/bot');
  await page.getByRole('button', { name: `打开群聊 ${room.title}`, exact: true }).click();
  await expect(page.getByTestId('play-group-chat')).toBeVisible();
  await expect(dropTarget(page, 'group').locator('textarea')).toBeEnabled();
}

async function openSurface(page: Page, surface: Surface): Promise<void> {
  if (surface === 'chat') {
    await openChat(page);
    return;
  }
  if (surface === 'bot') {
    await openBot(page, alpha.name);
    return;
  }
  await openGroup(page);
}

function dropTarget(page: Page, surface: Surface): Locator {
  return page.locator(`[data-testid="composer-drop-target"][data-surface="${surface}"]`);
}

function composerInput(page: Page, surface: Surface): Locator {
  return dropTarget(page, surface).locator('textarea');
}

function isSend(url: string, method: string, surface: Surface): boolean {
  if (method !== 'POST') return false;
  if (surface === 'group') return url.includes(`/api/bot-rooms/${room.id}/messages`);
  return (
    /\/api\/chat\/stream(?:\?|$)/.test(url) ||
    /\/api\/chat(?:\?|$)/.test(url) ||
    /\/api\/sessions\/[^/]+\/stream(?:\?|$)/.test(url) ||
    /\/api\/sessions\/[^/]+\/messages(?:\?|$)/.test(url)
  );
}

