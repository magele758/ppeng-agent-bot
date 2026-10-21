import { expect, test } from '@playwright/test';

test('confirm intent once, show automatic save, keep composer usable [AC:skill-capture-intent-confirmation#AC-2] [AC:skill-capture-intent-confirmation#AC-3] [AC:skill-capture-intent-confirmation#AC-4]', async ({ page }) => {
  const sid = 'capture-ui-session';
  const session = { id: sid, title: 'capture-ui-check', mode: 'chat', status: 'idle', agentId: 'general' };
  const capture = { id: 'sc_123', name: 'release-check', description: '验证发布', reason: '发布流程已成功验证', summary: '检查构建与健康端点', kind: 'update', status: 'pending' };
  let confirmations = 0;
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route(new RegExp(`/api/sessions/${sid}(?:\\?|$)`), route => route.fulfill({ json: { session, messages: [{ role: 'assistant', parts: [{ type: 'text', text: '发布验证完成。' }] }], latestAssistant: '发布验证完成。' } }));
  await page.route(`**/api/sessions/${sid}/skill-captures`, route => route.fulfill({ json: { captures: [capture] } }));
  await page.route(`**/api/sessions/${sid}/skill-captures/sc_123/confirm`, async route => {
    confirmations++; capture.status = 'saved';
    await route.fulfill({ json: { capture } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /capture-ui-check/ }).first().click();
  const dialog = page.getByRole('dialog', { name: '技能沉淀建议' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('release-check');
  await expect(dialog).toContainText('发布流程已成功验证');
  await expect(dialog).toContainText('检查构建与健康端点');
  await expect(dialog).toContainText('更新');
  await expect(page.locator('#playInput')).toBeEnabled();
  await dialog.getByRole('button', { name: '确认并提炼' }).click();
  await expect(dialog).toContainText('已保存，可在后续对话中使用');
  await expect(dialog.getByRole('button', { name: '确认并提炼' })).toHaveCount(0);
  expect(confirmations).toBe(1);
});

test('reject persists across reload, failed capture is visible [AC:skill-capture-intent-confirmation#AC-4] [AC:skill-capture-intent-confirmation#AC-5]', async ({ page }) => {
  const sid = 'capture-reject-session';
  const session = { id: sid, title: 'capture-reject-check', mode: 'chat', status: 'idle', agentId: 'general' };
  const captures = [
    { id: 'sc_reject', name: 'release-check', description: '验证发布', reason: '成功经验', summary: '发布步骤', kind: 'new', status: 'pending' },
    { id: 'sc_fail', name: 'health-check', description: '验证健康状态', reason: '成功经验', summary: '检查步骤', kind: 'update', status: 'pending', error: '' }
  ];
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route(new RegExp(`/api/sessions/${sid}(?:\\?|$)`), route => route.fulfill({ json: { session, messages: [], latestAssistant: '' } }));
  await page.route(`**/api/sessions/${sid}/skill-captures`, route => route.fulfill({ json: { captures } }));
  await page.route(`**/api/sessions/${sid}/skill-captures/sc_reject/reject`, route => {
    captures[0].status = 'rejected'; return route.fulfill({ json: { capture: captures[0] } });
  });
  await page.route(`**/api/sessions/${sid}/skill-captures/sc_fail/confirm`, route => {
    captures[1].status = 'failed'; captures[1].error = 'Model unavailable';
    return route.fulfill({ json: { capture: captures[1] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /capture-reject-check/ }).first().click();
  await page.getByTestId('skill-capture-sc_reject').getByRole('button', { name: '拒绝' }).click();
  await expect(page.getByTestId('skill-capture-sc_reject')).toContainText('已拒绝');
  await page.reload();
  await page.getByRole('button', { name: /capture-reject-check/ }).first().click();
  const rejected = page.getByTestId('skill-capture-sc_reject');
  await expect(rejected).toContainText('已拒绝');
  await expect(rejected.getByRole('button', { name: /^(确认并提炼|拒绝)$/ })).toHaveCount(0);
  const failed = page.getByTestId('skill-capture-sc_fail');
  await failed.getByRole('button', { name: '确认并提炼' }).click();
  await expect(failed).toContainText('未修改技能');
  await expect(failed.getByRole('alert')).toContainText('Model unavailable');
});
