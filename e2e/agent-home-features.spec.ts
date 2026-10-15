import { test, expect, type Page } from '@playwright/test';

/**
 * Agent Home 主流程回归：全部通过 route mock 提供数据，不依赖真实 LLM，也不读写 daemon 状态。
 * 同一套检查的“真实浏览器”版本见 scripts/pagelens-smoke.mjs。
 */

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mockGet(page: Page, path: string, body: unknown) {
  await page.route(new RegExp(`/api/${path}(\\?.*)?$`), (route) =>
    route.request().method() === 'GET' ? route.fulfill(json(body)) : route.fallback()
  );
}

const NOW = new Date().toISOString();

const BOTS = [
  {id:'super-bot',name:'Super Bot',title:'Super Bot',agentId:'super-bot',canonicalSessionId:'sess-bot-super',hidden:false},
  { id: 'deskbot', name: 'DeskBot', title: '桌面助手', agentId: 'deskbot', canonicalSessionId: 'sess-bot-desk', hidden: false },
  { id: 'bot-xiaoba', name: '小八', title: '小八', agentId: 'bot-xiaoba', canonicalSessionId: 'sess-bot-xiaoba', hidden: false }
];

const SESSIONS = [
  {id:'sess-bot-super',title:'Bot Chat · Super Bot',mode:'chat',status:'idle',agentId:'super-bot',metadata:{botId:'super-bot',canonicalBotChat:true},updatedAt:NOW},
  { id: 'sess-chat-1', title: 'Deploy review', mode: 'chat', status: 'idle', agentId: 'general', metadata: {}, updatedAt: NOW },
  { id: 'sess-chat-2', title: 'Weekly notes', mode: 'chat', status: 'idle', agentId: 'general', metadata: {}, updatedAt: NOW },
  { id: 'sess-bot-desk', title: 'Bot Chat · DeskBot', mode: 'chat', status: 'idle', agentId: 'deskbot', metadata: { botId: 'deskbot', canonicalBotChat: true }, updatedAt: NOW },
  { id: 'sess-bot-xiaoba', title: 'Bot Chat · 小八', mode: 'chat', status: 'idle', agentId: 'bot-xiaoba', metadata: { botId: 'bot-xiaoba', canonicalBotChat: true }, updatedAt: NOW }
];

async function mockHome(page: Page, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    bots: { bots: BOTS },
    'bot-work/default':{bot:BOTS[0],session:SESSIONS[0],sessionId:SESSIONS[0].id},
    'sessions/sess-bot-super':{session:SESSIONS[0],messages:[]},
    sessions: { sessions: SESSIONS },
    tasks: { tasks: [] },
    approvals: { approvals: [] },
    'self-heal/status': { active: [] },
    'self-heal/runs': { runs: [] },
    ...extra
  };
  for (const [path, body] of Object.entries(data)) await mockGet(page, path, body);
  await page.route('**/api/bots/super-bot/open',route=>route.fulfill(json({bot:BOTS[0],session:SESSIONS[0],sessionId:SESSIONS[0].id})));
}

const ROUTES: Array<{ hash: string; nav: string; section: string }> = [
  { hash: '#/bot', nav: 'nav-bot', section: '#panel-play' },
  { hash: '#/chat', nav: 'nav-chat', section: '#panel-play' },
  { hash: '#/agents', nav: 'nav-agents', section: '#section-agents' },
  { hash: '#/tasks', nav: 'nav-tasks', section: '#section-tasks-queue' },
  { hash: '#/tasks/inbox', nav: 'nav-tasks', section: '#section-tasks-inbox' },
  { hash: '#/knowledge', nav: 'nav-knowledge', section: '#section-knowledge' },
  { hash: '#/ops', nav: 'nav-settings', section: '#section-ops-trajectory' },
  { hash: '#/ops/health', nav: 'nav-settings', section: '#section-ops-health' },
  { hash: '#/settings', nav: 'nav-settings', section: '#section-settings' }
];

