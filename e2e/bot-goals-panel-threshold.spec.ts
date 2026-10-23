import { test, expect, type Page, type Route } from '@playwright/test';

const settings = {
  maxConcurrent: 2,
  defaultBudgetUsd: 10,
  maxAttempts: 8,
  maxNoProgress: 3,
  leaseMs: 60000,
  preferredStrategy: 'auto',
};

const statusLabel: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  blocked: '已阻塞',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

type Goal = {
  id: string;
  title: string;
  status: string;
  progress: string;
  nextStep: string;
  priority: number;
  evidence: string[];
  budgetUsd: number;
  costUsd: number;
};

type GoalBoard = { goals: Goal[]; fail: boolean };
type FixtureBot = { id: string; name: string; sessionId: string };

function goal(id: string, title: string, status: string, nextStep = ''): Goal {
  return { id, title, status, progress: '', nextStep, priority: 0, evidence: [], budgetUsd: 10, costUsd: 0 };
}

function fixture(id: string, name: string): FixtureBot {
  return { id, name, sessionId: `sess-${id}` };
}

function pathname(url: string) {
  return new URL(url).pathname;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lab.locale', 'zh'));
});

async function installLab(page: Page, bots: FixtureBot[]) {
  const records = bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    agentId: 'general',
    canonicalSessionId: bot.sessionId,
    hidden: false,
  }));
  const sessions = bots.map((bot) => ({
    id: bot.sessionId,
    title: bot.name,
    mode: 'chat',
    status: 'idle',
    agentId: 'general',
    metadata: { botId: bot.id, canonicalBotChat: true },
  }));
  const fulfill = (route: Route, body: unknown) => route.fulfill({ json: body });
  await page.route((url) => url.pathname === '/api/bot-functional-groups', (route) => fulfill(route, { groups: [] }));
  await page.route((url) => url.pathname === '/api/bot-rooms', (route) => fulfill(route, { rooms: [] }));
  await page.route((url) => url.pathname === '/api/bot-work/default', (route) => route.fulfill({ status: 404, json: { error: 'no default bot' } }));
  await page.route((url) => url.pathname === '/api/sessions', (route) => fulfill(route, { sessions }));
  await page.route((url) => url.pathname === '/api/bots', (route) => fulfill(route, { bots: records }));
  for (const bot of bots) {
    const record = records.find((item) => item.id === bot.id)!;
    const session = sessions.find((item) => item.id === bot.sessionId)!;
    await page.route((url) => url.pathname === `/api/bots/${bot.id}`, (route) => fulfill(route, { bot: record }));
    await page.route((url) => url.pathname === `/api/bots/${bot.id}/open`, (route) => fulfill(route, { bot: record, session }));
    await page.route((url) => url.pathname === `/api/sessions/${bot.sessionId}`, (route) => fulfill(route, {
      session,
      messages: [],
      latestAssistant: '',
    }));
    await page.route((url) => url.pathname === `/api/sessions/${bot.sessionId}/goal`, (route) => fulfill(route, { goal: null }));
  }
}

async function installGoals(page: Page, botId: string, board: GoalBoard) {
  await page.route((url) => url.pathname === `/api/bots/${botId}/goals`, async (route) => {
    if (board.fail) {
      await route.fulfill({ status: 404, json: { error: 'Route not found' } });
      return;
    }
    await route.fulfill({ json: { goals: board.goals, settings } });
  });
}

async function selectBot(page: Page, id: string) {
  const row = page.locator(`#sessionListMini [data-bot-id="${id}"] .list-item--session`);
  await expect(row).toBeVisible();
  await row.click();
}

async function openBot(page: Page, bot: FixtureBot) {
  const pending = page.waitForResponse(
    (res) => res.request().method() === 'GET' && pathname(res.url()) === `/api/bots/${bot.id}/goals`,
    { timeout: 15_000 },
  );
  await selectBot(page, bot.id);
  await pending;
  await expect(page.locator('#playTitle')).toHaveText(bot.name);
  await expect(page.locator('#playInput')).toBeVisible();
}

