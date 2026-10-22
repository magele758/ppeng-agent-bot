import { test, expect, type Page } from '@playwright/test';

type Operation = {
  id: string;
  name: string;
  affectedBotIds: string[];
  input: { action: 'create'; reason: string; summary: string };
  status: 'pending' | 'processing' | 'saved' | 'rejected' | 'failed';
  error?: string;
};

function operation(partial: {
  id: string;
  name: string;
  status: Operation['status'];
  reason?: string;
  summary?: string;
  error?: string;
}): Operation {
  return {
    id: partial.id,
    name: partial.name,
    affectedBotIds: [],
    input: {
      action: 'create',
      reason: partial.reason ?? '理由',
      summary: partial.summary ?? '摘要',
    },
    status: partial.status,
    error: partial.error,
  };
}

async function openChat(page: Page, sessionId: string, title: string, operations: Operation[]) {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });
  const session = { id: sessionId, title, mode: 'chat', status: 'idle', agentId: 'general' };
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [session] } }));
  await page.route(new RegExp(`/api/sessions/${sessionId}(?:\\?|$)`), (route) =>
    route.fulfill({ json: { session, messages: [{ id: 'text', role: 'assistant', parts: [{ type: 'text', text: '正文保留' }] }] } }),
  );
  await page.route(`**/api/sessions/${sessionId}/skill-operations`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { operations } });
  });
  await page.route(`**/api/sessions/${sessionId}/skill-captures`, (route) => route.fulfill({ json: { captures: [] } }));
  await page.goto('/#/chat');
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  return posts;
}

test('confirm collapses immediately and close does not cancel [AC:skill-operation-confirm-bar#AC-1] [AC:skill-operation-confirm-bar#AC-2]', async ({ page }) => {
  const sessionId = 'bar-slow';
  const reason = '详细理由'.repeat(30);
  const op = operation({ id: 'slow', name: 'test2-release', status: 'pending', reason, summary: 'x'.repeat(400) });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let confirmed = 0;
  let rejected = 0;
  await page.route(`**/api/sessions/${sessionId}/skill-operations/slow/confirm`, async (route) => {
    confirmed += 1;
    await gate;
    op.status = 'saved';
    await route.fulfill({ json: { operation: { ...op, status: 'saved' } } });
  });
  await page.route(`**/api/sessions/${sessionId}/skill-operations/slow/reject`, async (route) => {
    rejected += 1;
    await route.fulfill({ json: { operation: { ...op, status: 'rejected' } } });
  });
  await openChat(page, sessionId, 'Bar Slow', [op]);
  const card = page.getByTestId('skill-operation-slow');
  await expect(card.getByText(reason, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '确认并执行' }).click();
  await expect(card).toHaveClass(/skill-capture-card--bar/);
  await expect(card.getByRole('heading', { name: '沉淀 · test2-release' })).toBeVisible();
  await expect(card.getByRole('status')).toHaveText('执行中');
  await expect(card.getByText(reason, { exact: true })).not.toBeVisible();
  await expect(card.getByRole('button', { name: '确认并执行' })).toHaveCount(0);
  await expect.poll(() => confirmed).toBe(1);
  await card.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(card).toHaveCount(0);
  release();
  await expect(card).toHaveCount(0);
  expect(rejected).toBe(0);
  expect(confirmed).toBe(1);
});

