import { test, expect, type Page } from '@playwright/test';

async function checkRapidSelection(page: Page, failLast: boolean) {
  const room = { id: 'rapid-mode', title: 'Rapid mode', botIds: ['a', 'b'], hostBotId: 'a', status: 'active', replyMode: 'coordinator' };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [room] } }));
  await page.route('**/api/bot-rooms/rapid-mode', async r => {
    if (r.request().method() === 'PATCH') {
      const mode = r.request().postDataJSON().replyMode;
      writes.push(mode);
      if (writes.length === 1) await pending;
      if (failLast && writes.length === 2) return r.fulfill({ status: 503, json: { error: 'retry later' } });
      room.replyMode = mode;
    }
    return r.fulfill({ json: { room } });
  });
  await page.route('**/api/bot-rooms/rapid-mode/messages*', r => r.fulfill({ json: { messages: [], hasMore: false } }));
  await page.route('**/api/bot-rooms/rapid-mode/turns', r => r.fulfill({ json: { turns: [] } }));
  const open = async () => {
    await page.goto('/#/bot');
    await page.getByRole('button', { name: '打开群聊 Rapid mode', exact: true }).click();
    const panel = page.getByTestId('play-group-chat');
    await panel.getByRole('button', { name: '更多', exact: true }).click();
    await panel.getByRole('button', { name: '群聊设置', exact: true }).click();
  };
  await open();
  const first = page.getByTestId('group-reply-mode-task-collaboration');
  const last = page.getByTestId('group-reply-mode-all-members');
  try {
    await first.check();
    await expect.poll(() => writes.length).toBe(1);
    await expect(last).toBeEnabled({ timeout: 1000 });
    await last.check();
    await expect(last).toBeChecked();
    expect(writes).toEqual(['task-collaboration']);
  } finally { release(); }
  await expect.poll(() => writes).toEqual(['task-collaboration', 'all-members']);
  if (failLast) {
    await expect(first).toBeChecked();
    await expect(page.getByTestId('group-reply-mode-error')).toBeVisible();
    await last.check();
  }
  await expect.poll(() => room.replyMode).toBe('all-members');
  await page.reload();
  await open();
  await expect(last).toBeChecked();
}

test('save the latest selection after a slow reply-mode request [AC:group-mode-instant-selection#AC-1]', async ({ page }) => {
  await checkRapidSelection(page, false);
});

test('restore the last confirmed reply mode after an error [AC:group-mode-instant-selection#AC-2]', async ({ page }) => {
  await checkRapidSelection(page, true);
});