async function reloadBot(page: Page, bot: FixtureBot) {
  const pending = page.waitForResponse(
    (res) => res.request().method() === 'GET' && pathname(res.url()) === `/api/bots/${bot.id}/goals`,
    { timeout: 15_000 },
  );
  await page.reload();
  await pending;
  await expect(page.locator('#playTitle')).toHaveText(bot.name);
  await expect(page.locator('#playInput')).toBeVisible();
}

async function expectGoalsHidden(page: Page, timeout = 2_000) {
  const composer = page.locator('.chat-composer-outer');
  await expect(page.getByTestId('bot-goals')).toHaveCount(0, { timeout });
  await expect(composer).not.toContainText('目标与进展', { timeout });
  await expect(composer).not.toContainText('下一条消息关联的目标', { timeout });
  await expect(composer).not.toContainText('目标操作失败', { timeout });
  await expect(composer).not.toContainText('Route not found', { timeout });
}

async function expandGoals(page: Page) {
  const panel = page.getByTestId('bot-goals');
  await expect(panel).toBeVisible();
  const summary = panel.locator(':scope > summary');
  await expect(summary).toContainText('目标与进展');
  const open = await panel.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!open) await summary.click();
  return panel;
}

test('fewer than two listed goals stays hidden on open, refresh, and switch [AC:bot-goals-panel-threshold#AC-1] [AC:low-interference-onboarding-goals#AC-3]', async ({ page }) => {
  const empty = fixture('threshold-empty', 'Threshold empty');
  const single = fixture('threshold-single', 'Threshold single');
  const pair = fixture('threshold-pair', 'Threshold pair');
  const emptyBoard: GoalBoard = { goals: [], fail: false };
  const singleBoard: GoalBoard = { goals: [goal('g-run', 'Fix login', 'running', 'Verify login')], fail: false };
  const pairBoard: GoalBoard = {
    goals: [
      goal('g-run', 'Fix login', 'running', 'Verify login'),
      goal('g-wait', 'Watch deployment', 'waiting', 'Wait for deployment'),
    ],
    fail: false,
  };
  await installLab(page, [empty, single, pair]);
  await installGoals(page, empty.id, emptyBoard);
  await installGoals(page, single.id, singleBoard);
  await installGoals(page, pair.id, pairBoard);
  await page.goto('/#/bot');

  await test.step('open and refresh with zero goals', async () => {
    await openBot(page, empty);
    await expectGoalsHidden(page);
    await reloadBot(page, empty);
    await expectGoalsHidden(page);
  });

  await test.step('one running, completed, failed, or cancelled goal stays hidden', async () => {
    await openBot(page, single);
    await expectGoalsHidden(page);
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      singleBoard.goals = [goal('g-one', 'One goal', status, 'Next')];
      await reloadBot(page, single);
      await expectGoalsHidden(page);
    }
  });

  await test.step('switching from two goals to fewer than two hides the panel', async () => {
    await openBot(page, pair);
    await expect(page.getByTestId('bot-goals')).toBeVisible();
    await openBot(page, empty);
    await expectGoalsHidden(page);
    await openBot(page, single);
    await expectGoalsHidden(page);
  });
});

test('a failed goal list stays hidden on open, refresh, and switch [AC:bot-goals-panel-threshold#AC-1] [AC:low-interference-onboarding-goals#AC-3]', async ({ page }) => {
  const broken = fixture('threshold-broken', 'Threshold broken');
  const empty = fixture('threshold-quiet', 'Threshold quiet');
  const pair = fixture('threshold-shown', 'Threshold shown');
  await installLab(page, [broken, empty, pair]);
  await installGoals(page, broken.id, { goals: [], fail: true });
  await installGoals(page, empty.id, { goals: [], fail: false });
  await installGoals(page, pair.id, {
    goals: [
      goal('g-run', 'Fix login', 'running', 'Verify login'),
      goal('g-wait', 'Watch deployment', 'waiting', 'Wait for deployment'),
    ],
    fail: false,
  });
  await page.goto('/#/bot');

  await openBot(page, broken);
  await expectGoalsHidden(page);
  await reloadBot(page, broken);
  await expectGoalsHidden(page);
  await openBot(page, empty);
  await expectGoalsHidden(page);
  await openBot(page, pair);
  await expect(page.getByTestId('bot-goals')).toBeVisible();
  await openBot(page, broken);
  await expectGoalsHidden(page);
});

