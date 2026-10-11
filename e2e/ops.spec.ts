import { test, expect, type Page } from '@playwright/test';

const SESSIONS = [
  { id: 'sess_ops_alpha', title: 'Deploy review', mode: 'chat', status: 'idle', agentId: 'general', updatedAt: new Date().toISOString() },
  { id: 'sess_ops_beta', title: 'Weekly notes', mode: 'chat', status: 'idle', agentId: 'sre-oncall', updatedAt: new Date().toISOString() }
];

const TRACE = [
  { kind: 'turn_start', ts: '2026-09-07T10:00:00.000Z', payload: {} },
  { kind: 'tool_start', ts: '2026-09-07T10:00:01.000Z', payload: { name: 'bash' } },
  { kind: 'tool_end', ts: '2026-09-07T10:00:02.000Z', payload: { name: 'bash', ok: true } },
  { kind: 'turn_end', ts: '2026-09-07T10:00:04.000Z', payload: { usage: { totalTokens: 1200 } } },
  { kind: 'turn_start', ts: '2026-09-07T10:00:05.000Z', payload: {} },
  { kind: 'model_error', ts: '2026-09-07T10:00:06.000Z', payload: { message: 'upstream timeout' } },
  { kind: 'turn_end', ts: '2026-09-07T10:00:07.000Z', payload: {} }
];

async function mockSessionsAndTrace(page: Page, trace = TRACE) {
  await page.route(/\/api\/sessions(\?.*)?$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { sessions: SESSIONS } }) : route.continue()
  );
  await page.route(/\/api\/traces\?/, (route) => route.fulfill({ json: { sessionId: 'x', events: trace } }));
}

async function openTrace(page: Page) {
  await mockSessionsAndTrace(page);
  await page.goto('/#/ops/trajectory');
  await page.locator('#listSessions').getByText('Deploy review').click();
  await expect(page.getByTestId('trace-overview')).toBeVisible();
}

