import { test, expect, type Page } from '@playwright/test';

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mockOverview(page: Page, overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    tasks: { tasks: [] },
    'social-post-schedules': { items: [] },
    approvals: { approvals: [] },
    'background-jobs': { jobs: [] },
    'orchestration/runs': { runs: [] },
    ...overrides
  };
  for (const [path, body] of Object.entries(data)) {
    await page.route(new RegExp(`/api/${path}(\\?.*)?$`), (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill(json(typeof body === 'function' ? (body as () => unknown)() : body));
    });
  }
}

const TASKS = [
  { title: 'Write report', status: 'pending', ownerAgentId: 'researcher' },
  { title: 'Fix login bug', status: 'in_progress', ownerAgentId: 'coder' },
  { title: 'Deploy site', status: 'failed', ownerAgentId: 'coder' },
  { title: 'Deploy docs', status: 'failed', ownerAgentId: 'ops' },
  { title: 'Summarize docs', status: 'completed' }
];

test.describe('Tasks section', () => {
  test('queue filters by status and shows counts [AC:console-tasks#AC-1]', async ({ page }) => {
    await mockOverview(page, { tasks: { tasks: TASKS } });
    await page.goto('/#/tasks/queue');
    const filters = page.locator('#taskStatusFilter');
    await expect(filters.getByTestId('status-filter-all')).toContainText('5');
    await expect(filters.getByTestId('status-filter-failed')).toContainText('2');
    await expect(page.locator('#listTasks .list-item')).toHaveCount(5);

    await filters.getByTestId('status-filter-failed').click();
    await expect(page.locator('#listTasks .list-item')).toHaveCount(2);
    await expect(page.locator('#listTasks')).toContainText('Deploy site');
    await expect(page.locator('#listTasks')).not.toContainText('Write report');

    await filters.getByTestId('status-filter-all').click();
    await expect(page.locator('#listTasks .list-item')).toHaveCount(5);
  });

  test('queue search narrows and shows a no-match state [AC:console-tasks#AC-2]', async ({ page }) => {
    await mockOverview(page, { tasks: { tasks: TASKS } });
    await page.goto('/#/tasks/queue');
    await page.locator('#taskSearch').fill('coder');
    await expect(page.locator('#listTasks .list-item')).toHaveCount(2);

    await page.locator('#taskSearch').fill('zzz-nothing');
    await expect(page.locator('#section-tasks-queue').getByText('没有匹配的任务')).toBeVisible();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page.locator('#listTasks .list-item')).toHaveCount(5);
  });

  test('queue empty states explain what appears [AC:console-tasks#AC-3]', async ({ page }) => {
    await mockOverview(page);
    await page.goto('/#/tasks/queue');
    const queue = page.locator('#section-tasks-queue');
    await expect(queue.getByText('还没有任务')).toBeVisible();
    await expect(queue.getByText('没有定时发布')).toBeVisible();
    await expect(queue.getByText('没有后台任务')).toBeVisible();
  });

  test('inbox lists approvals with details and clears them after approving [AC:console-tasks#AC-4]', async ({ page }) => {
    let approvals = [{ id: 'apr-1', toolName: 'bash', sessionId: 'sess-abc', status: 'pending', reason: 'needs shell access', args: {}, createdAt: '2026-01-01T00:00:00Z' }];
    await mockOverview(page, { approvals: () => ({ approvals }) });
    await page.route('**/api/approvals/apr-1/approve', (route) => {
      approvals = [];
      return route.fulfill(json({ ok: true }));
    });
    await page.goto('/#/tasks/inbox');
    const list = page.locator('#listApprovals');
    await expect(list).toContainText('bash');
    await expect(list).toContainText('needs shell access');
    await expect(list).toContainText('sess-abc');
    await expect(page.getByRole('tab', { name: /审批与收件箱/ })).toContainText('1');

    await list.getByRole('button', { name: /批准/ }).click();
    await expect(list.locator('.list-item')).toHaveCount(0);
  });

  test('inbox hides already-resolved approvals and does not count them [AC:console-tasks#AC-4]', async ({ page }) => {
    const base = { toolName: 'ask_user', sessionId: 'sess-abc', reason: 'r', args: {}, createdAt: '2026-01-01T00:00:00Z' };
    await mockOverview(page, {
      approvals: {
        approvals: [
          { ...base, id: 'apr-rejected', status: 'rejected' },
          { ...base, id: 'apr-approved', status: 'approved' },
          { ...base, id: 'apr-expired', status: 'expired' }
        ]
      }
    });
    await page.goto('/#/tasks/inbox');
    await expect(page.locator('#section-tasks-inbox').getByText('没有待处理的审批')).toBeVisible();
    await expect(page.locator('#listApprovals')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /审批与收件箱/ })).not.toContainText('3');
    await expect(page.getByRole('tab', { name: /审批与收件箱/ })).not.toContainText('1');
  });

  test('inbox shows an empty state without approvals [AC:console-tasks#AC-5]', async ({ page }) => {
    await mockOverview(page);
    await page.goto('/#/tasks/inbox');
    await expect(page.locator('#section-tasks-inbox').getByText('没有待处理的审批')).toBeVisible();
  });

  test('runs filter by status and show an empty state [AC:console-tasks#AC-6]', async ({ page }) => {
    await mockOverview(page, {
      'orchestration/runs': {
        runs: [
          { id: 'run-1', title: 'Refactor auth', status: 'running', riskLevel: 'low' },
          { id: 'run-2', title: 'Migrate db', status: 'blocked', riskLevel: 'high' },
          { id: 'run-3', title: 'Update docs', status: 'completed', riskLevel: 'low' }
        ]
      }
    });
    await page.goto('/#/tasks/runs');
    const filters = page.locator('#runStatusFilter');
    await expect(filters.getByTestId('status-filter-all')).toContainText('3');
    await filters.getByTestId('status-filter-blocked').click();
    const rows = page.locator('#listOrchestrationRuns .list-item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Migrate db');
    await expect(rows.first()).toContainText('high');
  });

  test('runs empty state explains how runs appear [AC:console-tasks#AC-6]', async ({ page }) => {
    await mockOverview(page);
    await page.goto('/#/tasks/runs');
    await expect(page.locator('#section-tasks-runs').getByText('还没有编排运行')).toBeVisible();
  });
});