test('two listed goals show progress and the next-message association [AC:bot-goals-panel-threshold#AC-2] [AC:low-interference-onboarding-goals#AC-4]', async ({ page }) => {
  const mixed = fixture('threshold-mixed', 'Threshold mixed');
  const terminal = fixture('threshold-terminal', 'Threshold terminal');
  await installLab(page, [mixed, terminal]);
  await installGoals(page, mixed.id, {
    goals: [
      goal('g-run', 'Fix login', 'running', 'Verify login'),
      goal('g-wait', 'Watch deployment', 'waiting', 'Wait for deployment'),
    ],
    fail: false,
  });
  await installGoals(page, terminal.id, {
    goals: [
      goal('g-block', 'Need a decision', 'blocked', 'Ask which backup to restore'),
      goal('g-pause', 'Hold the migration', 'paused'),
    ],
    fail: false,
  });
  await page.goto('/#/bot');

  await openBot(page, mixed);
  const panel = await expandGoals(page);
  const running = panel.getByTestId('bot-goal-g-run');
  await expect(running).toContainText('Fix login');
  await expect(running).toContainText(statusLabel.running);
  await expect(running).toContainText('Verify login');
  await expect(panel.getByTestId('bot-goal-g-wait')).toContainText('Watch deployment');
  await expect(panel.getByTestId('bot-goal-g-wait')).toContainText(statusLabel.waiting);
  await panel.getByLabel('下一条消息关联的目标').selectOption('g-run');
  await expect(panel.locator(':scope > summary')).toContainText('Fix login');

  await openBot(page, terminal);
  const closed = await expandGoals(page);
  await expect(closed.getByTestId('bot-goal-g-block')).toContainText(statusLabel.blocked);
  await expect(closed.getByTestId('bot-goal-g-block')).toContainText('Ask which backup to restore');
  await expect(closed.getByTestId('bot-goal-g-pause')).toContainText(statusLabel.paused);
  await expect(closed.getByLabel('下一条消息关联的目标')).toBeVisible();
});

test('the goals panel appears and disappears when the listed count crosses two [AC:bot-goals-panel-threshold#AC-3] [AC:low-interference-onboarding-goals#AC-3] [AC:low-interference-onboarding-goals#AC-4]', async ({ page }) => {
  const bot = fixture('threshold-live', 'Threshold live');
  const running = goal('g-run', 'Fix login', 'running', 'Verify login');
  const waiting = goal('g-wait', 'Watch deployment', 'waiting', 'Wait for deployment');
  const board: GoalBoard = { goals: [running], fail: false };
  await installLab(page, [bot]);
  await installGoals(page, bot.id, board);
  await page.goto('/#/bot');
  await openBot(page, bot);
  await expectGoalsHidden(page);
  await page.evaluate(() => {
    (window as Window & { __goalPanel?: string }).__goalPanel = 'live';
  });

  board.goals = [running, waiting];
  await expect(page.getByTestId('bot-goals')).toBeVisible();
  const panel = await expandGoals(page);
  await expect(panel.getByTestId('bot-goal-g-run')).toContainText('Verify login');
  await expect(panel.getByTestId('bot-goal-g-run')).toContainText(statusLabel.running);
  await expect(panel.getByTestId('bot-goal-g-wait')).toContainText(statusLabel.waiting);
  await panel.getByLabel('下一条消息关联的目标').selectOption('g-run');
  await expect(panel.locator(':scope > summary')).toContainText('Fix login');

  board.goals = [waiting];
  await expectGoalsHidden(page, 15_000);
  expect(await page.evaluate(() => (window as Window & { __goalPanel?: string }).__goalPanel)).toBe('live');
});

