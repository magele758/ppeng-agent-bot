import { test, expect, type Page } from '@playwright/test';
import { dragSessionRow } from './helpers/drag-session-row';

type Group = { id: string; name: string; botIds: string[] };
async function fixture(page: Page) {
  const name = `Grouping ${Date.now()}`;
  const created = await page.request.post('/api/bots', { data: { name } });
  expect(created.ok()).toBeTruthy();
  const { bot } = await created.json();
  await page.request.post(`/api/bots/${bot.id}/open`);
  const groups: Group[] = [];
  let failMove = false;
  await page.route('**/api/bot-functional-groups**', async (route) => {
    const req = route.request();
    const id = new URL(req.url()).pathname.split('/')[3];
    if (req.method() === 'GET') return route.fulfill({ json: { groups } });
    if (req.method() === 'POST') {
      const group = { id: `group-${groups.length}`, name: req.postDataJSON().name, botIds: [] };
      groups.push(group);
      return route.fulfill({ json: { group } });
    }
    const index = groups.findIndex((g) => g.id === id);
    if (req.method() === 'PATCH') { groups[index].name = req.postDataJSON().name; return route.fulfill({ json: { group: groups[index] } }); }
    groups.splice(index, 1);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/bots/${bot.id}/functional-group`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (failMove) return route.fulfill({ status: 500, json: { error: 'Move unavailable' } });
    groups.forEach((g) => { g.botIds = g.botIds.filter((id) => id !== bot.id); });
    groups.find((g) => g.id === route.request().postDataJSON().groupId)?.botIds.push(bot.id);
    return route.fulfill({ json: { bot } });
  });
  await page.goto('/#/bot');
  return { bot, name, groups, fail: () => { failMove = true; } };
}
async function create(page: Page, name: string) {
  await page.locator('#btnPlayCreate').click();
  await page.getByRole('menuitem', { name: '新建功能分组', exact: true }).click();
  await page.getByLabel('功能分组名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '保存功能分组', exact: true }).click();
}

test('custom functional groups replace dates while rooms remain accessible [AC:bot-functional-groups#AC-5]', async ({ page }) => {
  const f = await fixture(page);
  try {
    await expect(page.getByTestId('functional-group-ungrouped')).toContainText(f.name);
    await expect(page.locator('#sessionListMini .session-date-group')).toHaveCount(0);
    await page.locator('#btnPlayCreate').click();
    await expect(page.getByRole('menuitem', { name: '新建群聊', exact: true })).toBeVisible();
  } finally { await page.request.patch(`/api/bots/${f.bot.id}`, { data: { hidden: true } }); await page.request.delete(`/api/sessions/${f.bot.canonicalSessionId}`); }
});

test('create rename delete groups persists without deleting Bots or conversations [AC:bot-functional-groups#AC-6]', async ({ page }) => {
  const f = await fixture(page);
  try {
    await create(page, 'Research');
    await page.reload();
    const group = page.getByTestId('functional-group-group-0');
    await expect(group).toContainText('Research');
    await group.getByRole('button', { name: '重命名功能分组' }).click();
    await page.getByLabel('功能分组名称', { exact: true }).fill('Writing');
    await page.getByRole('button', { name: '保存功能分组', exact: true }).click();
    await expect(group).toContainText('Writing');
    await dragSessionRow(page, page.getByTestId('functional-group-ungrouped').getByRole('button').filter({ hasText: f.name }), group.locator('h3'));
    await expect.poll(() => f.groups[0]?.botIds).toContain(f.bot.id);
    page.once('dialog', (dialog) => dialog.accept());
    await group.getByRole('button', { name: '删除功能分组' }).click();
    await page.reload();
    await expect(page.getByTestId('functional-group-ungrouped')).toContainText(f.name);
    await expect(page.getByTestId('functional-group-group-0')).toHaveCount(0);
  } finally { await page.request.patch(`/api/bots/${f.bot.id}`, { data: { hidden: true } }); await page.request.delete(`/api/sessions/${f.bot.canonicalSessionId}`); }
});

test('drag moves immediately persists and rolls back on failure [AC:bot-functional-groups#AC-7] [AC:bot-group-drag-only#AC-2]', async ({ page }) => {
  const f = await fixture(page);
  try {
    await create(page, 'Research');
    const group = page.getByTestId('functional-group-group-0');
    const ungrouped = page.getByTestId('functional-group-ungrouped');
    await dragSessionRow(page, ungrouped.getByRole('button').filter({ hasText: f.name }), group.locator('h3'));
    await expect(group).toContainText(f.name);
    await expect.poll(() => f.groups[0]?.botIds).toContain(f.bot.id);
    await page.reload();
    await expect(group).toContainText(f.name);
    f.fail();
    await dragSessionRow(page, group.getByRole('button').filter({ hasText: f.name }), ungrouped.locator('h3'));
    await expect(page.getByRole('alert').filter({ hasText: 'Move unavailable' })).toBeVisible();
    await expect(group).toContainText(f.name);
  } finally { await page.request.patch(`/api/bots/${f.bot.id}`, { data: { hidden: true } }); await page.request.delete(`/api/sessions/${f.bot.canonicalSessionId}`); }
});

test('shared facts editor saves only explicit facts in the selected global or group scope', async ({ page }) => {
  page.setDefaultTimeout(5000);
  const f = await fixture(page);
  const entries = new Map<string, Record<string, string>>();
  await page.route('**/api/bot-shared-context?**', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get('scope')}:${url.searchParams.get('id') ?? ''}`;
    if (route.request().method() === 'PUT') entries.set(key, route.request().postDataJSON().entries);
    return route.fulfill({ json: { entries: entries.get(key) ?? {} } });
  });
  try {
    await create(page, 'Research');
    await page.getByText('共享信息', { exact: true }).click();
    await page.getByRole('button', { name: '添加信息', exact: true }).click();
    await page.getByLabel('第 1 条信息的名称').fill('City');
    await page.getByLabel('第 1 条信息的内容').fill('Hangzhou');
    await page.getByRole('button', { name: '保存共享信息', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    expect(entries.get('global:')).toEqual({ City: 'Hangzhou' });
    await page.getByLabel('共享范围', { exact: true }).selectOption('group-0');
    await expect(page.getByLabel('第 1 条信息的名称')).toHaveCount(0);
    await page.getByRole('button', { name: '添加信息', exact: true }).click();
    await page.getByLabel('第 1 条信息的名称').fill('City');
    await page.getByLabel('第 1 条信息的内容').fill('Shanghai');
    await page.getByRole('button', { name: '保存共享信息', exact: true }).click();
    await expect.poll(() => entries.get('group:group-0')).toEqual({ City: 'Shanghai' });
    await page.reload();
    await page.getByText('共享信息', { exact: true }).click();
    await expect(page.getByLabel('第 1 条信息的内容')).toHaveValue('Hangzhou');
    await page.getByLabel('共享范围', { exact: true }).selectOption('group-0');
    await expect(page.getByLabel('第 1 条信息的内容')).toHaveValue('Shanghai');
  } finally { await page.request.patch(`/api/bots/${f.bot.id}`, { data: { hidden: true } }); await page.request.delete(`/api/sessions/${f.bot.canonicalSessionId}`); }
});

test('explicit group cleanup can be cancelled and preserves conversation history [AC:bot-group-cleanup#AC-1]', async ({ page, request }) => {
  const name = 'Cleanup ' + Date.now();
  const { bot } = await (await request.post('/api/bots', { data: { name } })).json();
  const { group } = await (await request.post('/api/bot-functional-groups', { data: { name } })).json();
  await request.put(`/api/bots/${bot.id}/functional-group`, { data: { groupId: group.id } });
  await request.post(`/api/sessions/${bot.canonicalSessionId}/messages`, { data: { message: 'Keep this conversation', autoRun: false } });
  await page.goto('/#/bot');
  const section = page.getByTestId('functional-group-' + group.id);
  const menu = section.getByRole('button', { name: name + ' 的更多操作', exact: true }).first();
  const remove = section.getByRole('button', { name: '同时删除组内 Bot', exact: true });
  await menu.click();
  page.once('dialog', dialog => dialog.dismiss());
  await remove.click();
  await expect(section).toBeVisible();
  await menu.click();
  page.once('dialog', dialog => dialog.accept());
  await remove.click();
  await expect(section).toHaveCount(0);
  expect((await request.get('/api/bots/' + bot.id)).status()).toBe(404);
  const history = await (await request.get('/api/sessions/' + bot.canonicalSessionId)).json();
  expect(JSON.stringify(history)).toContain('Keep this conversation');
});

test('sidebar groups independently collapse and reopen [AC:functional-group-disclosure#AC-1]', async ({ page }) => {
  const f = await fixture(page);
  try {
    await create(page, 'Research');
    const group = page.getByTestId('functional-group-group-0');
    const ungrouped = page.getByTestId('functional-group-ungrouped');
    const toggle = group.getByRole('heading').getByRole('button');
    const looseToggle = ungrouped.getByRole('heading').getByRole('button');
    const bot = ungrouped.locator('[data-bot-id]').filter({ hasText: f.name });
    const hint = group.getByText('拖拽 Bot 或群聊到这里');
    await expect(hint).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 3000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Research');
    await expect(group.getByText('0', { exact: true })).toBeVisible();
    await expect(hint).toBeHidden();
    await expect(bot).toBeVisible();
    await looseToggle.click();
    await expect(bot).toBeHidden();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(hint).toBeVisible();
    await expect(bot).toBeHidden();
    await looseToggle.focus();
    await looseToggle.press('Space');
    await expect(bot).toBeVisible();
  } finally {
    await page.request.patch(`/api/bots/${f.bot.id}`, { data: { hidden: true } });
    await page.request.delete(`/api/sessions/${f.bot.canonicalSessionId}`);
  }
});

test('only current roster conversations appear as Bot entries [AC:bot-sidebar-routing#AC-1]', async ({ page, request }) => {
  const createBot = async (name: string) => {
    const res = await request.post('/api/bots', { data: { name } });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).bot;
  };
  const active = await createBot('Visible ' + Date.now());
  const removed = await createBot('Historical ' + Date.now());
  try {
    expect((await request.patch('/api/bots/' + removed.id, { data: { hidden: true } })).ok()).toBeTruthy();
    await page.goto('/#/bot');
    const sidebar = page.locator('#sessionListMini');
    const activeRow = sidebar.locator(`[data-session-id="${active.canonicalSessionId}"]`);
    const history = sidebar.locator(`[data-session-id="${removed.canonicalSessionId}"]`);
    await expect(activeRow).toBeVisible();
    await expect(history).toHaveCount(0);
    await activeRow.click();
    await expect(activeRow).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.chat-panel-header__title-row').first()).toContainText(active.name);
    await page.goto('/#/chat');
    await expect(history).toBeVisible();
    await history.click();
    await expect(history).toHaveAttribute('aria-current', 'true');
  } finally {
    for (const bot of [active, removed]) {
      await request.delete('/api/bots/' + bot.id);
      await request.delete('/api/sessions/' + bot.canonicalSessionId);
    }
  }
});