test.describe('Knowledge section', () => {
  const prefix = `e2e-${Date.now()}`;

  test('memory page explains each scope and switches between them [AC:console-knowledge#AC-1]', async ({ page }) => {
    await page.goto('/#/knowledge/memory');
    const scopes = page.locator('[data-testid^="memory-scope-"]');
    await expect(scopes).toHaveCount(5);
    for (const text of ['会话草稿', '会话长期', '用户记忆', '团队记忆', '项目记忆']) {
      await expect(page.locator('#memoryScopes')).toContainText(text);
    }
    await page.getByTestId('memory-scope-team.memory').click();
    await expect(page.getByTestId('memory-scope-team.memory')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('memory-scope-user.memory')).toHaveAttribute('aria-pressed', 'false');
  });

  test('memory can be added, searched, edited and deleted [AC:console-knowledge#AC-2] [AC:console-knowledge#AC-3] [AC:console-knowledge#AC-4]', async ({ page }) => {
    await page.goto('/#/knowledge/memory');
    await page.getByTestId('memory-scope-project.memory').click();

    const add = page.locator('#btnMemoryAdd');
    await expect(add).toBeDisabled();
    for (const [k, v] of [[`${prefix}-alpha`, 'Prefers dark mode'], [`${prefix}-beta`, 'Deploys on Fridays']]) {
      await page.locator('#memoryKey').fill(k);
      await page.locator('#memoryValue').fill(v);
      await add.click();
      await expect(page.locator('#listMemory')).toContainText(k);
      await expect(page.locator('#memoryKey')).toHaveValue('');
    }

    await page.locator('#memorySearch').fill(`${prefix}-alpha`);
    await expect(page.locator('#listMemory .list-item')).toHaveCount(1);
    await page.locator('#memorySearch').fill('Fridays');
    await expect(page.locator('#listMemory .list-item')).toHaveCount(1);
    await expect(page.locator('#listMemory')).toContainText(`${prefix}-beta`);
    await page.locator('#memorySearch').fill('zzz-no-such-memory');
    await expect(page.locator('#section-knowledge-memory').getByText('没有匹配的记忆')).toBeVisible();
    await page.getByRole('button', { name: '清除搜索' }).click();

    await page.locator('#memorySearch').fill(prefix);
    const item = page.locator('#listMemory .list-item', { hasText: `${prefix}-alpha` });
    await item.getByRole('button', { name: '编辑' }).click();
    await page.locator('#memoryEditValue').fill('Prefers light mode');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('#listMemory')).toContainText('Prefers light mode');

    for (const suffix of ['alpha', 'beta']) {
      const row = page.locator('#listMemory .list-item', { hasText: `${prefix}-${suffix}` });
      await row.getByRole('button', { name: '删除' }).click();
      await row.getByRole('button', { name: '确认删除' }).click();
      await expect(page.locator('#listMemory .list-item', { hasText: `${prefix}-${suffix}` })).toHaveCount(0);
    }
  });

  test('empty scope shows an explanatory empty state [AC:console-knowledge#AC-5]', async ({ page }) => {
    await page.route(/\/api\/memory(\?.*)?$/, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill(json({ entries: [] }));
    });
    await page.goto('/#/knowledge/memory');
    await page.getByTestId('memory-scope-user.memory').click();
    await expect(page.locator('#section-knowledge-memory').getByText('这个范围还没有记忆')).toBeVisible();
  });

  test('memory behavior settings hide advanced items by default [AC:console-knowledge#AC-6]', async ({ page }) => {
    await page.goto('/#/knowledge/memory');
    await expect(page.locator('#memoryDialogueExtract')).toBeVisible();
    await expect(page.locator('#memoryDreamer')).toHaveCount(0);
    await expect(page.locator('#memoryPreviewQuery')).toHaveCount(0);
    await page.getByTestId('advanced-toggle').check();
    await expect(page.locator('#memoryDreamer')).toBeVisible();
    await expect(page.locator('#memoryPreviewQuery')).toBeVisible();
  });

  test('ingestion shows only the common switches until advanced is on [AC:console-knowledge#AC-7]', async ({ page }) => {
    await page.goto('/#/knowledge/ingestion');
    const root = page.locator('#section-knowledge-ingestion');
    await expect(root.getByRole('heading', { name: '附件与浏览器' })).toBeVisible();
    await expect(root.locator('#ingestionEnabled')).toBeVisible();
    await expect(root.locator('#ingestionBrowser')).toBeVisible();
    await expect(root.locator('#ingestionGbk')).toHaveCount(0);
    await expect(root.locator('#web-search-url')).toHaveCount(0);
    await page.getByTestId('advanced-toggle').check();
    await expect(root.locator('#ingestionGbk')).toBeVisible();
    await expect(root.locator('#web-search-url')).toBeVisible();
  });
});