test('completed goals are omitted and the count is only in-progress work [AC:bot-goals-panel-rules#AC-4]', async ({ page }) => {
  const bot = fixture('rules-done', 'Rules done');
  await installLab(page, [bot]);
  await installGoals(page, bot.id, {
    goals: [
      goal('g-run', 'Fix login', 'running', 'Verify login'),
      goal('g-wait', 'Watch deployment', 'waiting', 'Wait for deployment'),
      goal('g-done', 'Ship notes', 'completed'),
    ],
    fail: false,
  });
  await page.goto('/#/bot');
  await openBot(page, bot);
  const panel = await expandGoals(page);
  await expect(panel.locator(':scope > summary')).toContainText('目标与进展 (2)');
  await expect(panel.getByTestId('bot-goal-g-run')).toContainText('Fix login');
  await expect(panel.getByTestId('bot-goal-g-wait')).toContainText('Watch deployment');
  await expect(panel.getByTestId('bot-goal-g-done')).toHaveCount(0);
  await expect(panel).not.toContainText('Ship notes');
  await expect(panel).not.toContainText(statusLabel.completed);
});

test('old finished goals do not keep the panel on screen [AC:bot-goals-panel-rules#AC-5]', async ({ page }) => {
  const bot = fixture('rules-few', 'Rules few');
  const board: GoalBoard = {
    goals: [
      goal('g-run', 'Fix login', 'running', 'Verify login'),
      goal('g-done', 'Ship notes', 'completed'),
      goal('g-fail', 'Restore backup', 'failed'),
      goal('g-stop', 'Retire job', 'cancelled'),
    ],
    fail: false,
  };
  await installLab(page, [bot]);
  await installGoals(page, bot.id, board);
  await page.goto('/#/bot');
  await openBot(page, bot);
  await expectGoalsHidden(page);
  await reloadBot(page, bot);
  await expectGoalsHidden(page);
  await page.waitForTimeout(1000);
  await expectGoalsHidden(page);
  board.goals = [
    goal('g-done', 'Ship notes', 'completed'),
    goal('g-fail', 'Restore backup', 'failed'),
  ];
  await reloadBot(page, bot);
  await expectGoalsHidden(page);
});

test('only in-progress goals are listed once two of them exist [AC:bot-goals-panel-rules#AC-6]', async ({ page }) => {
  const bot = fixture('rules-active', 'Rules active');
  await installLab(page, [bot]);
  await installGoals(page, bot.id, {
    goals: [
      goal('g-q', 'Queue the rollout', 'queued'),
      goal('g-r', 'Fix login', 'running', 'Verify login'),
      goal('g-w', 'Watch deployment', 'waiting', 'Wait for deployment'),
      goal('g-b', 'Need a decision', 'blocked', 'Ask which backup to restore'),
      goal('g-p', 'Hold the migration', 'paused'),
      goal('g-c', 'Ship notes', 'completed'),
      goal('g-f', 'Restore backup', 'failed'),
      goal('g-x', 'Retire job', 'cancelled'),
    ],
    fail: false,
  });
  await page.goto('/#/bot');
  await openBot(page, bot);
  const panel = await expandGoals(page);
  await expect(panel.locator(':scope > summary')).toContainText('目标与进展 (5)');
  for (const [id, title] of [
    ['g-q', 'Queue the rollout'],
    ['g-r', 'Fix login'],
    ['g-w', 'Watch deployment'],
    ['g-b', 'Need a decision'],
    ['g-p', 'Hold the migration'],
  ] as const) {
    await expect(panel.getByTestId(`bot-goal-${id}`)).toContainText(title);
  }
  await expect(panel.getByTestId('bot-goal-g-c')).toHaveCount(0);
  await expect(panel.getByTestId('bot-goal-g-f')).toHaveCount(0);
  await expect(panel.getByTestId('bot-goal-g-x')).toHaveCount(0);
  await expect(panel).not.toContainText('Ship notes');
  await expect(panel).not.toContainText('Restore backup');
  await expect(panel).not.toContainText('Retire job');
});