test.describe('Agent Home routes', () => {
  test('every hash route lands on its section and highlights its nav item [AC:console-navigation#AC-2]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/chat');
    for (const r of ROUTES) {
      await page.evaluate((h) => {
        location.hash = h;
      }, r.hash);
      await expect(page.locator(r.section), r.hash).toBeVisible();
      await expect(page.locator(`#${r.nav}`), r.hash).toHaveAttribute('aria-current', 'page');
    }
  });

  test('an unknown hash falls back to chat [AC:console-navigation#AC-2]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/definitely-not-a-route');
    await expect(page.locator('#panel-play')).toBeVisible();
    await expect(page.locator('#nav-chat')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('Chat and Bot mode', () => {
  test('switching to Bot mode lists the bot roster with their fixed chats, chat mode hides them [AC:bots#AC-1]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/chat');
    const list = page.locator('#sessionListMini');
    await expect(list).toContainText('Deploy review');
    await expect(list).not.toContainText('Bot Chat');

    await page.locator('#nav-bot').click();
    await expect(page.locator('#nav-bot')).toHaveAttribute('aria-current', 'page');
    await expect(list.locator('.list-item')).toHaveCount(3);
    await expect(list).toContainText('Bot Chat · DeskBot');
    await expect(list).toContainText('Bot Chat · 小八');
    await expect(list).not.toContainText('Deploy review');
    const options = page.locator('#botSelect option');
    await expect(options).toHaveText(['选择 Bot', 'Super Bot', 'DeskBot', '小八']);

    await page.locator('#nav-chat').click();
    await expect(page.locator('#nav-chat')).toHaveAttribute('aria-current', 'page');
    await expect(list).toContainText('Weekly notes');
    await expect(page.locator('#botSelect')).toHaveCount(0);
  });

  test('Bots page roster shows both bots as cards and filters by name [AC:agents-management#AC-5]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/agents/bots');
    const roster = page.locator('#section-agents-bots');
    await expect(roster).toContainText('DeskBot');
    await expect(roster).toContainText('小八');
    await roster.getByRole('searchbox').fill('desk');
    await expect(roster).toContainText('DeskBot');
    await expect(roster).not.toContainText('小八');
    await roster.getByRole('searchbox').fill('');
    await expect(roster).toContainText('小八');
  });

  test('session filter narrows the rail by keyword and restores on clear [AC:chat-experience#AC-5]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/chat');
    const list = page.locator('#sessionListMini');
    const filter = page.getByLabel('筛选会话列表');
    await expect(list.locator('.list-item')).toHaveCount(2);

    await filter.fill('weekly');
    await expect(list.locator('.list-item')).toHaveCount(1);
    await expect(list).toContainText('Weekly notes');
    await expect(list).not.toContainText('Deploy review');

    await filter.fill('');
    await expect(list.locator('.list-item')).toHaveCount(2);
  });
});

test.describe('Approvals inbox and badges', () => {
  test('nav badge, tab badge and inbox list agree on the pending count [AC:console-tasks#AC-4]', async ({ page }) => {
    const base = { toolName: 'bash', sessionId: 'sess-chat-1', reason: 'needs shell', args: {}, createdAt: NOW, status: 'pending' };
    await mockHome(page, { approvals: { approvals: [{ ...base, id: 'apr-1' }, { ...base, id: 'apr-2' }] } });
    await page.goto('/#/tasks/inbox');
    await expect(page.locator('#listApprovals .list-item')).toHaveCount(2);
    await expect(page.locator('#nav-tasks')).toContainText('2');
    await expect(page.locator('#section-tasks-tab-inbox')).toContainText('2');
  });

  test('without approvals there is no badge and the inbox explains it is empty [AC:console-tasks#AC-5]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/tasks/inbox');
    await expect(page.locator('#section-tasks-inbox').getByText('没有待处理的审批')).toBeVisible();
    await expect(page.locator('#nav-tasks')).toHaveText('任务');
    await expect(page.locator('#section-tasks-tab-inbox')).toHaveText('审批与收件箱');
  });
});

