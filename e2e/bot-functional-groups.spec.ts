import { test, expect, type Page } from '@playwright/test';

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
    await page.getByTestId('functional-group-ungrouped').getByRole('button').filter({ hasText: f.name }).dragTo(group.locator('h3'));
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
    await ungrouped.getByRole('button').filter({ hasText: f.name }).dragTo(group.locator('h3'));
    await expect(group).toContainText(f.name);
    await expect.poll(() => f.groups[0]?.botIds).toContain(f.bot.id);
    await page.reload();
    await expect(group).toContainText(f.name);
    f.fail();
    await group.getByRole('button').filter({ hasText: f.name }).dragTo(ungrouped.locator('h3'));
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