test('pending suggestion still shows confirm and reject [AC:skill-operation-confirm-bar#AC-3]', async ({ page }) => {
  const sessionId = 'bar-reject';
  const op = operation({ id: 'ask', name: 'other-skill', status: 'pending', reason: '请先看这条建议', summary: '拟记录' });
  let rejected = 0;
  let confirmed = 0;
  await page.route(`**/api/sessions/${sessionId}/skill-operations/ask/reject`, async (route) => {
    rejected += 1;
    op.status = 'rejected';
    await route.fulfill({ json: { operation: { ...op, status: 'rejected' } } });
  });
  await page.route(`**/api/sessions/${sessionId}/skill-operations/ask/confirm`, async (route) => {
    confirmed += 1;
    await route.fulfill({ json: { operation: op } });
  });
  await openChat(page, sessionId, 'Bar Reject', [op]);
  const card = page.getByTestId('skill-operation-ask');
  await expect(card.getByText('请先看这条建议', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '确认并执行' })).toBeVisible();
  await expect(card.getByRole('button', { name: '拒绝' })).toBeVisible();
  await expect(card).not.toHaveClass(/skill-capture-card--bar/);
  await card.getByRole('button', { name: '拒绝' }).click();
  await expect(card.getByRole('status')).toHaveText('已拒绝');
  await expect(card.getByRole('button', { name: '确认并执行' })).toHaveCount(0);
  expect(rejected).toBe(1);
  expect(confirmed).toBe(0);
});

test('same skill operation stays one bar and a different suggestion stays open [AC:skill-operation-confirm-bar#AC-4]', async ({ page }) => {
  const sessionId = 'bar-dupe';
  const duplicateReason = '重复提案'.repeat(20);
  const operations = [
    operation({ id: 'done', name: 'test2-release', status: 'saved', reason: '已完成理由', summary: '已保存' }),
    operation({
      id: 'dup',
      name: 'test2-release',
      status: 'failed',
      error: 'Owned skill exists; use update with its exact ID',
      reason: duplicateReason,
      summary: 'y'.repeat(300),
    }),
    operation({ id: 'other', name: 'other-skill', status: 'pending', reason: '另一条建议', summary: '别的技能' }),
  ];
  await openChat(page, sessionId, 'Bar Dupe', operations);
  await expect(page.getByTestId('skill-operation-done')).toHaveCount(1);
  await expect(page.getByTestId('skill-operation-dup')).toHaveCount(0);
  const done = page.getByTestId('skill-operation-done');
  await expect(done).toHaveClass(/skill-capture-card--bar/);
  await expect(done.getByRole('heading', { name: '沉淀 · test2-release' })).toBeVisible();
  await expect(done.getByRole('status')).toHaveText('已完成');
  await expect(done.getByRole('button', { name: '确认并执行' })).toHaveCount(0);
  await expect(page.getByText(duplicateReason, { exact: true })).toHaveCount(0);
  const other = page.getByTestId('skill-operation-other');
  await expect(other.getByRole('button', { name: '确认并执行' })).toBeVisible();
  await expect(other.getByText('另一条建议', { exact: true })).toBeVisible();
  await done.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(done).toHaveCount(0);
  await expect(page.getByTestId('skill-operation-dup')).toHaveCount(0);
  await expect(other.getByRole('button', { name: '确认并执行' })).toBeVisible();
});

test('failed bar closes without turning the failure into success [AC:skill-operation-confirm-bar#AC-2] [AC:skill-operation-confirm-bar#AC-5]', async ({ page }) => {
  const sessionId = 'bar-fail';
  const op = operation({
    id: 'bad',
    name: 'test2-release',
    status: 'failed',
    error: '提炼失败',
    reason: '失败详情'.repeat(10),
    summary: '未保存',
  });
  const posts = await openChat(page, sessionId, 'Bar Fail', [op]);
  const card = page.getByTestId('skill-operation-bad');
  await expect(card).toHaveClass(/skill-capture-card--bar/);
  await expect(card.getByRole('heading', { name: '沉淀 · test2-release' })).toBeVisible();
  await expect(card.getByRole('status')).toHaveText('失败');
  const close = card.getByRole('button', { name: '关闭提示', exact: true });
  await expect(close).toHaveAttribute('aria-label', '关闭提示');
  await close.click();
  await expect(card).toHaveCount(0);
  expect(posts.filter((path) => path.includes('/confirm') || path.includes('/reject'))).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: /Bar Fail/ }).first().click();
  await expect(page.getByTestId('skill-operation-bad')).toHaveCount(0);
});
