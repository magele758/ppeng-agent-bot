import { expect, test, type Page, type Route } from '@playwright/test';

test.use({ viewport: { width: 1218, height: 1104 }, reducedMotion: 'reduce' });

const WINDOW = 1_000_000;

interface TurnMetric {
  turn: number;
  estimatedTokens: number;
  windowTokens?: number;
  actualInputTokens?: number | null;
  sentAt: string;
}

interface ChatFixture {
  id: string;
  name: string;
  turns: TurnMetric[];
}

function pathPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`/api/${escaped}(?:\\?.*)?$`);
}

function fulfill(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockGet(page: Page, path: string, body: unknown) {
  await page.route(pathPattern(path), (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return fulfill(route, body);
  });
}

function botFor(chat: ChatFixture) {
  return {
    id: `${chat.id}-bot`,
    name: chat.name,
    agentId: 'general',
    canonicalSessionId: chat.id
  };
}

function sessionFor(chat: ChatFixture) {
  const bot = botFor(chat);
  return {
    id: chat.id,
    title: chat.name,
    mode: 'chat',
    status: 'idle',
    agentId: 'general',
    metadata: { botId: bot.id, canonicalBotChat: true }
  };
}

function stackBody(sessionId: string) {
  return {
    sessionId,
    blocks: [{
      id: 'live-user',
      kind: 'user',
      label: '',
      text: '下一轮还没发送',
      tokens: 10,
      chars: 7,
      pinned: false,
      disposition: 'keep'
    }],
    budget: {
      mode: 'normal',
      windowTokens: 128000,
      capTokens: 25600,
      requestTokens: 10,
      pinnedTokens: 0,
      pinnedOverBudget: false,
      wouldSummarize: false,
      wouldCompact: false,
      ratio: 0.2,
      structuredTokens: null,
      hygieneTokens: null,
      historyTokens: null,
      messageTokens: 10
    }
  };
}

function historyBody(sessionId: string, turns: TurnMetric[]) {
  const requests = turns.map((turn) => {
    const windowTokens = turn.windowTokens ?? WINDOW;
    const actual = turn.actualInputTokens === undefined ? null : turn.actualInputTokens;
    return {
      sessionId,
      turn: turn.turn,
      turnNumber: turn.turn,
      sentAt: turn.sentAt,
      sentAtLabel: turn.sentAt,
      estimatedTokens: turn.estimatedTokens,
      windowTokens,
      windowPercent: windowTokens > 0 ? (turn.estimatedTokens / windowTokens) * 100 : null,
      actualInputTokens: actual,
      upstreamInputTokens: actual
    };
  });
  return {
    sessionId,
    snapshots: turns.map((turn) => ({
      id: `${sessionId}-snap-${turn.turn}`,
      turn: turn.turn,
      createdAt: turn.sentAt,
      blocks: [{
        id: `${sessionId}-block-${turn.turn}`,
        kind: 'user',
        label: '',
        text: `turn-${turn.turn}`,
        tokens: 12,
        chars: 6,
        pinned: false,
        disposition: 'keep'
      }],
      estimatedTokens: turn.estimatedTokens,
      windowTokens: turn.windowTokens ?? WINDOW,
      actualInputTokens: turn.actualInputTokens === undefined ? null : turn.actualInputTokens,
      sentAt: turn.sentAt
    })),
    requests,
    latestRequest: requests.at(-1) ?? null
  };
}

async function installChats(page: Page, chats: ChatFixture[]) {
  await page.addInitScript(() => {
    localStorage.setItem('lab.locale', 'zh');
    localStorage.setItem('theme', 'light');
    localStorage.removeItem('lab.selectedBot');
  });
  const bots = chats.map(botFor);
  const sessions = chats.map(sessionFor);
  await mockGet(page, 'bots', { bots });
  await mockGet(page, 'bot-functional-groups', { groups: [] });
  await mockGet(page, 'bot-rooms', { rooms: [] });
  await mockGet(page, 'sessions', { sessions });
  for (const chat of chats) {
    const bot = botFor(chat);
    const session = sessionFor(chat);
    const history = historyBody(chat.id, chat.turns);
    await page.route(pathPattern(`bots/${bot.id}/open`), (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return fulfill(route, { bot, session });
    });
    await mockGet(page, `sessions/${chat.id}`, { session, messages: [], latestAssistant: '' });
    await mockGet(page, `sessions/${chat.id}/goal`, { goal: null });
    await mockGet(page, `sessions/${chat.id}/context-stack`, stackBody(chat.id));
    await page.route(pathPattern(`sessions/${chat.id}/context-snapshots`), (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const latestOnly = new URL(route.request().url()).searchParams.get('latestOnly') === '1';
      if (latestOnly) return fulfill(route, { sessionId: chat.id, snapshots: [], latestRequest: history.latestRequest });
      return fulfill(route, history);
    });
  }
}

async function openContext(page: Page, name: string) {
  await page.locator('.session-item__title', { hasText: name }).first().click();
  await expect(page.locator('#playInput')).toBeVisible();
  await page.getByRole('tab', { name: '上下文', exact: true }).click();
  await expect(page.getByTestId('latest-request-metric')).toBeVisible();
  await expect(page.getByRole('slider', { name: '上下文时间' })).toBeVisible();
}

async function showChat(page: Page, current: ChatFixture, other?: ChatFixture) {
  await installChats(page, other ? [other, current] : [current]);
  await page.goto('/#/bot');
  if (other) {
    await openContext(page, other.name);
    const marker = other.turns.at(-1)?.estimatedTokens.toLocaleString('zh-CN');
    if (marker) await expect(page.getByTestId('latest-request-metric')).toContainText(marker);
  }
  await openContext(page, current.name);
}

async function scrubTo(page: Page, index: number, label: string) {
  const scrub = page.getByRole('slider', { name: '上下文时间' });
  await expect(scrub).toBeEnabled();
  await scrub.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
  await expect(page.locator('.context-stack__replay-label')).toContainText(label);
}

function metricOf(page: Page) {
  return page.getByTestId('latest-request-metric');
}

async function expectNoPanelError(page: Page) {
  const panel = page.locator('.context-stack');
  await expect(panel).not.toContainText('读取上下文失败');
  await expect(panel).not.toContainText('回放记录读取失败');
  await expect(metricOf(page)).not.toContainText('无法读取最近请求统计');
}

const threeTurns: TurnMetric[] = [
  { turn: 1, estimatedTokens: 111000, actualInputTokens: 101000, sentAt: '2026-10-21T01:00:00.000Z' },
  { turn: 2, estimatedTokens: 222000, actualInputTokens: 202000, sentAt: '2026-10-21T02:00:00.000Z' },
  { turn: 3, estimatedTokens: 333000, actualInputTokens: 303000, sentAt: '2026-10-21T03:00:00.000Z' }
];

test('拖到较早两轮时 token 分别变成这两轮的发送估算 [AC:request-metric-follows-turn#AC-1]', async ({ page }) => {
  await showChat(page, { id: 'metric-three', name: 'Metric Three', turns: threeTurns });
  const metric = metricOf(page);
  await expect(metric).toContainText('333,000');
  await scrubTo(page, 0, '第 1 次');
  await expect(metric).toContainText('111,000');
  await expect(metric).not.toContainText('333,000');
  await expect(metric).not.toContainText('222,000');
  await scrubTo(page, 1, '第 2 次');
  await expect(metric).toContainText('222,000');
  await expect(metric).not.toContainText('111,000');
  await expect(metric).not.toContainText('333,000');
});

test('停在某一轮时占比、上游用量和发送时间都换成这一轮 [AC:request-metric-follows-turn#AC-2]', async ({ page }) => {
  await showChat(page, { id: 'metric-fields', name: 'Metric Fields', turns: threeTurns });
  const metric = metricOf(page);
  await scrubTo(page, 0, '第 1 次');
  await expect(metric).toContainText('第 1 次');
  await expect(metric).not.toContainText('最近一次已发送请求');
  await expect(metric).toContainText('111,000');
  await expect(metric).toContainText('11.1%');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('101,000');
  await expect(metric.locator('time')).toHaveAttribute('dateTime', '2026-10-21T01:00:00.000Z');
  await expect(metric).not.toContainText('22.2%');
  await expect(metric).not.toContainText('33.3%');
  await expect(metric).not.toContainText('202,000');
  await expect(metric).not.toContainText('303,000');
});

test('拖到当前最新时恢复最近一次已发送请求 [AC:request-metric-follows-turn#AC-3]', async ({ page }) => {
  await showChat(page, { id: 'metric-live', name: 'Metric Live', turns: threeTurns });
  const metric = metricOf(page);
  await expect(metric).toContainText('333,000');
  await scrubTo(page, 0, '第 1 次');
  await expect(metric).toContainText('111,000');
  await scrubTo(page, threeTurns.length, '当前 · 最新');
  await expect(page.locator('.context-stack__replay-label')).toHaveText('当前 · 最新');
  await expect(metric).toContainText('最近一次已发送请求');
  await expect(metric).toContainText('333,000');
  await expect(metric).toContainText('33.3%');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('303,000');
  await expect(metric.locator('time')).toHaveAttribute('dateTime', '2026-10-21T03:00:00.000Z');
  await expect(page.getByText('下一轮预览（估算）')).toBeVisible();
  await expect(metric).not.toContainText('111,000');
});

test('没有上游用量的一轮显示未知且不借用另一轮 [AC:request-metric-follows-turn#AC-4]', async ({ page }) => {
  const turns: TurnMetric[] = [
    { turn: 1, estimatedTokens: 410000, windowTokens: 820000, actualInputTokens: null, sentAt: '2026-10-21T04:10:00.000Z' },
    { turn: 2, estimatedTokens: 420000, windowTokens: 700000, actualInputTokens: 777000, sentAt: '2026-10-21T05:20:00.000Z' }
  ];
  await showChat(page, { id: 'metric-unknown', name: 'Metric Unknown', turns });
  const metric = metricOf(page);
  await scrubTo(page, 0, '第 1 次');
  await expect(metric).toContainText('410,000');
  await expect(metric).toContainText('50.0%');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('未知');
  await expect(metric.locator('time')).toHaveAttribute('dateTime', '2026-10-21T04:10:00.000Z');
  await expect(metric).not.toContainText('777');
  await expect(metric).not.toContainText('420,000');
  await expect(metric).not.toContainText('60.0%');
});

test('拖动后不必刷新且停住时不跳回最近一次 [AC:request-metric-follows-turn#AC-5]', async ({ page }) => {
  await showChat(page, { id: 'metric-stay', name: 'Metric Stay', turns: threeTurns });
  const metric = metricOf(page);
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
  await scrubTo(page, 1, '第 2 次');
  await expect(metric).toContainText('222,000', { timeout: 1000 });
  await expect(metric).toContainText('22.2%');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('202,000');
  await expect(metric.locator('time')).toHaveAttribute('dateTime', '2026-10-21T02:00:00.000Z');
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(400);
    await expect(metric).toContainText('222,000');
    await expect(metric).not.toContainText('333,000');
    await expect(page.locator('.context-stack__replay-label')).toContainText('第 2 次');
  }
});