test.describe('Ops console', () => {
  test('health page shows an overall verdict and plain-language subsystem cards [AC:ops-console#AC-1]', async ({ page }) => {
    await page.goto('/#/ops/health');
    const overall = page.getByTestId('ops-overall');
    await expect(overall).toBeVisible();
    await expect(overall).toHaveAttribute('data-level', /^(ok|warn|fail)$/);
    await expect(overall).toContainText(/一切正常|需要关注|存在异常/);

    await expect(page.getByTestId('ops-card-service')).toContainText('后台服务');
    await expect(page.getByTestId('ops-card-service')).toContainText('运行正常');
    await expect(page.getByTestId('ops-card-selfheal')).toContainText(/空闲 · 没有进行中的修复|运行中 · \d+ 个修复任务/);
    await expect(page.getByTestId('ops-card-evolution')).toHaveCount(0);
    await expect(page.locator('a[href="/evolution"]')).toHaveCount(0);
  });

  test('one-click diagnostics lists failures and warnings first and folds passes [AC:ops-console#AC-2]', async ({ page }) => {
    const report = (checks: Array<Record<string, unknown>>) => ({
      ok: !checks.some((c) => c.severity === 'fail'),
      checkedAt: new Date().toISOString(),
      checks,
      summary: {
        ok: checks.filter((c) => c.severity === 'ok').length,
        warn: checks.filter((c) => c.severity === 'warn').length,
        fail: checks.filter((c) => c.severity === 'fail').length
      }
    });
    let attempt = 0;
    await page.route('**/api/doctor', (route) => {
      attempt += 1;
      return route.fulfill({
        json:
          attempt === 1
            ? report([
                { id: 'node', title: 'Node 版本', severity: 'ok', detail: 'v22' },
                { id: 'model', title: '模型配置', severity: 'warn', detail: '未配置 key', hint: '在设置里填写 API Key' },
                { id: 'sqlite', title: 'SQLite', severity: 'fail', detail: '无法写入' },
                { id: 'sandbox', title: '沙箱', severity: 'ok', detail: 'bwrap' }
              ])
            : report([
                { id: 'node', title: 'Node 版本', severity: 'ok', detail: 'v22' },
                { id: 'sandbox', title: '沙箱', severity: 'ok', detail: 'bwrap' }
              ])
      });
    });

    await page.goto('/#/ops/health');
    await expect(page.getByTestId('doctor-report')).toHaveCount(0);
    await page.getByRole('button', { name: '一键诊断' }).click();
    await expect(page.getByTestId('doctor-summary')).toContainText('2 项通过 · 1 项警告 · 1 项失败');

    const attention = page.getByTestId('doctor-attention').locator('li');
    await expect(attention).toHaveCount(2);
    await expect(attention.nth(0)).toContainText('SQLite');
    await expect(attention.nth(1)).toContainText('模型配置');
    await expect(attention.nth(1)).toContainText('在设置里填写 API Key');
    await expect(page.locator('.ops-doctor__passed')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('doctor-node')).toBeHidden();
    await expect(page.getByTestId('ops-overall')).toHaveAttribute('data-level', 'fail');

    await page.getByRole('button', { name: '重新诊断' }).click();
    await expect(page.getByTestId('doctor-report')).toContainText('一切正常');
    await expect(page.getByTestId('doctor-attention')).toHaveCount(0);
  });

  test('session list filters by keyword and explains an empty result [AC:ops-console#AC-3]', async ({ page }) => {
    await mockSessionsAndTrace(page);
    await page.goto('/#/ops/trajectory');
    const list = page.locator('#listSessions');
    await expect(list.getByText('Deploy review')).toBeVisible();
    await expect(list.getByText('Weekly notes')).toBeVisible();

    await page.getByPlaceholder('筛选标题 / Agent / ID').fill('oncall');
    await expect(list.getByText('Weekly notes')).toBeVisible();
    await expect(list.getByText('Deploy review')).toHaveCount(0);

    await page.getByPlaceholder('筛选标题 / Agent / ID').fill('no-such-session');
    await expect(list.getByText('没有匹配的会话')).toBeVisible();
    await list.getByRole('button', { name: '清空筛选' }).click();
    await expect(list.getByText('Deploy review')).toBeVisible();
  });

  test('trace opens on a summary: totals on top, one collapsed line per turn [AC:ops-console#AC-4]', async ({ page }) => {
    await openTrace(page);
    const overview = page.getByTestId('trace-overview');
    const stat = (label: string) =>
      overview.locator('.ops-stat').filter({ has: page.getByText(label, { exact: true }) });
    await expect(stat('轮次').locator('.ops-stat__value')).toHaveText('2');
    await expect(stat('出错轮次').locator('.ops-stat__value')).toHaveText('1');
    await expect(stat('工具调用').locator('.ops-stat__value')).toHaveText('1');
    await expect(stat('总耗时').locator('.ops-stat__value')).toHaveText('6s');

    const turns = page.getByTestId('trace-turn');
    await expect(turns).toHaveCount(2);
    await expect(turns.nth(0)).not.toHaveAttribute('open', '');
    await expect(turns.nth(0)).toContainText('2.00s');
    await expect(turns.nth(0)).toContainText('1 个工具');
    await expect(turns.nth(1)).toContainText('出错');
    await expect(turns.nth(1).getByTestId('trace-turn-error')).toContainText('upstream timeout');
    await expect(page.locator('.trace-payload').first()).toBeHidden();

    await turns.nth(0).locator('summary').first().click();
    await expect(turns.nth(0)).toHaveAttribute('open', '');
    const firstEvent = turns.nth(0).locator('details.trace-row').first();
    await expect(firstEvent.locator('.trace-payload')).toBeHidden();
    await firstEvent.locator('summary').click();
    await expect(firstEvent.locator('.trace-payload')).toBeVisible();
  });

  test('"errors only" keeps only failed turns and explains when there are none [AC:ops-console#AC-5]', async ({ page }) => {
    await openTrace(page);
    await expect(page.getByTestId('trace-turn')).toHaveCount(2);
    await page.getByLabel('只看出错').check();
    await expect(page.getByTestId('trace-turn')).toHaveCount(1);
    await expect(page.getByTestId('trace-turn')).toContainText('第 2 轮');
    await page.getByLabel('只看出错').uncheck();
    await expect(page.getByTestId('trace-turn')).toHaveCount(2);

    await page.unroute(/\/api\/traces\?/);
    await page.route(/\/api\/traces\?/, (route) =>
      route.fulfill({ json: { sessionId: 'x', events: TRACE.slice(0, 4) } })
    );
    await page.getByLabel('只看出错').check();
    await expect(page.locator('#traceTimeline')).toContainText('没有出错的轮次', { timeout: 8_000 });
  });

  test('event-type filter narrows events per turn [AC:ops-console#AC-6]', async ({ page }) => {
    await openTrace(page);
    await page.getByPlaceholder('按事件类型筛选，如 tool').fill('tool');
    const turns = page.getByTestId('trace-turn');
    await expect(turns).toHaveCount(1);
    await expect(turns.first()).toContainText('2 个事件');
    await page.getByRole('button', { name: '展开全部' }).click();
    await expect(turns.first().locator('details.trace-row')).toHaveCount(2);

    await page.getByPlaceholder('按事件类型筛选，如 tool').fill('zzz-nothing');
    await expect(page.locator('#traceTimeline')).toContainText('没有匹配的事件');
  });

  test('effective config shows a summary and only attention items until expanded [AC:ops-console#AC-7]', async ({ page }) => {
    await page.route('**/api/config/effective', (route) =>
      route.fulfill({
        json: {
          generatedAt: new Date().toISOString(),
          mode: 'hybrid',
          summary: { externalServices: ['storage.sessionStore'], autoEnabled: [], partial: [] },
          items: [
            {
              id: 'storage.sessionStore', group: 'storage', enabled: true, mode: 'postgres', source: 'explicit-env',
              reasonCode: 'database_url_set', reason: 'DATABASE_URL set', warnings: [{ code: 'pg_unreachable', message: 'pg down' }], hints: []
            },
            {
              id: 'storage.eventBuffer', group: 'storage', enabled: true, mode: 'memory', source: 'local-fallback',
              reasonCode: 'sqlite_only', reason: 'sqlite only', warnings: [], hints: []
            },
            {
              id: 'capability.webSearch', group: 'capability', enabled: false, mode: 'off', source: 'local-fallback',
              reasonCode: 'not_configured', reason: 'not configured', warnings: [], hints: []
            }
          ]
        }
      })
    );
    await page.goto('/#/ops/health');
    const card = page.locator('#card-effective-config');
    await expect(card.getByTestId('effective-mode')).toHaveText('混合模式');
    await expect(card.getByTestId('effective-summary')).toBeVisible();
    await expect(card.getByTestId('effective-storage.sessionStore')).toBeVisible();
    await expect(card.getByTestId('effective-storage.eventBuffer')).toHaveCount(0);
    await expect(card.getByTestId('effective-capability.webSearch')).toHaveCount(0);

    await card.getByRole('button', { name: '显示全部 3 项' }).click();
    await expect(card.getByTestId('effective-storage.eventBuffer')).toBeVisible();
    await expect(card.getByTestId('effective-capability.webSearch')).toBeVisible();
    await card.getByRole('button', { name: '收起' }).click();
    await expect(card.getByTestId('effective-capability.webSearch')).toHaveCount(0);
  });

  test('direct Evolution URL shows a short hidden note in the active language [AC:ops-console#AC-8]', async ({ page }) => {
    await page.goto('/evolution');
    const hidden = page.getByTestId('evolution-hidden');
    await expect(hidden).toBeVisible();
    await expect(hidden.getByRole('heading')).toHaveText('Evolution 已隐藏');
    await expect(hidden).toContainText('不会自动运行');
    await expect(page.getByText('进行中的 Worktree')).toHaveCount(0);
    await expect(page.getByText('历史结果')).toHaveCount(0);

    await page.evaluate(() => window.localStorage.setItem('lab.locale', 'en'));
    await page.reload();
    await expect(hidden.getByRole('heading')).toHaveText('Evolution is hidden');
    await expect(hidden).toContainText('will not run on its own');
    await expect(page.getByText('Active worktrees')).toHaveCount(0);
    await expect(page.getByText('History')).toHaveCount(0);
  });

  test('top bar and health page do not show Evolution even when a run looks active [AC:ops-console#AC-9]', async ({ page }) => {
    await page.route('**/api/evolution/overview', (route) =>
      route.fulfill({
        json: {
          activeWorktrees: [{ path: '/tmp/.evolution-worktrees/exp', branch: 'exp/evolution-demo', head: 'abc', isEvolution: true }],
          counts: { success: 1, failure: 0, skip: 0 },
          latestRunLog: 'running',
          inboxHint: 'today.md'
        }
      })
    );
    await page.goto('/#/ops/health');
    await expect(page.getByTestId('ops-card-service')).toBeVisible();
    await expect(page.getByTestId('evolution-status-chip')).toHaveCount(0);
    await expect(page.getByText(/Evolution 运行中/)).toHaveCount(0);
    await expect(page.getByTestId('ops-card-evolution')).toHaveCount(0);
    await expect(page.locator('a[href="/evolution"]')).toHaveCount(0);
  });
});