test('the panel appears and disappears as in-progress goals cross two [AC:bot-goals-panel-rules#AC-7]', async ({ page }) => {
  const bot = fixture('rules-live', 'Rules live');
  const running = goal('g-run', 'Fix login', 'running', 'Verify login');
  const done = goal('g-done', 'Ship notes', 'completed');
  const queued = goal('g-q', 'Queue the rollout', 'queued');
  const board: GoalBoard = { goals: [running, done], fail: false };
  await installLab(page, [bot]);
  await installGoals(page, bot.id, board);
  await page.goto('/#/bot');
  await openBot(page, bot);
  await expectGoalsHidden(page);
  await page.evaluate(() => {
    (window as Window & { __goalPanel?: string }).__goalPanel = 'live';
  });

  board.goals = [running, done, queued];
  const panel = await expandGoals(page);
  await expect(panel.locator(':scope > summary')).toContainText('目标与进展 (2)');
  await expect(panel.getByTestId('bot-goal-g-run')).toContainText('Fix login');
  await expect(panel.getByTestId('bot-goal-g-q')).toContainText('Queue the rollout');
  await expect(panel.getByTestId('bot-goal-g-done')).toHaveCount(0);

  board.goals = [done, queued];
  await expectGoalsHidden(page, 15_000);
  expect(await page.evaluate(() => (window as Window & { __goalPanel?: string }).__goalPanel)).toBe('live');
});

test('goals from another chat of the same Bot stay out of this panel [AC:bot-goals-panel-rules#AC-8]', async ({ page }) => {
  const bot = fixture('rules-scope', 'Rules scope');
  const requested: string[] = [];
  await installLab(page, [bot]);
  await page.route((url) => url.pathname === `/api/bots/${bot.id}/goals`, async (route) => {
    const sessionId = new URL(route.request().url()).searchParams.get('sessionId') ?? '';
    requested.push(sessionId);
    const goals = sessionId === bot.sessionId
      ? [goal('g-run', 'Fix login', 'running', 'Verify login'), goal('g-wait', 'Watch deployment', 'waiting', 'Wait for deployment')]
      : [goal('g-other', 'OTHER-SESSION-GOAL', 'running', 'Do not show')];
    await route.fulfill({ json: { goals, settings } });
  });
  await page.goto('/#/bot');
  await openBot(page, bot);
  const panel = await expandGoals(page);
  await expect(panel.getByTestId('bot-goal-g-run')).toContainText('Fix login');
  await expect(panel.getByTestId('bot-goal-g-wait')).toContainText('Watch deployment');
  await expect(panel).not.toContainText('OTHER-SESSION-GOAL');
  await expect(page.locator('.chat-composer-outer')).not.toContainText('OTHER-SESSION-GOAL');
  expect(requested.length).toBeGreaterThan(0);
  expect(requested.every((sessionId) => sessionId === bot.sessionId)).toBe(true);
});

test('finished goals move to on-demand header history while live states stay visible [AC:unified-bot-goal-lifecycle#AC-3]', async ({ page }) => {
  const bot = fixture('unified-goal-history', 'Goal history');
  const board: GoalBoard = { goals: [
    { ...goal('done', 'Shipped artifact', 'completed'), evidence: ['artifact checks passed'] },
    { ...goal('failed', 'Rejected upload', 'failed'), progress: 'Server rejected the upload' },
  ], fail: false };
  await installLab(page, [bot]);
  await installGoals(page, bot.id, board);
  await page.route((url) => url.pathname === '/api/goals' && url.searchParams.get('sessionId') === bot.sessionId, route => route.fulfill({ json: { goals: board.goals } }));
  let status = 'completed';
  await page.route((url) => url.pathname === `/api/sessions/${bot.sessionId}/goal`, route => route.fulfill({ json: {
    goal: { goalId: 'done', status, condition: 'Shipped artifact', turnsUsed: 1, maxTurns: 8, source: 'bot' }
  } }));
  await page.goto('/#/bot');
  await openBot(page, bot);
  await expect(page.locator('.goal-status-card')).toHaveCount(0);
  await expect(page.locator('.chat-composer-outer')).not.toContainText('Shipped artifact');
  const history = page.getByTestId('goal-history');
  await expect(history.locator('article')).toHaveCount(0);
  await history.locator('summary').click();
  await expect(history).toContainText('Shipped artifact');
  await expect(history).toContainText('artifact checks passed');
  await expect(history).toContainText('Rejected upload');
  await history.locator('summary').click();
  status = 'running';
  await expect(page.locator('.goal-status-card')).toContainText('执行中', { timeout: 8000 });
  status = 'blocked';
  await expect(page.locator('.goal-status-card')).toContainText('已阻塞', { timeout: 8000 });
  status = 'failed';
  await expect(page.locator('.goal-status-card')).toHaveCount(0, { timeout: 8000 });
});
