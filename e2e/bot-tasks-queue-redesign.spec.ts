import { test, expect, type Page } from '@playwright/test';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function mockQueueOverview(page: Page, overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    bots: { bots: [] },
    tasks: { tasks: [] },
    'social-post-schedules': { items: [] },
    approvals: { approvals: [] },
    'background-jobs': { jobs: [] },
    'orchestration/runs': { runs: [] },
    ...overrides,
  };
  for (const [path, body] of Object.entries(data)) {
    await page.route(new RegExp(`/api/${path}(\\?.*)?$`), (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill(json(typeof body === 'function' ? (body as () => unknown)() : body));
    });
  }
}

test.describe('Task Queue master-detail redesign (#/tasks/queue)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  });

  test('renders side-by-side master-detail split, priority bands, scope tabs, filters, and empty states [AC:bot-tasks-queue-redesign#AC-5]', async ({
    page,
  }) => {
    const now = new Date().toISOString();
    await mockQueueOverview(page, {
      tasks: {
        tasks: [
          { id: 'task-done', title: 'Archived report', status: 'completed', ownerAgentId: 'ops', updatedAt: now },
          { id: 'task-pending', title: 'Draft changelog', status: 'pending', ownerAgentId: 'writer', updatedAt: now },
          { id: 'task-active', title: 'Run release checks', status: 'in_progress', ownerAgentId: 'coder', updatedAt: now },
          { id: 'task-failed', title: 'Deploy production', status: 'failed', ownerAgentId: 'coder', updatedAt: now },
        ],
      },
      'social-post-schedules': { items: [] },
      'background-jobs': { jobs: [] },
    });

    await page.goto('/#/tasks/queue');

    const listPane = page.getByTestId('task-queue-list-pane');
    const detailPane = page.getByTestId('task-queue-detail-pane');
    await expect(listPane).toBeVisible();
    await expect(detailPane).toBeVisible();

    const listBox = await listPane.boundingBox();
    const detailBox = await detailPane.boundingBox();
    expect(listBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    expect(listBox!.x).toBeLessThan(detailBox!.x);
    expect(listBox!.y).toBeLessThan(260);
    expect(detailBox!.y).toBeLessThan(260);

    // Priority bands render in order: attention (failed) -> active (in_progress) -> pending -> done (completed)
    const attentionBox = await page.getByTestId('queue-band-attention').boundingBox();
    const activeBox = await page.getByTestId('queue-band-active').boundingBox();
    const pendingBox = await page.getByTestId('queue-band-pending').boundingBox();
    const doneBox = await page.getByTestId('queue-band-done').boundingBox();
    expect(attentionBox!.y).toBeLessThan(activeBox!.y);
    expect(activeBox!.y).toBeLessThan(pendingBox!.y);
    expect(pendingBox!.y).toBeLessThan(doneBox!.y);

    // Status filter bar & search + no-match reset remain intact
    const filters = page.locator('#taskStatusFilter');
    await expect(filters.getByTestId('status-filter-all')).toContainText('4');
    await expect(filters.getByTestId('status-filter-failed')).toContainText('1');
    await filters.getByTestId('status-filter-failed').click();
    await expect(page.locator('#listTasks .list-item')).toHaveCount(1);
    await expect(page.locator('#listTasks')).toContainText('Deploy production');

    await page.locator('#taskSearch').fill('no-such-task');
    await expect(listPane.getByText('没有匹配的任务')).toBeVisible();
    await listPane.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(page.locator('#listTasks .list-item')).toHaveCount(4);

    // Scope switching surfaces schedules & jobs empty states cleanly
    await page.getByTestId('queue-scope-schedules').click();
    await expect(listPane.getByText('没有定时发布')).toBeVisible();
    await page.getByTestId('queue-scope-jobs').click();
    await expect(listPane.getByText('没有后台任务')).toBeVisible();
  });

  test('resolves opaque Bot IDs to display names and distills verbose shell job commands [AC:bot-tasks-queue-redesign#AC-6]', async ({
    page,
  }) => {
    const botId = 'bot_78bcb2c239c14f50a31f959e6eea8cff';
    const rawCommand =
      'cd /Users/penglei/developer/self-test-grounding/ppeng-agent-core && grok --prompt-file /tmp/prompts/release-check.md --model fast > /tmp/grok.log 2>&1';
    const now = new Date().toISOString();

    await mockQueueOverview(page, {
      bots: {
        bots: [
          {
            id: botId,
            name: '发布管家',
            title: 'Release Bot',
            description: '',
            agentId: 'general',
            canonicalSessionId: 'sess-release-bot',
            hidden: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      tasks: {
        tasks: [
          {
            id: 'task-bot-owned',
            title: '检查版本发布状态',
            description: '汇总 CI 结果与风险',
            status: 'in_progress',
            ownerAgentId: botId,
            sessionId: 'sess-release-bot',
            updatedAt: now,
          },
        ],
      },
      'background-jobs': {
        jobs: [
          {
            id: 'job-grok-1',
            sessionId: 'sess-release-bot',
            command: rawCommand,
            status: 'completed',
            result: 'All 42 checks passed without warnings.',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });
    await page.route('**/api/tasks/task-bot-owned', (route) =>
      route.fulfill(
        json({
          task: {
            id: 'task-bot-owned',
            title: '检查版本发布状态',
            description: '汇总 CI 结果与风险',
            status: 'in_progress',
            ownerAgentId: botId,
            sessionId: 'sess-release-bot',
            updatedAt: now,
          },
          events: [],
        })
      )
    );

    await page.goto('/#/tasks/queue');

    // Task row shows readable Bot name rather than opaque bot_<hash>, and search matches resolved name
    const taskRow = page.locator('#listTasks .list-item').first();
    await expect(taskRow).toContainText('发布管家');
    await expect(taskRow).not.toContainText(botId);

    await page.locator('#taskSearch').fill('发布管家');
    await expect(page.locator('#listTasks .list-item')).toHaveCount(1);
    await page.locator('#taskSearch').fill('');

    // Background job row shows distilled concise command title, while detail pane shows full command & output
    await page.getByTestId('queue-scope-jobs').click();
    const jobRow = page.locator('#listJobs .list-item').first();
    await expect(jobRow).toContainText('grok --prompt-file …/release-check.md --model fast');
    await expect(jobRow).not.toContainText('2>&1');

    await jobRow.click();
    const detailPane = page.getByTestId('task-queue-detail-pane');
    await expect(detailPane).toContainText(rawCommand);
    await expect(detailPane).toContainText('All 42 checks passed without warnings.');
  });

  test('loads task detail dependencies and folded timeline events, steps items, and runs schedule actions [AC:bot-tasks-queue-redesign#AC-7]', async ({
    page,
  }) => {
    const now = Date.now();
    const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    const postedActions: Array<{ url: string; action: string }> = [];

    await mockQueueOverview(page, {
      tasks: {
        tasks: [
          {
            id: 'task-detail-1',
            title: '排查构建失败原因',
            description: '定位单测回归并补齐验证。',
            status: 'failed',
            ownerAgentId: 'coder',
            sessionId: 'sess-task-1',
            blockedBy: ['task-dep-a', 'task-dep-b'],
            createdAt: iso(40),
            updatedAt: iso(2),
          },
          {
            id: 'task-detail-2',
            title: '补充文档变更说明',
            description: '同步更新 CHANGELOG。',
            status: 'pending',
            ownerAgentId: 'writer',
            sessionId: 'sess-task-2',
            createdAt: iso(20),
            updatedAt: iso(5),
          },
        ],
      },
      'social-post-schedules': {
        items: [
          {
            taskId: 'sched-1',
            title: '发布新版本公告',
            status: 'pending',
            sessionId: 'sess-sched-1',
            publishAt: '2026-11-26T09:00:00Z',
            channels: ['feishu', 'x'],
            approval: 'pending',
            dispatchState: 'queued',
            idempotencyKey: 'idem-sched-1',
          },
        ],
      },
    });

    await page.route('**/api/tasks/task-detail-1', (route) =>
      route.fulfill(
        json({
          task: {
            id: 'task-detail-1',
            title: '排查构建失败原因',
            description: '定位单测回归并补齐验证。',
            status: 'failed',
            ownerAgentId: 'coder',
            sessionId: 'sess-task-1',
            blockedBy: ['task-dep-a', 'task-dep-b'],
            createdAt: iso(40),
            updatedAt: iso(2),
          },
          events: [
            { id: 'ev-1', taskId: 'task-detail-1', kind: 'task.created', actor: 'system', payload: {}, createdAt: iso(40) },
            { id: 'ev-2', taskId: 'task-detail-1', kind: 'task.started', actor: 'coder', payload: {}, createdAt: iso(35) },
            { id: 'ev-3', taskId: 'task-detail-1', kind: 'task.updated', actor: 'coder', payload: { reason: 'Retry 1' }, createdAt: iso(25) },
            { id: 'ev-4', taskId: 'task-detail-1', kind: 'task.updated', actor: 'coder', payload: { reason: 'Retry 2' }, createdAt: iso(15) },
            { id: 'ev-5', taskId: 'task-detail-1', kind: 'task.updated', actor: 'coder', payload: { reason: 'Retry 3' }, createdAt: iso(8) },
            { id: 'ev-6', taskId: 'task-detail-1', kind: 'task.failed', actor: 'coder', payload: { reason: 'Exit code 1' }, createdAt: iso(2) },
          ],
        })
      )
    );
    await page.route('**/api/tasks/task-detail-2', (route) =>
      route.fulfill(
        json({
          task: {
            id: 'task-detail-2',
            title: '补充文档变更说明',
            description: '同步更新 CHANGELOG。',
            status: 'pending',
            ownerAgentId: 'writer',
            sessionId: 'sess-task-2',
            createdAt: iso(20),
            updatedAt: iso(5),
          },
          events: [],
        })
      )
    );
    await page.route('**/api/social-post-schedules/sched-1/action', (route) => {
      const body = route.request().postDataJSON() as { action: string };
      postedActions.push({ url: route.request().url(), action: body.action });
      return route.fulfill(json({ task: { id: 'sched-1', status: 'in_progress' } }));
    });

    await page.goto('/#/tasks/queue');

    // First priority item (failed task) is auto-selected in detail pane with description, blockedBy, and folded timeline
    const detailPane = page.getByTestId('task-queue-detail-pane');
    await expect(detailPane).toContainText('排查构建失败原因');
    await expect(detailPane).toContainText('定位单测回归并补齐验证。');
    await expect(detailPane).toContainText('task-dep-a');
    await expect(detailPane).toContainText('task-dep-b');
    await expect(detailPane.getByTestId('queue-event-latest')).toContainText('Exit code 1');
    await expect(detailPane.getByTestId('queue-event-folded')).toHaveCount(3);

    // Expanding hidden middle timeline events reveals all earlier folded rows
    await detailPane.getByRole('button', { name: /展开其余 2 条记录/ }).click();
    await expect(detailPane.getByTestId('queue-event-folded')).toHaveCount(5);
    await expect(detailPane.getByRole('button', { name: '查看会话', exact: true })).toBeVisible();

    // Stepping to next item updates detail pane cleanly
    await detailPane.getByRole('button', { name: '下一项', exact: true }).click();
    await expect(detailPane).toContainText('补充文档变更说明');
    await expect(detailPane).toContainText('同步更新 CHANGELOG。');

    // Selecting scheduled post displays channels, schedule metadata, and dispatches approve action
    await page.locator('#listSchedules .list-item').first().click();
    await expect(detailPane).toContainText('发布新版本公告');
    await expect(detailPane).toContainText('feishu');
    await expect(detailPane).toContainText('2026-11-26T09:00:00Z');
    await expect(detailPane.getByTestId('schedule-action-approve')).toBeVisible();
    await expect(detailPane.getByTestId('schedule-action-reject')).toBeVisible();
    await expect(detailPane.getByTestId('schedule-action-run_now')).toBeVisible();
    await expect(detailPane.getByTestId('schedule-action-cancel')).toBeVisible();

    await detailPane.getByTestId('schedule-action-approve').click();
    await expect.poll(() => postedActions.map((entry) => entry.action)).toEqual(['approve']);
    await expect(detailPane).toContainText('操作已完成');
  });
});

test.describe('Bot Tasks master-detail redesign (#/tasks/bots)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
  });

  test('renders viewport-locked master-detail split with compact quick-dispatch bar above the fold [AC:bot-tasks-queue-redesign#AC-1]', async ({
    page,
  }) => {
    const now = new Date().toISOString();
    const task = {
      id: 'bt-layout-1',
      targetBotId: 'bot-alpha',
      input: '整理本周发布回归结果',
      status: 'completed',
      result: '全部核心用例通过。',
      updatedAt: now,
    };

    await page.route('**/api/bots', (route) =>
      route.fulfill(json({ bots: [{ id: 'bot-alpha', name: '研发助手', agentId: 'general' }] }))
    );
    await page.route('**/api/bot-work/status', (route) => route.fulfill(json({ bots: [] })));
    await page.route('**/api/bot-work/tasks?*', (route) =>
      route.fulfill(json({ tasks: [task], activeTasks: [], historyTasks: [task], collaborations: [] }))
    );
    await page.route('**/api/bot-work/tasks/bt-layout-1', (route) => route.fulfill(json({ task })));

    await page.goto('/#/tasks/bots');
    const panel = page.getByTestId('bot-team-work');
    await expect(panel).toBeVisible();

    const composer = panel.locator('form').first();
    const firstRow = panel.locator('article').first();
    const detailAside = panel.locator('aside');

    await expect(composer).toBeVisible();
    await expect(firstRow).toBeVisible();
    await expect(detailAside).toBeVisible();

    const composerBox = await composer.boundingBox();
    const rowBox = await firstRow.boundingBox();
    const asideBox = await detailAside.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(asideBox).not.toBeNull();

    // Compact quick-dispatch bar (< 120px tall, well above fold)
    expect(composerBox!.height).toBeLessThan(120);
    expect(composerBox!.y).toBeLessThan(260);
    // Side-by-side master-detail panes both visible above the fold
    expect(rowBox!.x).toBeLessThan(asideBox!.x);
    expect(rowBox!.y).toBeLessThan(460);
    expect(asideBox!.y).toBeLessThan(360);
  });

  test('sanitizes goal continuation and JSON-schema prompts into clean titles and folds raw prompt in detail pane [AC:bot-tasks-queue-redesign#AC-2]', async ({
    page,
  }) => {
    const now = new Date().toISOString();
    const rawGoalPrompt =
      'Continue goal goal_827c0bc9 under revision 1. Objective: 核对本周发布清单并输出摘要 Constraints: [] Previous progress: done Evidence: ["session_6dbf bash ok=true"]';
    const rawSchemaPrompt =
      'Message from Super Bot / bot_1: [OPC OS] OPC OS阶段工单：你是 OPC OS 代理拍板审查 Bot，负责审核阶段产出。严格只返回单个 JSON 对象：{"decision": "approve"}';
    const tasks = [
      {
        id: 'bt-clean-1',
        targetBotId: 'bot-alpha',
        input: rawGoalPrompt,
        status: 'failed',
        failureReason: '缺少灰度确认记录',
        updatedAt: now,
      },
      {
        id: 'bt-clean-2',
        targetBotId: 'bot-alpha',
        input: rawSchemaPrompt,
        status: 'completed',
        result: '已审查通过',
        updatedAt: now,
      },
    ];

    await page.route('**/api/bots', (route) =>
      route.fulfill(json({ bots: [{ id: 'bot-alpha', name: '研发助手', agentId: 'general' }] }))
    );
    await page.route('**/api/bot-work/status', (route) => route.fulfill(json({ bots: [] })));
    await page.route('**/api/bot-work/tasks?*', (route) =>
      route.fulfill(json({ tasks, activeTasks: [], historyTasks: tasks, collaborations: [] }))
    );
    for (const task of tasks) {
      await page.route(`**/api/bot-work/tasks/${task.id}`, (route) => route.fulfill(json({ task })));
    }

    await page.goto('/#/tasks/bots');
    const panel = page.getByTestId('bot-team-work');
    const titles = panel.locator('article > p');

    await expect(titles.nth(0)).toHaveText('核对本周发布清单并输出摘要');
    await expect(titles.nth(1)).toHaveText('你是 OPC OS 代理拍板审查 Bot，负责审核阶段产出');

    // Detail pane folds raw task prompt by default and expands on click
    const detailAside = panel.locator('aside');
    const rawPromptDetails = detailAside.locator('details').filter({ hasText: '原始任务指令' });
    await expect(rawPromptDetails).toBeVisible();
    await expect(rawPromptDetails).not.toHaveAttribute('open', '');
    await rawPromptDetails.locator('summary').click();
    await expect(rawPromptDetails).toHaveAttribute('open', '');
    await expect(rawPromptDetails.locator('pre')).toContainText('Continue goal goal_827c0bc9');
  });

  test('groups by priority band, supports search and faceted Bot/time filtering, and preserves quick dispatch [AC:bot-tasks-queue-redesign#AC-3]', async ({
    page,
  }) => {
    const now = Date.now();
    const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    let dispatched = false;

    const baseTasks = [
      { id: 'bt-hist', targetBotId: 'bot-beta', input: '十天前的历史巡检', status: 'completed', updatedAt: iso(240) },
      { id: 'bt-run', targetBotId: 'bot-alpha', input: '执行构建验证', status: 'running', updatedAt: iso(2) },
      { id: 'bt-fail', targetBotId: 'bot-alpha', input: '修复告警通道', status: 'failed', failureReason: 'Webhook 超时', updatedAt: iso(1) },
    ];
    const extraTask = { id: 'bt-new', targetBotId: 'bot-beta', input: '新的巡检任务', status: 'queued', updatedAt: iso(0) };

    await page.route('**/api/bots', (route) =>
      route.fulfill(
        json({
          bots: [
            { id: 'bot-alpha', name: '研发助手', agentId: 'general' },
            { id: 'bot-beta', name: '运维专员', agentId: 'general' },
          ],
        })
      )
    );
    await page.route('**/api/bot-work/status', (route) => route.fulfill(json({ bots: [] })));
    await page.route('**/api/bot-work/tasks?*', (route) => {
      const list = dispatched ? [extraTask, ...baseTasks] : baseTasks;
      return route.fulfill(json({ tasks: list, activeTasks: list.filter((t) => t.status === 'running' || t.status === 'queued'), historyTasks: list.filter((t) => t.status === 'completed' || t.status === 'failed'), collaborations: [] }));
    });
    for (const task of [...baseTasks, extraTask]) {
      await page.route(`**/api/bot-work/tasks/${task.id}`, (route) => route.fulfill(json({ task })));
    }
    await page.route('**/api/bot-work/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      dispatched = true;
      return route.fulfill(json({ task: extraTask }));
    });

    await page.goto('/#/tasks/bots');
    const panel = page.getByTestId('bot-team-work');

    // Priority bands rendered in order: 需关注 -> 进行中 -> 历史记录
    const attentionBtn = panel.getByRole('button', { name: /需关注/ });
    const activeBtn = panel.getByRole('button', { name: /进行中/ });
    const historyBtn = panel.getByRole('button', { name: /历史记录/ });
    await expect(attentionBtn).toBeVisible();
    await expect(activeBtn).toBeVisible();
    await expect(historyBtn).toBeVisible();
    const attentionBox = await attentionBtn.boundingBox();
    const activeBox = await activeBtn.boundingBox();
    const historyBox = await historyBtn.boundingBox();
    expect(attentionBox!.y).toBeLessThan(activeBox!.y);
    expect(activeBox!.y).toBeLessThan(historyBox!.y);

    // Keyword search narrows list
    const searchInput = panel.getByPlaceholder('搜索任务内容、Bot 或编号');
    await searchInput.fill('告警');
    await expect(panel.locator('article')).toHaveCount(1);
    await expect(panel.locator('article').first()).toContainText('修复告警通道');
    await searchInput.fill('');
    await expect(panel.locator('article')).toHaveCount(3);

    // Faceted Filter popover: filter by Bot & time range, then clear
    await panel.getByRole('button', { name: /^筛选/ }).click();
    const filterRegion = panel.getByRole('region', { name: '筛选' });
    await expect(filterRegion).toBeVisible();
    await filterRegion.getByRole('button', { name: /运维专员/ }).click();
    await expect(panel.locator('article')).toHaveCount(1);
    await expect(panel.locator('article').first()).toContainText('十天前的历史巡检');

    await filterRegion.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(panel.locator('article')).toHaveCount(3);

    await filterRegion.getByRole('button', { name: /今天/ }).click();
    await expect(panel.locator('article')).toHaveCount(2);
    await filterRegion.getByRole('button', { name: '清除筛选', exact: true }).click();
    await filterRegion.getByRole('button', { name: '关闭详情', exact: true }).click();

    // Quick dispatch still works cleanly
    await panel.getByLabel('执行 Bot', { exact: true }).selectOption('bot-beta');
    await panel.getByLabel('工作内容', { exact: true }).fill('新的巡检任务');
    await panel.getByRole('button', { name: '分派任务', exact: true }).click();
    await expect(panel.locator('article')).toHaveCount(4);
    await expect(panel.getByText('运维专员: 新的巡检任务')).toBeVisible();
  });

  test('updates detail inspector on selection, supports prev/next stepping, and exposes sticky footer actions [AC:bot-tasks-queue-redesign#AC-4]', async ({
    page,
  }) => {
    const now = new Date().toISOString();
    const taskFailed = {
      id: 'bt-step-1',
      targetBotId: 'bot-alpha',
      input: '同步上游依赖',
      status: 'failed',
      failureReason: 'Registry timeout',
      updatedAt: now,
    };
    const taskCompleted = {
      id: 'bt-step-2',
      targetBotId: 'bot-alpha',
      input: '输出上线检查单',
      status: 'completed',
      updatedAt: now,
      delivery: {
        taskId: 'bt-step-2',
        sessionId: 'sess-alpha',
        attempt: 1,
        createdAt: now,
        executionStatus: 'completed',
        report: '# 检查完成\n所有项目就绪。',
        failureReason: null,
        verification: 'unverified',
        artifacts: [],
        receipts: [],
      },
    };

    await page.route('**/api/bots', (route) =>
      route.fulfill(json({ bots: [{ id: 'bot-alpha', name: '研发助手', agentId: 'general' }] }))
    );
    await page.route('**/api/bot-work/status', (route) => route.fulfill(json({ bots: [] })));
    await page.route('**/api/bot-work/tasks?*', (route) =>
      route.fulfill(
        json({
          tasks: [taskFailed, taskCompleted],
          activeTasks: [],
          historyTasks: [taskFailed, taskCompleted],
          collaborations: [],
        })
      )
    );
    await page.route('**/api/bot-work/tasks/bt-step-1', (route) => route.fulfill(json({ task: taskFailed })));
    await page.route('**/api/bot-work/tasks/bt-step-2', (route) => route.fulfill(json({ task: taskCompleted })));

    await page.goto('/#/tasks/bots');
    const panel = page.getByTestId('bot-team-work');
    const detailAside = panel.locator('aside');

    // Priority band puts failed task first and auto-selects it with sticky retry + continue-in-chat actions
    await expect(detailAside.locator(':scope > p')).toContainText('失败');
    await expect(detailAside).toContainText('Registry timeout');
    await expect(detailAside.locator('footer').getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await expect(detailAside.locator('footer').getByRole('button', { name: '回到对话处理或补充要求', exact: true })).toBeVisible();

    // Step to next task (completed with delivery) via ↓ stepper
    await detailAside.getByRole('button', { name: '下一项', exact: true }).click();
    await expect(detailAside.locator(':scope > p')).toContainText('已完成');
    await expect(detailAside.getByTestId('bot-task-delivery')).toContainText('所有项目就绪。');
    await expect(detailAside.getByRole('button', { name: '验收通过', exact: true })).toBeVisible();
    await expect(detailAside.getByRole('button', { name: '验收未通过', exact: true })).toBeVisible();
    await expect(detailAside.getByRole('button', { name: '基于此版本继续修改', exact: true })).toBeVisible();
    await expect(detailAside.getByRole('button', { name: '保存为例行任务', exact: true })).toBeVisible();

    // Step back to previous task via ↑ stepper
    await detailAside.getByRole('button', { name: '上一项', exact: true }).click();
    await expect(detailAside.locator(':scope > p')).toContainText('失败');
  });
});
