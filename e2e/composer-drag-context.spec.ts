import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

type Surface = 'chat' | 'bot' | 'group';

type Bot = { id: string; name: string; canonicalSessionId: string };

type Room = { id: string; title: string };

type FileWire = { kind: 'file'; name: string; text: string };

type FolderWire = { kind: 'folder'; name: string; entries: Array<{ path: string; text: string }> };

type Wire = FileWire | FolderWire;

type DropSpec = {
  files?: Array<{ name: string; text: string }>;
  folder?: { name: string; entries: Array<{ path: string; text: string }> };
  text?: string;
  uri?: string;
  empty?: boolean;
};

let alpha: Bot;
let beta: Bot;
let room: Room;

test.describe('消息框拖入文件和文件夹', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async ({ request }) => {
    alpha = await createBot(request, `拖放甲 ${stamp()}`);
    beta = await createBot(request, `拖放乙 ${stamp()}`);
    room = await createRoom(request, `拖放群 ${stamp()}`, [alpha.id, beta.id], alpha.id);
  });

  test.afterAll(async ({ request }) => {
    if (room?.id) await request.delete(`/api/bot-rooms/${room.id}`);
    for (const bot of [alpha, beta]) {
      if (bot?.id) await request.patch(`/api/bots/${bot.id}`, { data: { hidden: true } });
    }
  });

  test('同批完成的并发拖放在三处输入框均保留全部文件 [AC:composer-drag-context#AC-1]', async ({ page }) => {
    for (const surface of ['chat', 'bot', 'group'] as const) {
      await openSurface(page, surface);
      await composerInput(page, surface).fill(`parallel drops ${surface} ${stamp()}`);
      await dropTarget(page, surface).evaluate((target) => {
        const finish: Array<() => void> = [];
        for (const name of ['parallel-a.txt', 'parallel-b.txt']) {
          const entry = {
            name, isFile: true, isDirectory: false,
            file: (resolve: (file: unknown) => void) => finish.push(() => resolve({
              name, size: 6,
              slice: () => ({ arrayBuffer: async () => new TextEncoder().encode('phrase').buffer, text: async () => 'phrase' })
            }))
          };
          const event = new DragEvent('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'dataTransfer', { value: { items: [{ kind: 'file', webkitGetAsEntry: () => entry }] } });
          target.dispatchEvent(event);
        }
        if (finish.length !== 2) throw Error('Both reads must be pending before releasing the barrier');
        finish.forEach(resolve => resolve());
      });
      await expect(contextChip(page, surface, 'file', 'parallel-a.txt')).toBeVisible();
      await expect(contextChip(page, surface, 'file', 'parallel-b.txt')).toBeVisible();
      const body = await sendAndFinish(page, surface);
      expect(body.contextSources).toEqual([
        { kind: 'file', name: 'parallel-a.txt', text: 'phrase' },
        { kind: 'file', name: 'parallel-b.txt', text: 'phrase' }
      ]);
    }
  });

  test('三处输入框拖入文件后草稿还在，可单独拿掉，发送不再包含该文件 [AC:composer-drag-context#AC-1]', async ({ page }) => {
    const token = stamp();
    for (const surface of ['chat', 'bot', 'group'] as const) {
      const draft = `草稿还在 ${surface} ${token}`;
      const kept = { name: `kept-${surface}-${token}.txt`, text: `kept-sentence-${surface}-${token}` };
      const removed = { name: `removed-${surface}-${token}.txt`, text: `removed-sentence-${surface}-${token}` };
      await openSurface(page, surface);
      await composerInput(page, surface).fill(draft);
      await dropOn(page, surface, { files: [kept, removed] });
      await expect(composerInput(page, surface)).toHaveValue(draft);
      await expect(contextChip(page, surface, 'file', kept.name)).toBeVisible();
      await expect(contextChip(page, surface, 'file', removed.name)).toBeVisible();
      await contextChip(page, surface, 'file', removed.name).getByTestId('composer-context-remove').click();
      await expect(contextChip(page, surface, 'file', removed.name)).toHaveCount(0);
      await expect(contextChip(page, surface, 'file', kept.name)).toBeVisible();
      await expect(composerInput(page, surface)).toHaveValue(draft);

      const body = await sendAndFinish(page, surface);
      expect(body.contextSources).toEqual([{ kind: 'file', name: kept.name, text: kept.text }]);
      const turn = await sentTurn(page, surface, draft);
      await expect(messageContext(turn, 'file', kept.name)).toContainText(kept.name);
      await expect(turn.locator(`[data-testid="composer-message-context"][data-name="${removed.name}"]`)).toHaveCount(0);
      await expect(turn).not.toContainText(removed.text);
    }
  });

  test('三处输入框拖入文件夹后能看见名称，拿掉后发送不再包含 [AC:composer-drag-context#AC-2]', async ({ page }) => {
    const token = stamp();
    for (const surface of ['chat', 'bot', 'group'] as const) {
      const draft = `文件夹草稿 ${surface} ${token}`;
      const folder = {
        name: `pack-${surface}-${token}`,
        entries: [{ path: 'readme.txt', text: `folder-sentence-${surface}-${token}` }]
      };
      await openSurface(page, surface);
      await composerInput(page, surface).fill(draft);
      await dropOn(page, surface, { folder });
      await expect(composerInput(page, surface)).toHaveValue(draft);
      await expect(contextChip(page, surface, 'folder', folder.name)).toBeVisible();
      await contextChip(page, surface, 'folder', folder.name).getByTestId('composer-context-remove').click();
      await expect(contextChip(page, surface, 'folder', folder.name)).toHaveCount(0);
      await expect(composerInput(page, surface)).toHaveValue(draft);

      const body = await sendAndFinish(page, surface);
      expectNoContext(body);
      const turn = await sentTurn(page, surface, draft);
      await expect(turn.locator('[data-testid="composer-message-context"]')).toHaveCount(0);
      await expect(turn).not.toContainText(folder.name);
      await expect(turn).not.toContainText(folder.entries[0].text);
    }
  });

  test('对话发送后保留文件名和文件夹名，刷新仍在，助手能用到原句 [AC:composer-drag-context#AC-3]', async ({
    page,
    request
  }) => {
    const token = stamp();
    const draft = `请读这些材料 ${token}`;
    const file = { name: `note-${token}.txt`, text: `file-sentence-${token}` };
    const folder = { name: `docs-${token}`, entries: [{ path: 'readme.txt', text: `nested-sentence-${token}` }] };
    await openSurface(page, 'chat');
    await composerInput(page, 'chat').fill(draft);
    await dropOn(page, 'chat', { files: [file], folder });
    const body = await sendAndFinish(page, 'chat');
    expect(body.contextSources).toEqual([fileWire(file), folderWire(folder)]);
    await expectContextOnMessage(page, 'chat', draft, [
      { kind: 'file', name: file.name },
      { kind: 'folder', name: folder.name }
    ]);

    await expectModelText(request, file.text, [file.text, folder.entries[0].text, file.name, folder.name]);

    await page.reload();
    await openSurface(page, 'chat');
    await page.locator('#sessionListMini .list-item--session', { hasText: draft }).click();
    await expectContextOnMessage(page, 'chat', draft, [
      { kind: 'file', name: file.name },
      { kind: 'folder', name: folder.name }
    ]);
    await expectModelText(request, file.text, [file.text, folder.entries[0].text]);
  });

  test('单个 Bot 的上下文只留在该 Bot，不进别的 Bot 或普通对话 [AC:composer-drag-context#AC-4]', async ({
    page,
    request
  }) => {
    const token = stamp();
    const draft = `只发给这个 Bot ${token}`;
    const file = { name: `alpha-${token}.txt`, text: `alpha-file-sentence-${token}` };
    const folder = { name: `alpha-pack-${token}`, entries: [{ path: 'readme.txt', text: `alpha-folder-sentence-${token}` }] };
    await openSurface(page, 'bot');
    await composerInput(page, 'bot').fill(draft);
    await dropOn(page, 'bot', { files: [file], folder });
    const body = await sendAndFinish(page, 'bot');
    expect(body.contextSources).toEqual([fileWire(file), folderWire(folder)]);
    await expectContextOnMessage(page, 'bot', draft, [
      { kind: 'file', name: file.name },
      { kind: 'folder', name: folder.name }
    ]);

    const own = await sessionDetail(request, alpha.canonicalSessionId);
    expect(textOf(own.messages)).toContain(file.text);
    expect(textOf(own.messages)).toContain(folder.entries[0].text);
    expect((own.messages ?? []).some((message) => message.role === 'assistant')).toBe(true);

    await page.reload();
    await openSurface(page, 'bot');
    await expectContextOnMessage(page, 'bot', draft, [
      { kind: 'file', name: file.name },
      { kind: 'folder', name: folder.name }
    ]);

    await openBot(page, beta.name);
    await expect(transcript(page, 'bot')).not.toContainText(draft);
    await expect(transcript(page, 'bot')).not.toContainText(file.text);
    await expect(transcript(page, 'bot')).not.toContainText(file.name);
    const other = await sessionDetail(request, beta.canonicalSessionId);
    const otherBlob = JSON.stringify(other.messages ?? []);
    expect(otherBlob).not.toContain(draft);
    expect(otherBlob).not.toContain(file.text);
    expect(otherBlob).not.toContain(folder.entries[0].text);

    await openSurface(page, 'chat');
    await expect(transcript(page, 'chat')).not.toContainText(draft);
    await expect(transcript(page, 'chat')).not.toContainText(file.text);
    await expect(page.locator('#sessionListMini')).not.toContainText(file.text);
    await expect(page.locator('#sessionListMini')).not.toContainText(draft);
  });

  test('群聊记录带上文件名和文件夹名，刷新仍在，且不写进成员私人对话 [AC:composer-drag-context#AC-5]', async ({
    page,
    request
  }) => {
    const token = stamp();
    const draft = `群里请看 ${token}`;
    const file = { name: `brief-${token}.txt`, text: `room-file-sentence-${token}` };
    const folder = { name: `bundle-${token}`, entries: [{ path: 'x.txt', text: `room-folder-sentence-${token}` }] };
    await openSurface(page, 'group');
    await composerInput(page, 'group').fill(draft);
    await dropOn(page, 'group', { files: [file], folder });
    const body = await sendAndFinish(page, 'group');
    expect(body.contextSources).toEqual([fileWire(file), folderWire(folder)]);
    await expectContextOnMessage(page, 'group', draft, [
      { kind: 'file', name: file.name },
      { kind: 'folder', name: folder.name }
    ]);

    await expect
      .poll(async () => memberSawSentences(request, room.id, [alpha.canonicalSessionId, beta.canonicalSessionId], file.text, folder.entries[0].text), {
        timeout: 45_000
      })
      .toBe(true);
    for (const bot of [alpha, beta]) {
      const blob = JSON.stringify((await sessionDetail(request, bot.canonicalSessionId)).messages ?? []);
      expect(blob).not.toContain(draft);
      expect(blob).not.toContain(file.text);
      expect(blob).not.toContain(folder.entries[0].text);
    }

    await page.reload();
    await openSurface(page, 'group');
    await expectContextOnMessage(page, 'group', draft, [
      { kind: 'file', name: file.name },
      { kind: 'folder', name: folder.name }
    ]);
    const saved = await roomMessage(request, room.id, draft);
    expect(saved.contextSources).toEqual([fileWire(file), folderWire(folder)]);
  });

  test('拖入选中文字、链接或空拖放不会产生无名称上下文，之后仍能发送 [AC:composer-drag-context#AC-6]', async ({ page }) => {
    const token = stamp();
    for (const surface of ['chat', 'bot', 'group'] as const) {
      const draft = `空拖放草稿 ${surface} ${token}`;
      const sent = `${draft} 继续发送`;
      await openSurface(page, surface);
      await composerInput(page, surface).fill(draft);
      await dropOn(page, surface, { text: `选中的一段文字 ${token}` });
      await dropOn(page, surface, { uri: `https://example.com/drag-${token}` });
      await dropOn(page, surface, { empty: true });
      await expect(composerInput(page, surface)).toHaveValue(draft);
      await expect(dropTarget(page, surface).locator('[data-testid="composer-context-chip"]')).toHaveCount(0);
      await composerInput(page, surface).fill(sent);
      const body = await sendAndFinish(page, surface);
      expectNoContext(body);
      expect(body.message ?? body.text).toContain(sent);
      const turn = await sentTurn(page, surface, sent);
      await expect(turn.locator('[data-testid="composer-message-context"]')).toHaveCount(0);
    }
  });

  test('已选上下文和拿掉操作的文字跟随中文或英文界面 [AC:composer-drag-context#AC-7]', async ({ page }) => {
    const token = stamp();
    const fileName = `lang-${token}.txt`;
    const folderName = `lang-pack-${token}`;
    await openSurface(page, 'chat');
    await expect(languageButton(page, '中文')).toHaveAttribute('aria-pressed', 'true');
    await composerInput(page, 'chat').fill(`语言 ${token}`);
    await dropOn(page, 'chat', {
      files: [{ name: fileName, text: `zh-sentence-${token}` }],
      folder: { name: folderName, entries: [{ path: 'readme.txt', text: `zh-folder-${token}` }] }
    });
    await expectContextCopy(page, '已选上下文', '移除', [fileName, folderName], [
      'Selected context',
      'Remove ',
      'Files and folders with this message'
    ]);

    await languageButton(page, 'English').click();
    await expect(languageButton(page, 'English')).toHaveAttribute('aria-pressed', 'true');
    await expectContextCopy(page, 'Selected context', 'Remove', [fileName, folderName], [
      '已选上下文',
      '移除',
      '这条消息带上的文件和文件夹'
    ]);

    await languageButton(page, '中文').click();
    await expect(languageButton(page, '中文')).toHaveAttribute('aria-pressed', 'true');
    await expectContextCopy(page, '已选上下文', '移除', [fileName, folderName], [
      'Selected context',
      'Remove ',
      'Files and folders with this message'
    ]);
  });
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

function contextChip(page: Page, surface: Surface, kind: 'file' | 'folder', name: string): Locator {
  return dropTarget(page, surface).locator(
    `[data-testid="composer-context-chip"][data-kind="${kind}"][data-name="${name}"]`
  );
}

function transcript(page: Page, surface: Surface): Locator {
  return surface === 'group' ? page.getByTestId('play-group-chat') : page.locator('#playMessages');
}

function messageContext(turn: Locator, kind: 'file' | 'folder', name: string): Locator {
  return turn.locator(`[data-testid="composer-message-context"][data-kind="${kind}"][data-name="${name}"]`);
}

async function expectContextOnMessage(
  page: Page,
  surface: Surface,
  userLine: string,
  labels: Array<{ kind: 'file' | 'folder'; name: string }>
): Promise<void> {
  const turn = await sentTurn(page, surface, userLine);
  for (const label of labels) {
    await expect(messageContext(turn, label.kind, label.name)).toBeVisible();
    await expect(messageContext(turn, label.kind, label.name)).toContainText(label.name);
  }
}

async function sentTurn(page: Page, surface: Surface, userLine: string): Promise<Locator> {
  const turn = transcript(page, surface).locator('.chat-turn--user').filter({ hasText: userLine }).last();
  await expect(turn).toBeVisible();
  return turn;
}

function fileWire(file: { name: string; text: string }): FileWire {
  return { kind: 'file', name: file.name, text: file.text };
}

function folderWire(folder: { name: string; entries: Array<{ path: string; text: string }> }): FolderWire {
  return { kind: 'folder', name: folder.name, entries: folder.entries.map((entry) => ({ path: entry.path, text: entry.text })) };
}

function expectNoContext(body: { contextSources?: unknown }): void {
  const sources = body.contextSources;
  expect(sources === undefined || (Array.isArray(sources) && sources.length === 0)).toBe(true);
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

async function sendAndFinish(page: Page, surface: Surface): Promise<{ message?: string; text?: string; contextSources?: Wire[] }> {
  const submitted = (await composerInput(page, surface).inputValue()).trim();
  const pending = page.waitForResponse((response) => isSend(response.url(), response.request().method(), surface));
  const target = dropTarget(page, surface);
  if (surface === 'group') await target.getByTestId('play-group-send').click();
  else await target.locator('#btnSend').click();
  const response = await pending;
  const raw = await response.text();
  expect(response.status(), raw).toBeLessThan(400);
  const requestBody = response.request().postDataJSON() as { message?: string; text?: string; contextSources?: Wire[] };
  if (surface !== 'group') {
    await expect
      .poll(async () => page.locator('#playMessages').evaluate((root, text) => {
        const turns = Array.from(root.querySelectorAll('.chat-turn'));
        const userIndex = turns.findLastIndex(turn => turn.classList.contains('chat-turn--user') && turn.textContent?.includes(text));
        return userIndex >= 0 && turns.slice(userIndex + 1).some(turn => turn.classList.contains('chat-turn--assistant'));
      }, submitted), { timeout: 70_000 })
      .toBe(true);
  }
  return requestBody;
}

async function dropOn(page: Page, surface: Surface, spec: DropSpec): Promise<void> {
  await dropTarget(page, surface).waitFor();
  await page.evaluate(
    ({ surface: targetSurface, spec: payload }) => {
      const target = document.querySelector(`[data-testid="composer-drop-target"][data-surface="${targetSurface}"]`);
      if (!(target instanceof HTMLElement)) throw new Error(`missing drop target ${targetSurface}`);

      const directoryEntry = (name: string, entries: Array<{ path: string; text: string }>) => {
        type Node = { dirs: Map<string, Node>; files: Map<string, string> };
        const root: Node = { dirs: new Map(), files: new Map() };
        for (const entry of entries) {
          const parts = entry.path.split('/').filter(Boolean);
          let node = root;
          parts.forEach((part, index) => {
            if (index === parts.length - 1) {
              node.files.set(part, entry.text);
              return;
            }
            let next = node.dirs.get(part);
            if (!next) {
              next = { dirs: new Map(), files: new Map() };
              node.dirs.set(part, next);
            }
            node = next;
          });
        }
        const toFs = (node: Node, entryName: string) => {
          const children: Array<Record<string, unknown>> = [];
          for (const [childName, text] of node.files) {
            const file = new File([text], childName, { type: 'text/plain' });
            children.push({
              isFile: true,
              isDirectory: false,
              name: childName,
              file: (success: (file: File) => void) => success(file)
            });
          }
          for (const [childName, child] of node.dirs) children.push(toFs(child, childName));
          let pending = children;
          return {
            isFile: false,
            isDirectory: true,
            name: entryName,
            createReader: () => ({
              readEntries: (success: (entries: unknown[]) => void) => {
                const batch = pending;
                pending = [];
                success(batch);
              }
            })
          };
        };
        return toFs(root, name);
      };

      const proto = DataTransferItem.prototype as DataTransferItem & { webkitGetAsEntry?: () => unknown };
      const original = Object.getOwnPropertyDescriptor(proto, 'webkitGetAsEntry');
      const native = proto.webkitGetAsEntry;
      const plainNames = new Set<string>();
      const directories = new Map<string, ReturnType<typeof directoryEntry>>();
      Object.defineProperty(proto, 'webkitGetAsEntry', {
        configurable: true,
        writable: true,
        value(this: DataTransferItem) {
          const file = this.getAsFile?.() ?? null;
          const name = file?.name ?? '';
          if (directories.has(name)) return directories.get(name);
          if (plainNames.has(name)) return null;
          return native ? native.call(this) : null;
        }
      });
      try {
        const transfer = new DataTransfer();
        if (payload.empty) {
          /* no files */
        } else if (payload.text != null) {
          transfer.setData('text/plain', payload.text);
        } else if (payload.uri != null) {
          transfer.setData('text/uri-list', payload.uri);
          transfer.setData('text/plain', payload.uri);
        } else {
          for (const file of payload.files ?? []) {
            transfer.items.add(new File([file.text], file.name, { type: 'text/plain' }));
            plainNames.add(file.name);
          }
          if (payload.folder) {
            const marker = `folder-marker-${payload.folder.name}.bin`;
            transfer.items.add(new File(['folder-marker'], marker, { type: 'application/octet-stream' }));
            directories.set(marker, directoryEntry(payload.folder.name, payload.folder.entries));
          }
        }
        for (const type of ['dragenter', 'dragover', 'drop']) {
          target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }
      } finally {
        if (original) Object.defineProperty(proto, 'webkitGetAsEntry', original);
        else delete proto.webkitGetAsEntry;
      }
    },
    { surface, spec }
  );
}

function languageButton(page: Page, name: string): Locator {
  return page.getByTestId('language-toggle').getByRole('button', { name, exact: true });
}

async function expectContextCopy(
  page: Page,
  listLabel: string,
  removeVerb: string,
  names: string[],
  absent: string[]
): Promise<void> {
  const list = dropTarget(page, 'chat').getByRole('list', { name: listLabel });
  await expect(list).toBeVisible();
  const text = (await list.evaluate((node) => node.textContent)) ?? '';
  for (const name of names) {
    const chip = list.locator(`[data-testid="composer-context-chip"][data-name="${name}"]`);
    await expect(chip).toBeVisible();
    await expect(chip.getByTestId('composer-context-remove')).toHaveAttribute('aria-label', `${removeVerb} ${name}`);
    expect(text).toContain(`${removeVerb} ${name}`);
  }
  for (const foreign of absent) expect(text).not.toContain(foreign);
}

type StoredMessage = { role?: string; parts?: Array<{ type?: string; text?: string }> };

function textOf(messages: StoredMessage[] | undefined): string {
  return (messages ?? [])
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

async function expectModelText(request: APIRequestContext, needle: string, phrases: string[]): Promise<void> {
  const detail = await sessionContaining(request, needle);
  const text = textOf(detail.messages);
  for (const phrase of phrases) expect(text).toContain(phrase);
  expect((detail.messages ?? []).some((message) => message.role === 'assistant')).toBe(true);
}

async function sessionDetail(
  request: APIRequestContext,
  sessionId: string
): Promise<{ session?: { metadata?: { canonicalBotChat?: boolean; roomId?: string } }; messages?: StoredMessage[] }> {
  const res = await request.get(`/api/sessions/${sessionId}`);
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
  return JSON.parse(raw) as { session?: { metadata?: { canonicalBotChat?: boolean; roomId?: string } }; messages?: StoredMessage[] };
}

async function sessionContaining(
  request: APIRequestContext,
  phrase: string
): Promise<{ messages?: StoredMessage[] }> {
  const listed = await request.get('/api/sessions');
  const raw = await listed.text();
  expect(listed.ok(), raw).toBeTruthy();
  const { sessions } = JSON.parse(raw) as { sessions: Array<{ id: string }> };
  for (const session of sessions) {
    const detail = await sessionDetail(request, session.id);
    if (JSON.stringify(detail.messages ?? []).includes(phrase)) return detail;
  }
  throw new Error(`no session contains ${phrase}`);
}

async function memberSawSentences(
  request: APIRequestContext,
  roomId: string,
  canonicalIds: string[],
  fileText: string,
  folderText: string
): Promise<boolean> {
  const listed = await request.get('/api/sessions');
  if (!listed.ok()) return false;
  const { sessions } = (await listed.json()) as { sessions: Array<{ id: string }> };
  for (const session of sessions) {
    if (canonicalIds.includes(session.id)) continue;
    const detail = await sessionDetail(request, session.id);
    if (detail.session?.metadata?.roomId !== roomId) continue;
    const text = textOf(detail.messages);
    if (text.includes(fileText) && text.includes(folderText)) return true;
  }
  return false;
}

async function roomMessage(
  request: APIRequestContext,
  roomId: string,
  text: string
): Promise<{ contextSources?: Wire[] }> {
  const res = await request.get(`/api/bot-rooms/${roomId}/messages`);
  const raw = await res.text();
  expect(res.ok(), raw).toBeTruthy();
  const body = JSON.parse(raw) as { messages: Array<{ text?: string; contextSources?: Wire[] }> };
  const message = body.messages.find((item) => item.text === text);
  expect(message).toBeTruthy();
  return message!;
}
