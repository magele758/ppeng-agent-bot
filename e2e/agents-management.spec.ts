import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const uniq = (label: string) => `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function createBot(
  request: APIRequestContext,
  name: string,
  extra: { title?: string; description?: string } = {}
) {
  const res = await request.post('/api/bots', { data: { name, ...extra } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { bot: { id: string; name: string; canonicalSessionId: string } }).bot;
}

async function openBotsPage(page: Page) {
  await page.goto('/#/agents/bots');
  await expect(page.locator('#section-agents-bots')).toBeVisible();
}

test.describe('Agents page', () => {
  test('agents are cards and search filters by name, role or id, with a way back from no matches [AC:agents-management#AC-1]', async ({
    page
  }) => {
    await page.goto('/#/agents/agents');
    const general = page.getByTestId('agent-card-general');
    const evaluator = page.getByTestId('agent-card-evaluator');
    await expect(general).toBeVisible();
    await expect(evaluator).toContainText('Evaluator');
    await expect(evaluator).toContainText('evaluator');

    const search = page.getByRole('searchbox', { name: '搜索 Agent' });
    await search.fill('qa');
    await expect(evaluator).toBeVisible();
    await expect(general).toHaveCount(0);

    await search.fill('zzz-no-such-agent');
    await expect(page.getByText('没有匹配的结果')).toBeVisible();
    await page.getByRole('button', { name: '清除搜索' }).click();
    await expect(search).toHaveValue('');
    await expect(general).toBeVisible();
  });

  test('clicking a card shows purpose, capabilities and the tools the agent can use [AC:agents-management#AC-2]', async ({
    page
  }) => {
    await page.goto('/#/agents/agents');
    await page.getByTestId('agent-card-evaluator').click();
    const detail = page.locator('#agentDetail');
    await expect(detail.getByRole('heading', { name: 'Evaluator' })).toBeVisible();
    await expect(detail.getByText('用途说明')).toBeVisible();
    await expect(detail.getByText('Grade against explicit criteria', { exact: false })).toBeVisible();
    await expect(detail.getByText('能力', { exact: true })).toBeVisible();
    await expect(detail.getByText('review', { exact: true })).toBeVisible();
    await expect(detail.getByTestId('agent-tools')).toContainText('可使用全部工具');

    await page.getByTestId('agent-card-capability-prober').click();
    const tools = page.locator('#agentDetail').getByTestId('agent-tools');
    await expect(tools).toContainText('仅限以下');
    await expect(tools.getByText('web_fetch', { exact: true })).toBeVisible();
    await expect(tools).not.toContainText('可使用全部工具');
  });
});

test.describe('Bots page', () => {
  test('with no bots the page explains what a Bot is and offers New Bot [AC:agents-management#AC-3]', async ({ page }) => {
    await page.route('**/api/bots', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { bots: [] } }) : route.continue()
    );
    await openBotsPage(page);
    await expect(page.getByText('还没有 Bot')).toBeVisible();
    await expect(page.getByText('Bot 是长期存在的专属对话入口', { exact: false })).toBeVisible();
    const cta = page.locator('#section-agents-bots').getByRole('button', { name: '新建 Bot', exact: true });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page.getByRole('form', { name: '新建 Bot' })).toBeVisible();
  });

  test('creating a Bot needs only a name; advanced fields are folded; duplicates are refused [AC:agents-management#AC-4]', async ({
    page,
    request
  }) => {
    const name = uniq('Create');
    await openBotsPage(page);
    await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click();
    const form = page.getByRole('form', { name: '新建 Bot' });
    await expect(form).toBeVisible();

    const submit = form.getByRole('button', { name: '创建 Bot' });
    await expect(submit).toBeDisabled();
    await expect(form.getByLabel('显示标题')).toHaveCount(0);
    await expect(form.getByLabel('描述')).toHaveCount(0);
    await expect(form.getByRole('group', { name: '图标' })).toBeVisible();
    await form.getByRole('button', { name: '高级选项' }).click();
    await expect(form.getByLabel('显示标题')).toBeVisible();
    await expect(form.getByLabel('描述')).toBeVisible();

    await form.getByRole('textbox', { name: '名称', exact: true }).fill(name);
    await expect(submit).toBeEnabled();
    await submit.click();

    const card = page.getByRole('listitem').filter({ hasText: name });
    await expect(card).toHaveCount(1);
    await expect(page.getByTestId('bot-detail').getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText(`已创建 Bot「${name}」`)).toBeVisible();

    await page.getByRole('button', { name: '新建 Bot', exact: true }).first().click();
    const again = page.getByRole('form', { name: '新建 Bot' });
    await again.getByRole('textbox', { name: '名称', exact: true }).fill(name);
    await again.getByRole('button', { name: '创建 Bot' }).click();
    await expect(again.getByRole('alert')).toContainText('already exists');

    const list = (await (await request.get('/api/bots')).json()) as { bots: { name: string }[] };
    expect(list.bots.filter((b) => b.name === name)).toHaveLength(1);
  });

  test('Bot cards show the bound agent and search narrows by name, title or description [AC:agents-management#AC-5]', async ({
    page,
    request
  }) => {
    const token = `tok${Date.now()}`;
    const alpha = await createBot(request, uniq('Alpha'), { description: `handles ${token} digests` });
    const beta = await createBot(request, uniq('Beta'), { title: `Title ${token}-beta` });
    const other = await createBot(request, uniq('Other'));
    await openBotsPage(page);

    const search = page.getByRole('searchbox', { name: '搜索 Bot' });
    await search.fill(token);
    await expect(page.getByTestId(`bot-card-${alpha.id}`)).toBeVisible();
    await expect(page.getByTestId(`bot-card-${beta.id}`)).toBeVisible();
    await expect(page.getByTestId(`bot-card-${other.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`bot-card-${alpha.id}`)).toContainText(`Agent：${alpha.id}`);

    await search.fill(`${token}-beta`);
    await expect(page.getByTestId(`bot-card-${alpha.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`bot-card-${beta.id}`)).toBeVisible();

    await search.fill('zzz-no-such-bot');
    await expect(page.getByText('没有匹配的结果')).toBeVisible();
    await page.getByRole('button', { name: '清除搜索' }).click();
    await expect(page.getByTestId(`bot-card-${other.id}`)).toBeVisible();
  });

  test('one detail panel holds permission, turns, schedule and a folded allowlist, and values survive a reload [AC:agents-management#AC-6]', async ({
    page,
    request
  }) => {
    const bot = await createBot(request, uniq('Settings'));
    const sessionMeta = async () =>
      ((await (await request.get(`/api/sessions/${bot.canonicalSessionId}`)).json()) as {
        session: { metadata: { permissionMode?: string; maxTurns?: number } };
      }).session.metadata;

    await openBotsPage(page);
    await page.getByTestId(`bot-card-${bot.id}`).click();
    const detail = page.getByTestId('bot-detail');
    const permission = detail.getByLabel('Bot 权限档');
    await expect(permission).toBeEnabled();
    await expect(permission).toHaveValue('auto');
    await expect(detail.getByLabel('Bot 使用的模型')).toBeEnabled();

    await expect(detail.getByLabel('允许使用的工具')).toHaveCount(0);
    await detail.getByRole('button', { name: '工具与技能名单' }).click();
    await expect(detail.getByLabel('允许使用的工具')).toBeVisible();

    await permission.selectOption('ask');
    await expect.poll(async () => (await sessionMeta()).permissionMode).toBe('ask');
    await detail.getByLabel('Bot 轮数上限').selectOption('48');
    await expect.poll(async () => (await sessionMeta()).maxTurns).toBe(48);

    await detail.getByRole('button', { name: /展开或收起：定时任务/ }).click();
    await expect(detail.getByRole('button', { name: '添加定时任务' })).toBeVisible();

    await page.reload();
    await page.getByTestId(`bot-card-${bot.id}`).click();
    const again = page.getByTestId('bot-detail');
    await expect(again.getByLabel('Bot 权限档')).toHaveValue('ask');
    await expect(again.getByLabel('Bot 轮数上限')).toHaveValue('48');
  });

  test('Open chat lands on the Bot own conversation [AC:agents-management#AC-7]', async ({ page, request }) => {
    const name = uniq('Chat');
    const bot = await createBot(request, name);
    await openBotsPage(page);
    await page.getByTestId(`bot-card-${bot.id}`).click();
    await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话' }).click();
    await expect(page).toHaveURL(/#\/bot$/);
    await expect(page.locator('#nav-bot')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByPlaceholder(`发消息给 ${bot.name}…`)).toBeVisible();
  });
});

test.describe('Teams page', () => {
  test('empty state guides the user; only a goal is needed and strategy is under advanced [AC:agents-management#AC-8]', async ({
    page
  }) => {
    await page.route('**/api/swarm/runs', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { runs: [] } }) : route.continue()
    );
    await page.goto('/#/agents/teams');
    await expect(page.getByText('还没有 Swarm 运行')).toBeVisible();
    const form = page.getByRole('form', { name: '启动一个 Swarm' });
    await expect(form.getByLabel('策略')).toHaveCount(0);
    await form.getByRole('button', { name: '高级选项' }).click();
    await expect(form.getByLabel('策略')).toBeVisible();

    await form.getByRole('button', { name: '创建并启动' }).click();
    await expect(form.getByRole('alert')).toContainText('请输入目标');
  });

  test('starting a Swarm from just a goal adds it to the run list [AC:agents-management#AC-8]', async ({ page }) => {
    const goal = `e2e team goal ${Date.now()}`;
    await page.goto('/#/agents/teams');
    const form = page.getByRole('form', { name: '启动一个 Swarm' });
    await form.getByRole('textbox', { name: '目标' }).fill(goal);
    await form.getByRole('button', { name: '创建并启动' }).click();
    const run = page.getByRole('group', { name: '选择要查看的 Swarm 运行' }).getByRole('button', { name: new RegExp(goal) });
    await expect(run).toBeVisible();
    await expect(run).toHaveAttribute('aria-pressed', 'true');
  });

  test('the graph sits beside a task list with full titles, and picking another run switches both [AC:agents-management#AC-9]', async ({
    page,
    request
  }) => {
    const stamp = Date.now();
    const makeRun = async (goal: string, titles: string[]) => {
      const created = await request.post('/api/swarm/runs', { data: { goal, strategy: 'pipeline' } });
      const { run } = (await created.json()) as { run: { id: string } };
      const started = await request.post(`/api/swarm/runs/${run.id}/start`, {
        data: { tasks: titles.map((title) => ({ title, requiredRole: 'implementer' })) }
      });
      expect(started.ok()).toBeTruthy();
      return run.id;
    };
    const longTitle = `Write an exhaustively detailed migration plan for the billing service ${stamp}`;
    const firstId = await makeRun(`e2e first run ${stamp}`, [longTitle, `Review the plan ${stamp}`]);
    const secondId = await makeRun(`e2e second run ${stamp}`, [`Only task of the second run ${stamp}`]);

    await page.goto('/#/agents/teams');
    await page.getByTestId(`swarm-run-${firstId}`).click();
    const tasks = page.getByTestId('team-task-list');
    await expect(tasks).toContainText(longTitle);
    await expect(tasks).toContainText(`Review the plan ${stamp}`);
    await expect(tasks.getByText('implementer', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('list', { name: '工作态图例' })).toBeVisible();
    await expect(page.getByLabel('Team graph')).toBeVisible();

    await page.getByTestId(`swarm-run-${secondId}`).click();
    await expect(tasks).toContainText(`Only task of the second run ${stamp}`);
    await expect(tasks).not.toContainText(longTitle);
  });
});

test.describe('Skills page', () => {
  test('skills are searchable cards, filterable by source, and proposals stay on the page [AC:agents-management#AC-10]', async ({
    page
  }) => {
    await page.goto('/#/agents/skills');
    const planning = page.getByTestId('skill-card-planning');
    await expect(planning).toBeVisible();
    await expect(planning).toContainText('内置');

    const search = page.getByRole('searchbox', { name: '搜索技能' });
    await search.fill('roadmap');
    await expect(planning).toBeVisible();
    await expect(page.getByTestId('skill-card-subagents')).toHaveCount(0);

    await search.fill('zzz-no-such-skill');
    await expect(page.getByText('没有匹配的结果')).toBeVisible();
    await page.getByRole('button', { name: '清除搜索' }).click();
    await expect(search).toHaveValue('');

    await page.getByRole('combobox', { name: '按来源筛选' }).selectOption('builtin');
    await expect(planning).toBeVisible();
    await expect(page.locator('[data-testid^="skill-card-"]').filter({ hasText: '仓库' })).toHaveCount(0);

    await expect(page.locator('#card-skill-proposals')).toBeVisible();
  });
});
