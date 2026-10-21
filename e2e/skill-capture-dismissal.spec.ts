import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  const sessions = ['a', 'b'].map(id => ({ id: `dismiss-${id}`, title: `Dismiss session ${id}`, mode: 'chat', status: 'idle', agentId: 'general' }));
  const saved = { id: 'saved', name: 'release-check', description: 'Release workflow', reason: '成功经验'.repeat(80), summary: '经过验证的详细步骤'.repeat(100), kind: 'new', status: 'saved' };
  const captures = [saved, ...['pending', 'processing', 'failed'].map(status => ({ ...saved, id: status, name: status, reason: '短理由', summary: '短概要', status, error: status === 'failed' ? 'Model unavailable' : undefined }))];
  const writes: string[] = [];
  let polls = 0;
  page.on('request', request => { if (['POST', 'PATCH', 'DELETE'].includes(request.method()) && /skill|memory/.test(request.url())) writes.push(request.url()); });
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions } }));
  for (const session of sessions) {
    await page.route(new RegExp(`/api/sessions/${session.id}(?:\\?|$)`), route => route.fulfill({ json: { session, messages: [{ id: 'msg1', role: 'assistant', parts: [{ type: 'text', text: '对话内容仍可阅读' }] }], latestAssistant: '对话内容仍可阅读' } }));
    await page.route(`**/api/sessions/${session.id}/skill-captures`, route => { polls++; return route.fulfill({ json: { captures: session.id === 'dismiss-a' ? captures : [saved] } }); });
  }
  await page.goto('/#/chat');
  await page.getByRole('button', { name: /Dismiss session a/ }).first().click();
  return { saved, captures, writes, polls: () => polls };
}

test('saved suggestions collapse, dismiss without changing skills, and retain other states [AC:skill-capture-dismissal#AC-1] [AC:skill-capture-dismissal#AC-2] [AC:skill-capture-dismissal#AC-4]', async ({ page }) => {
  const { writes } = await setup(page);
  const card = page.getByTestId('skill-capture-saved');
  await expect(card).toContainText('release-check');
  await expect(card).toContainText('已保存');
  await expect(card.locator('dl')).not.toBeVisible();
  await card.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(card.locator('dl')).toBeVisible();
  await card.getByRole('button', { name: '收起详情', exact: true }).click();
  await expect(card.locator('dl')).not.toBeVisible();
  await card.getByRole('button', { name: '关闭已保存提示', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('skill-capture-pending').getByRole('button', { name: '确认并提炼' })).toBeVisible();
  await expect(page.getByTestId('skill-capture-processing')).toContainText('正在');
  await expect(page.getByTestId('skill-capture-failed').getByRole('alert')).toHaveText('Model unavailable');
  expect(writes).toEqual([]);
  await page.locator('#playInput').fill('继续对话');
  await expect(page.locator('#playInput')).toHaveValue('继续对话');
});

test('dismissal survives polling, reload and return, but not new suggestions or other sessions [AC:skill-capture-dismissal#AC-3]', async ({ page }) => {
  const { captures, saved, polls } = await setup(page);
  await page.getByTestId('skill-capture-saved').getByRole('button', { name: '关闭已保存提示', exact: true }).click();
  const before = polls();
  await expect.poll(polls).toBeGreaterThan(before);
  await expect(page.getByTestId('skill-capture-saved')).toHaveCount(0);
  captures.push({ ...saved, id: 'saved-next' });
  await expect(page.getByTestId('skill-capture-saved-next')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Dismiss session a/ }).first().click();
  await expect(page.getByTestId('skill-capture-saved-next')).toBeVisible();
  await expect(page.getByTestId('skill-capture-saved')).toHaveCount(0);
  await page.getByRole('button', { name: /Dismiss session b/ }).first().click();
  await expect(page.getByTestId('skill-capture-saved')).toBeVisible();
  await page.getByRole('button', { name: /Dismiss session a/ }).first().click();
  await expect(page.getByTestId('skill-capture-saved-next')).toBeVisible();
  await expect(page.getByTestId('skill-capture-saved')).toHaveCount(0);
});

for (const width of [1280, 820]) {
  test(`saved card keyboard controls preserve usable chat at ${width}px [AC:skill-capture-dismissal#AC-5]`, async ({ page }) => {
    await page.setViewportSize({ width, height: 804 });
    await setup(page);
    const card = page.getByTestId('skill-capture-saved');
    const expand = card.getByRole('button', { name: '查看详情', exact: true });
    await expand.focus(); await page.keyboard.press('Enter');
    await expect(card.locator('dl')).toBeVisible();
    await card.getByRole('button', { name: '收起详情', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(card.locator('dl')).not.toBeVisible();
    await card.getByRole('button', { name: '关闭已保存提示', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('skill-capture-pending')).toBeInViewport();
    await expect(page.locator('#playInput')).toBeInViewport();
    await page.locator('#playInput').fill('关闭后继续输入');
    await expect(page.locator('#playInput')).toHaveValue('关闭后继续输入');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
