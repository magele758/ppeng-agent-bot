import { test, expect, type Locator, type Page } from '@playwright/test';

// Mock only Room storage: browser checks must never delete a person's real rooms.
async function mockRoom(page: Page, failFirst = false) {
  let exists = true;
  let attempts = 0;
  await page.route('**/api/bot-rooms', route => route.fulfill({ json: { rooms: exists ? [{ id: 'deletion-test-room', title: 'Deletion test room', botIds: [], status: 'active' }] : [] } }));
  await page.route('**/api/bot-rooms/deletion-test-room', route => {
    if (route.request().method() !== 'DELETE') return route.fulfill({ json: { room: { id: 'deletion-test-room', title: 'Deletion test room', botIds: [], status: 'active' } } });
    attempts++;
    if (failFirst && attempts === 1) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    exists = false;
    return route.fulfill({ json: { deleted: true } });
  });
  await page.goto('/#/bot');
  return { attempts: () => attempts };
}

async function clickGroupDelete(row: Locator) {
  await row.getByRole('button',{name:'Deletion test room 的更多操作'}).click();
  await row.getByTestId('play-group-delete').click();
}

test('group deletion stays behind the menu [AC:play-group-delete-menu#AC-1] [AC:play-group-delete-menu#AC-2]', async ({ page }) => {
  await mockRoom(page);
  const row=page.getByTestId('play-group-row').filter({hasText:'Deletion test room'});
  await expect(row.getByTestId('play-group-delete')).toBeHidden();
  const trigger=row.getByRole('button',{name:'Deletion test room 的更多操作'});
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(row.getByTestId('play-group-delete')).toBeVisible();
  await expect(row.getByTestId('play-group-delete')).toHaveAttribute('aria-label','删除群聊 Deletion test room');
});
test.describe('touch browser',()=>{
  test.use({hasTouch:true});
  test('touch opens the same menu [AC:play-group-delete-menu#AC-2]',async({page})=>{
    await mockRoom(page);
    const row=page.getByTestId('play-group-row').filter({hasText:'Deletion test room'});
    await row.getByRole('button',{name:'Deletion test room 的更多操作'}).tap();
    await expect(row.getByTestId('play-group-delete')).toBeVisible();
  });
});

test('confirming deletion removes a room after refresh [AC:bot-functional-groups#AC-1] [AC:bot-entry-simplification#AC-7] [AC:play-group-delete-menu#AC-3]', async ({ page }) => {
  await mockRoom(page);
  const row = page.getByTestId('play-group-row').filter({ hasText: 'Deletion test room' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('play-group-chat')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await clickGroupDelete(row);
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('play-group-chat')).toHaveCount(0);
  await page.reload();
  await expect(row).toHaveCount(0);
});

test('cancel or failure preserves a room with a visible error and retry [AC:bot-functional-groups#AC-2] [AC:bot-entry-simplification#AC-7] [AC:play-group-delete-menu#AC-3]', async ({ page }) => {
  const state = await mockRoom(page, true);
  const row = page.getByTestId('play-group-row').filter({ hasText: 'Deletion test room' });
  page.once('dialog', dialog => { expect(dialog.message()).toContain('Deletion test room'); expect(dialog.message()).toContain('成员 Bot 和私人对话会保留'); return dialog.dismiss(); });
  await clickGroupDelete(row);
  expect(state.attempts()).toBe(0);
  await expect(row).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await clickGroupDelete(row);
  await expect(page.getByTestId('play-group-delete-error')).toContainText(/删除失败|没能删除/);
  await expect(row).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await clickGroupDelete(row);
  await expect(row).toHaveCount(0);
  expect(state.attempts()).toBe(2);
});

test('a room explicitly saves its own shared facts and reloads them [AC:bot-functional-groups#AC-8]', async ({ page }) => {
  let entries: Record<string, string> = {};
  await page.route('**/api/bot-rooms/deletion-test-room/messages*', route => route.fulfill({ json: { messages: [], nextCursor: null, hasMore: false } }));
  await page.route('**/api/bot-rooms/deletion-test-room/turns', route => route.fulfill({ json: { turns: [] } }));
  await page.route('**/api/bot-shared-context?scope=room&id=deletion-test-room', route => {
    if (route.request().method() === 'PUT') entries = route.request().postDataJSON().entries;
    return route.fulfill({ json: { entries } });
  });
  await mockRoom(page);
  await page.getByTestId('play-group-row').filter({ hasText: 'Deletion test room' }).click();
  await page.getByRole('button', { name: '群聊设置', exact: true }).click();
  const editor = page.getByTestId('room-shared-context');
  await editor.locator('summary').click();
  await editor.getByTestId('room-shared-add').click();
  await editor.getByTestId('room-shared-key').fill('deployment');
  await editor.getByTestId('room-shared-value').fill('room-specific target');
  await editor.getByTestId('room-shared-save').click();
  await expect(editor.getByRole('status')).toContainText(/已保存/);
  expect(entries).toEqual({ deployment: 'room-specific target' });
  await page.reload();
  await page.getByTestId('play-group-row').filter({ hasText: 'Deletion test room' }).click();
  await page.getByRole('button', { name: '群聊设置', exact: true }).click();
  await editor.locator('summary').click();
  await expect(editor.getByTestId('room-shared-value')).toHaveValue('room-specific target');
});