test('只有一轮时两种位置都是这一轮且不串到另一条对话 [AC:request-metric-follows-turn#AC-6]', async ({ page }) => {
  const current: ChatFixture = {
    id: 'metric-only',
    name: 'Metric Only',
    turns: [{ turn: 1, estimatedTokens: 610000, actualInputTokens: 61000, sentAt: '2026-10-21T06:00:00.000Z' }]
  };
  const other: ChatFixture = {
    id: 'metric-other',
    name: 'Metric Other',
    turns: [{ turn: 1, estimatedTokens: 980000, actualInputTokens: 98000, sentAt: '2026-10-21T09:30:00.000Z' }]
  };
  await showChat(page, current, other);
  await expectNoPanelError(page);
  const metric = metricOf(page);
  await expect(metric).toContainText('610,000');
  await expect(metric).not.toContainText('980,000');
  await expect(metric).not.toContainText('98,000');
  await scrubTo(page, 0, '第 1 次');
  await expectNoPanelError(page);
  await expect(metric).toContainText('610,000');
  await expect(metric).toContainText('61.0%');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('61,000');
  await expect(metric.locator('time')).toHaveAttribute('dateTime', '2026-10-21T06:00:00.000Z');
  await expect(metric).not.toContainText('980');
  await scrubTo(page, 1, '当前 · 最新');
  await expect(metric).toContainText('最近一次已发送请求');
  await expect(metric).toContainText('610,000');
  await expect(metric).toContainText('61.0%');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('61,000');
  await expect(metric.locator('time')).toHaveAttribute('dateTime', '2026-10-21T06:00:00.000Z');
  await expect(metric).not.toContainText('980');
});

test('还没有请求时等待且不显示发送时间或其他对话数字 [AC:request-metric-follows-turn#AC-7]', async ({ page }) => {
  const current: ChatFixture = { id: 'metric-empty', name: 'Metric Empty', turns: [] };
  const other: ChatFixture = {
    id: 'metric-filled',
    name: 'Metric Filled',
    turns: [{ turn: 1, estimatedTokens: 980000, actualInputTokens: 98000, sentAt: '2026-10-21T09:30:00.000Z' }]
  };
  await showChat(page, current, other);
  await expectNoPanelError(page);
  const metric = metricOf(page);
  await expect(metric).toContainText('等待请求');
  await expect(metric.locator('p', { hasText: '模型窗口占比' })).toContainText('未知');
  await expect(metric.locator('p', { hasText: '上游输入用量' })).toContainText('未知');
  await expect(metric).not.toContainText('发送时间');
  await expect(metric.locator('time')).toHaveCount(0);
  await expect(metric).not.toContainText('980');
  await expect(page.locator('.context-stack')).not.toContainText('980');
});