test.describe('Self-heal consistency', () => {
  const runs = [
    { id: 'sheal_run_active', status: 'running_tests', taskId: 'task-active', fixIteration: 1, updatedAt: NOW },
    { id: 'sheal_run_failed', status: 'failed', taskId: 'task-failed', fixIteration: 5, lastErrorSummary: 'unit tests failed', updatedAt: NOW },
    { id: 'sheal_run_blocked', status: 'blocked', taskId: 'task-blocked', blockReason: 'dirty main', updatedAt: NOW },
    { id: 'sheal_run_done', status: 'completed', taskId: 'task-done', updatedAt: NOW }
  ];
  const tasks = [
    { id: 'task-active', title: 'Self-heal active', status: 'in_progress', ownerAgentId: 'self-healer' },
    { id: 'task-failed', title: 'Self-heal failed', status: 'failed', ownerAgentId: 'self-healer' },
    { id: 'task-blocked', title: 'Self-heal blocked', status: 'failed', ownerAgentId: 'self-healer' },
    { id: 'task-done', title: 'Self-heal done', status: 'completed', ownerAgentId: 'self-healer' }
  ];

  test('task queue statuses line up with the Self-heal card on Ops health [AC:ops-console#AC-1] [AC:console-tasks#AC-1]', async ({ page }) => {
    await mockHome(page, {
      tasks: { tasks },
      'self-heal/status': { active: [runs[0]] },
      'self-heal/runs': { runs }
    });

    await page.goto('/#/ops/health');
    const card = page.getByTestId('ops-card-selfheal');
    await expect(card).toContainText('运行中 · 1 个修复任务');
    await card.getByText('最近运行').click();
    const items = card.locator('.ops-run');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toContainText('正在跑测试');
    await expect(items.nth(1)).toContainText('失败');
    await expect(items.nth(2)).toContainText('已阻塞');
    await expect(items.nth(3)).toContainText('已完成');

    await page.goto('/#/tasks/queue');
    const filters = page.locator('#taskStatusFilter');
    // 失败/阻塞的 run 对应的任务都是「失败」，进行中的 run 对应「进行中」
    await expect(filters.getByTestId('status-filter-failed')).toContainText('2');
    await expect(filters.getByTestId('status-filter-in_progress')).toContainText('1');
    await expect(filters.getByTestId('status-filter-completed')).toContainText('1');
  });

  test('a finished-but-failed history stays idle and the banner does not say all clear [AC:ops-console#AC-1] [AC:ops-console#AC-10]', async ({ page }) => {
    await mockHome(page, { 'self-heal/runs': { runs: runs.slice(1, 3) } });
    await page.goto('/#/ops/health');
    const card = page.getByTestId('ops-card-selfheal');
    await expect(card).toContainText('空闲 · 没有进行中的修复');
    await expect(card).not.toContainText('运行中');
    await expect(card).toContainText('最近 2 次修复失败或阻塞。');
    const overall = page.getByTestId('ops-overall');
    await expect(overall).toHaveAttribute('data-level', 'warn');
    await expect(overall).toContainText('需要关注');
    await expect(overall).not.toContainText('一切正常');
    await expect(page.locator('.global-status__chip').first()).toContainText('需要关注');
  });
});

test.describe('Settings language and theme', () => {
  test('switching language relabels the nav and the choice survives reload [AC:console-navigation#AC-5]', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/settings');
    const nav = page.getByRole('navigation', { name: '一级导航' });
    await expect(nav.getByRole('link')).toHaveText(['Bot', '对话', 'Bots 与 Agents', '任务', '知识与记忆', '设置']);

    await page.getByTestId('language-toggle').first().getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);
    await expect(page.getByRole('navigation', { name: /primary|navigation/i }).getByRole('link').nth(1)).toHaveText('Chat');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);

    await page.getByTestId('language-toggle').first().getByRole('button', { name: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^zh/);
    await expect(nav.getByRole('link').nth(1)).toHaveText('对话');
  });

  test('theme choice applies data-theme and survives reload', async ({ page }) => {
    await mockHome(page);
    await page.goto('/#/settings');
    const group = page.getByRole('radiogroup', { name: '主题' });
    await group.locator('label', { hasText: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色' })).toBeChecked();

    await page.getByRole('radiogroup', { name: '主题' }).locator('label', { hasText: '浅色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
