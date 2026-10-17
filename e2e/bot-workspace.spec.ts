import { test, expect, type APIRequestContext } from "@playwright/test";

test("team work, history, rooms and software have real product entry points [AC:default-super-bot#AC-3] [AC:bot-history-memory#AC-1] [AC:bot-rooms#AC-1] [AC:bot-software-execution#AC-3]", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/bots", {
    data: { name: `Workspace ${Date.now()}` },
  });
  expect(response.status()).toBe(201);
  const { bot } = await response.json();
  await page.goto("/#/agents/bots");
  await expect(page.getByTestId("bot-team-work")).toBeVisible();
  await expect(page.getByTestId("bot-rooms")).toBeVisible();
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await expect(page.getByTestId("bot-history")).toBeVisible();
  await expect(page.getByTestId("bot-connections")).toBeVisible();
  await page
    .getByTestId("bot-history-query")
    .fill("missing exact historical phrase");
  await page.getByTestId("bot-history-search").click();
  await expect(page.getByTestId("bot-history-empty")).toBeVisible();
});

test("create and reopen a room with persistent membership [AC:bot-rooms#AC-1] [AC:bot-rooms#AC-4]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", {
      data: { name: `Room member ${Date.now()}` },
    })
  ).json();
  await page.goto("/#/agents/bots");
  const rooms = page.getByTestId("bot-rooms");
  await rooms.getByTestId("room-title").fill(`Room ${bot.id}`);
  await rooms.getByTestId("room-members").selectOption([bot.id]);
  await rooms.getByTestId("room-create").click();
  await expect(rooms.getByTestId("room-selected-title")).toHaveText(
    `Room ${bot.id}`,
  );
  await rooms.getByTestId("room-stop").click();
  await expect(rooms.getByTestId("room-status")).toHaveText(/已暂停/);
  await page.reload();
  await rooms
    .getByRole("button", { name: `Room ${bot.id}`, exact: true })
    .click();
  await expect(rooms.getByTestId("room-status")).toHaveText(/已暂停/);
});

test("schedule a one-time job and inspect its durable run history [AC:bot-routine-lifecycle#AC-4]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", { data: { name: `Routine ${Date.now()}` } })
  ).json();
  await page.goto("/#/agents/bots");
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page
    .getByTestId("bot-detail")
    .getByRole("button", { name: "展开或收起：定时任务" })
    .click();
  const panel = page.locator(".bot-cron-panel");
  await panel.getByLabel("名称", { exact: true }).fill(`Once ${bot.id}`);
  await panel
    .getByLabel("任务内容", { exact: false })
    .fill("Record a deterministic scheduled task");
  await panel.getByLabel("计划类型").selectOption("once");
  const future = new Date(Date.now() + 86400000);
  const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await panel.getByLabel("执行时间").fill(local);
  await panel.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await panel.locator("button[type=submit]").click();
  await expect(
    panel.locator("article").filter({ hasText: `Once ${bot.id}` }),
  ).toBeVisible();
  const jobs = await (
    await request.get(`/api/cron/jobs?botId=${bot.id}`)
  ).json();
  expect(jobs.jobs).toHaveLength(1);
  expect(jobs.jobs[0].scheduleKind).toBe("once_at");
  await panel.getByRole("button", { name: "运行记录", exact: true }).click();
  await expect(panel.getByText("暂无记录", { exact: true })).toBeVisible();
});

test("import a Bot software connection and revoke it persistently [AC:bot-software-execution#AC-3]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", {
      data: { name: `Software ${Date.now()}` },
    })
  ).json();
  await page.goto("/#/agents/bots");
  await page.getByTestId(`bot-card-${bot.id}`).click();
  const panel = page.getByTestId("bot-connections");
  await panel.getByLabel("连接标识").fill("e2e-weather");
  await panel.getByLabel("OpenAPI 文档（JSON）").fill(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Weather", version: "1" },
      servers: [{ url: "https://example.com" }],
      paths: {
        "/weather": {
          get: {
            operationId: "readWeather",
            responses: { 200: { description: "OK" } },
          },
        },
      },
    }),
  );
  await panel.getByRole("button", { name: "导入连接", exact: true }).click();
  await expect(
    panel.getByRole("heading", { name: "e2e-weather" }),
  ).toBeVisible();
  await page.reload();
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await expect(
    panel.getByRole("heading", { name: "e2e-weather" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "撤销连接", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "e2e-weather" })).toHaveCount(
    0,
  );
  const result = await (
    await request.get(`/api/bots/${bot.id}/connections`)
  ).json();
  expect(result.connections).toHaveLength(0);
});

test("search older original text and open surrounding history [AC:bot-history-memory#AC-1] [AC:bot-history-memory#AC-2]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", { data: { name: `History ${Date.now()}` } })
  ).json();
  const { session } = await (
    await request.post(`/api/bots/${bot.id}/open`)
  ).json();
  for (let i = 0; i < 55; i++) {
    const result = await request.post(`/api/sessions/${session.id}/messages`, {
      data: {
        message:
          i === 0 ? "Original historical anchor 77331" : `Historical item ${i}`,
        autoRun: false,
      },
    });
    expect(result.ok()).toBeTruthy();
  }
  await page.goto("/#/agents/bots");
  await page.getByTestId(`bot-card-${bot.id}`).click();
  const panel = page.getByTestId("bot-history");
  await expect(
    panel.getByText("Original historical anchor 77331", { exact: false }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "加载更早记录", exact: true })
    .click();
  await expect(
    panel.getByText(/Original historical anchor 77331/),
  ).toBeVisible();
  await panel
    .getByTestId("bot-history-query")
    .fill("Original historical anchor 77331");
  await panel.getByTestId("bot-history-search").click();
  await expect(panel.locator("article")).toHaveCount(1);
  await panel.getByRole("button", { name: "查看上下文", exact: true }).click();
  await expect(
    panel
      .getByRole("complementary", { name: "查看上下文" })
      .getByText(/Historical item 1/),
  ).toBeVisible();
});

test("default Super Bot is selected and a saved alternative survives reload [AC:default-super-bot#AC-1] [AC:default-super-bot#AC-2]", async ({
  page,
  request,
}) => {
  const { bot: superBot } = await (
    await request.get("/api/bot-work/default")
  ).json();
  const { bot } = await (
    await request.post("/api/bots", {
      data: { name: `Preferred ${Date.now()}` },
    })
  ).json();
  await page.goto("/");
  await page.locator("#nav-bot").click();
  await expect(page.locator("#botSelect")).toHaveValue(superBot.id);
  await page.locator("#botSelect").selectOption(bot.id);
  await expect(page.locator("#botSelect")).toHaveValue(bot.id);
  await page.reload();
  await expect(page.locator("#botSelect")).toHaveValue(bot.id);
});

test("assign work through Super Bot and inspect the persisted result [AC:default-super-bot#AC-5] [AC:default-super-bot#AC-8]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", { data: { name: `Worker ${Date.now()}` } })
  ).json();
  await page.goto("/#/agents/bots");
  const panel = page.getByTestId("bot-team-work");
  await panel.getByLabel("目标 Bot").selectOption(bot.id);
  await panel.getByLabel("工作内容").fill("Reply with the word ready.");
  await panel.getByRole("button", { name: "分派任务", exact: true }).click();
  await expect(
    panel.locator("article").filter({ hasText: bot.name }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const { tasks } = await (await request.get("/api/bot-work/tasks")).json();
      return tasks.find(
        (task: { targetBotId: string }) => task.targetBotId === bot.id,
      )?.status;
    })
    .toBe("completed");
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await panel
    .locator("article")
    .filter({ hasText: bot.name })
    .getByRole("button", { name: "详情", exact: true })
    .click();
  await expect(
    panel.getByRole("complementary").getByText("已完成", { exact: true }),
  ).toBeVisible();
});

test("group reply is shown automatically and stays out of private chat [AC:bot-rooms#AC-2] [AC:bot-rooms#AC-3]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", {
      data: { name: `Group speaker ${Date.now()}` },
    })
  ).json();
  const { room } = await (
    await request.post("/api/bot-rooms", {
      data: {
        title: `Discussion ${bot.id}`,
        botIds: [bot.id],
        hostBotId: bot.id,
        maxBotTurns: 2,
      },
    })
  ).json();
  await page.goto("/#/agents/bots");
  const panel = page.getByTestId("bot-rooms");
  await panel.getByRole("button", { name: room.title, exact: true }).click();
  await panel
    .getByLabel("群消息", { exact: true })
    .fill("Group-only anchor 93371. Reply ready.");
  await panel.getByLabel("提及成员（可多选）").selectOption([bot.id]);
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    panel.getByRole("log").getByText(bot.name, { exact: true }),
  ).toBeVisible();
  const history = await (
    await request.get(
      `/api/sessions/${bot.canonicalSessionId}/history?query=Group-only`,
    )
  ).json();
  expect(history.messages).toHaveLength(0);
});

test("Bot chat opens a bounded history page and loads older messages [AC:bot-history-memory#AC-2]", async ({
  page,
  request,
}) => {
  const { bot } = await (
    await request.post("/api/bots", {
      data: { name: `Paged chat ${Date.now()}` },
    })
  ).json();
  const { session } = await (
    await request.post(`/api/bots/${bot.id}/open`)
  ).json();
  for (let i = 0; i < 55; i++)
    await request.post(`/api/sessions/${session.id}/messages`, {
      data: { message: `Paged conversational item ${i}`, autoRun: false },
    });
  const modelViewRequests:string[]=[];page.on('request',request=>{if(request.url().includes('/model-view'))modelViewRequests.push(request.url());});
  await page.goto("/#/agents/bots");
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page
    .getByTestId("bot-detail")
    .getByRole("button", { name: "打开对话", exact: true })
    .click();
  await expect(
    page
      .locator("#playMessages")
      .getByText("Paged conversational item 0", { exact: true }),
  ).toHaveCount(0);
  const older = page.waitForResponse((res) => res.url().includes("beforeSeq="));
  // Sticky older control stays clickable while the windowed feed is stuck to the tail.
  await page.locator("#playMessages").getByTestId("feed-load-older").click();
  await older;
  await expect
    .poll(async () => {
      await page.locator("#playMessages").evaluate((el) => {
        el.scrollTop = 0;
      });
      return page.locator("#playMessages").getByText("Paged conversational item 0", { exact: true }).count();
    })
    .toBeGreaterThan(0);
  expect(modelViewRequests).toHaveLength(0);
});

test('edit and delete private Bot memory while retaining its history source [AC:bot-history-memory#AC-3]',async({page,request})=>{
 const {bot}=await(await request.post('/api/bots',{data:{name:`Memory ${Date.now()}`}})).json();
 const {session}=await(await request.post(`/api/bots/${bot.id}/open`)).json();
 await request.post(`/api/sessions/${session.id}/messages`,{data:{message:'Source says favorite color is green.',autoRun:false}});
 const {messages}=await(await request.get(`/api/sessions/${session.id}/history`)).json();
 const source=messages.find((message:{role:string})=>message.role==='user');
 const created=await request.post('/api/memory',{data:{scope:'user.memory',agentId:bot.id,key:'favorite-color',value:'green',sourceRefs:[{sessionId:session.id,messageId:source.id,seq:source.seq}]}});expect(created.ok()).toBeTruthy();
 await page.goto('/#/agents/bots');await page.getByTestId(`bot-card-${bot.id}`).click();const panel=page.getByTestId('bot-memory');
 await expect(panel.getByText('green',{exact:true})).toBeVisible();
 await panel.getByRole('button',{name:/记忆来源/}).click();await expect(panel.getByText(/Source says favorite color is green/)).toBeVisible();
 await panel.getByRole('button',{name:'修改',exact:true}).click();await panel.getByRole('textbox').fill('blue');await panel.getByRole('button',{name:'保存',exact:true}).click();await expect(panel.getByText('blue',{exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'移除',exact:true}).click();await expect(panel.getByText('暂无记录',{exact:true})).toBeVisible();
 const original=await(await request.get(`/api/sessions/${session.id}/history?query=favorite`)).json();expect(original.messages.length).toBeGreaterThan(0);
});

test('due one-time work reaches a completed run and its result is inspectable [AC:bot-routine-lifecycle#AC-1] [AC:bot-routine-lifecycle#AC-3]',async({page,request})=>{
 const {bot}=await(await request.post('/api/bots',{data:{name:`Due routine ${Date.now()}`}})).json();
 const created=await request.post('/api/cron/jobs',{data:{botId:bot.id,name:`Due ${bot.id}`,prompt:'Reply ready.',onceAt:new Date(Date.now()+500).toISOString(),timezone:'Asia/Shanghai',missedPolicy:'coalesce'}});expect(created.ok()).toBeTruthy();const {job}=await created.json();
 await expect.poll(async()=>{const {runs}=await(await request.get(`/api/cron/jobs/${job.id}/runs`)).json();return runs[0]?.status;},{timeout:30000}).toBe('completed');
 await page.goto('/#/agents/bots');await page.getByTestId(`bot-card-${bot.id}`).click();await page.getByTestId('bot-detail').getByRole('button',{name:'展开或收起：定时任务'}).click();const panel=page.locator('.bot-cron-panel');await panel.getByRole('button',{name:'运行记录',exact:true}).click();await expect(panel.getByText('已完成',{exact:true})).toBeVisible();await panel.getByRole('button',{name:'详情',exact:true}).click();await expect(panel.locator('pre')).toContainText('completed');
 const {runs}=await(await request.get(`/api/cron/jobs/${job.id}/runs`)).json();expect(runs[0].sessionId).not.toBe(bot.canonicalSessionId);expect(runs[0].result).toBeTruthy();
});

// Dedicated review fixtures are reused only by the same test across repeat-each runs.
// Bot deletion is not an API operation and hidden Bots still count toward the roster cap.
async function ensureReviewBot(request: APIRequestContext, name: string): Promise<{ id: string; name: string }> {
  const roster = await request.get('/api/bots');
  expect(roster.ok()).toBeTruthy();
  const { bots } = await roster.json();
  const existing = bots.find((bot: { name: string }) => bot.name === name);
  if (existing) return existing;
  const created = await request.post('/api/bots', { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json()).bot;
}

for (const routing of ['everyone', 'text-mention'] as const) {
  test(`Room routes ${routing} without selecting the mention list [AC:bot-rooms#AC-2]`, async ({ page, request }) => {
    const suffix = Date.now();
    const host = await ensureReviewBot(request, `E2E Review Host ${routing}`);
    const member = await ensureReviewBot(request, `E2E Review Member ${routing}`);
    const { room } = await (await request.post('/api/bot-rooms', { data: { title: `Routing ${routing} ${suffix}`, botIds: [host.id, member.id], hostBotId: host.id } })).json();
    await page.goto('/#/agents/bots');
    const panel = page.getByTestId('bot-rooms');
    await panel.getByRole('button', { name: room.title, exact: true }).click();
    await panel.getByLabel('群消息', { exact: true }).fill(routing === 'everyone' ? 'Reply ready.' : `@${member.id} Reply ready.`);
    const sent = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith(`/api/bot-rooms/${room.id}/messages`));
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    expect((await sent).postDataJSON()).not.toHaveProperty('mentions');
    const log = panel.getByRole('log');
    if (routing === 'everyone') {
      await expect(log.getByText(host.name, { exact: true })).toBeVisible({ timeout: 30000 });
      await expect(log.getByText(member.name, { exact: true })).toBeVisible();
    } else {
      // Mentioned member speaks first. The unmentioned host is still scheduled and may stay [SILENT].
      await expect(log.getByText(member.name, { exact: true })).toBeVisible({ timeout: 30000 });
    }
    await expect.poll(async () => {
      const { turns } = await (await request.get(`/api/bot-rooms/${room.id}/turns`)).json();
      return turns[0]?.botIds;
    }, { timeout: 30000 }).toEqual(routing === 'everyone' ? [host.id, member.id] : [member.id, host.id]);
    if (routing === 'text-mention') {
      const { turns } = await (await request.get(`/api/bot-rooms/${room.id}/turns`)).json();
      expect(turns[0].mentionedBotIds).toEqual([member.id]);
    }
  });
}

test('editing a routine can remove its existing precheck [AC:bot-routine-lifecycle#AC-4]', async ({ page, request }) => {
  const bot = await ensureReviewBot(request, 'E2E Review Clear Precheck');
  const { job } = await (await request.post('/api/cron/jobs', { data: { botId: bot.id, name: `Clear existing precheck ${Date.now()}`, prompt: 'Reply ready.', onceAt: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC', missedPolicy: 'coalesce', precheck: { kind: 'predicate', source: '{"wakeAgent":false}' } } })).json();
  await page.goto('/#/agents/bots');
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page.getByTestId('bot-detail').getByRole('button', { name: '展开或收起：定时任务' }).click();
  const panel = page.locator('.bot-cron-panel');
  await panel.locator('article').filter({ hasText: job.name }).getByRole('button', { name: '修改', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '预检', exact: true })).toHaveValue('predicate');
  await panel.getByRole('combobox', { name: '预检', exact: true }).selectOption('none');
  await panel.locator('button[type=submit]').click();
  await expect.poll(async () => {
    const { jobs } = await (await request.get(`/api/cron/jobs?botId=${bot.id}`)).json();
    return jobs.find((record: { id: string }) => record.id === job.id)?.metadata.precheck ?? null;
  }).toBeNull();
  await page.reload();
  await page.getByTestId(`bot-card-${bot.id}`).click();
  await page.getByTestId('bot-detail').getByRole('button', { name: '展开或收起：定时任务' }).click();
  await panel.locator('article').filter({ hasText: job.name }).getByRole('button', { name: '修改', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '预检', exact: true })).toHaveValue('none');
});

test('Room polling preserves access to messages across a missed page [AC:bot-rooms#AC-6]', async ({ page, request }) => {
  const bot = await ensureReviewBot(request, 'E2E Review Room Gap');
  const { room } = await (await request.post('/api/bot-rooms', { data: { title: `Gap ${bot.id} ${Date.now()}`, botIds: [bot.id] } })).json();
  // Pause so the burst stays user rows. A speaking member would insert replies and push item 1 past one older page.
  expect((await request.post(`/api/bot-rooms/${room.id}/stop`)).ok()).toBeTruthy();
  await request.post(`/api/bot-rooms/${room.id}/messages`, { data: { text: 'Room gap initial' } });
  await page.goto('/#/agents/bots');
  const panel = page.getByTestId('bot-rooms');
  await panel.getByRole('button', { name: room.title, exact: true }).click();
  await expect(panel.getByRole('log')).toContainText('Room gap initial');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/bot-rooms/${room.id}/messages?limit=50`, async route => { await held; await route.continue(); });
  try {
    for (let index = 1; index <= 100; index++) {
      const response = await request.post(`/api/bot-rooms/${room.id}/messages`, { data: { text: `Room gap item ${index}` } });
      expect(response.ok()).toBeTruthy();
    }
  } finally { release(); }
  await expect(panel.getByRole('log')).toContainText('Room gap item 100', { timeout: 30000 });
  await expect(panel.getByRole('log').getByText('Room gap item 1', { exact: true })).toHaveCount(0);
  const older = panel.getByRole('button', { name: '加载更早记录', exact: true });
  await expect.poll(async () => older.count(), { timeout: 30000 }).toBeGreaterThan(0);
  await older.click();
  await expect(panel.getByRole('log').getByText('Room gap item 1', { exact: true })).toBeVisible({ timeout: 30000 });
});

test('switching Rooms clears the previous room draft, mentions and attachments [AC:bot-rooms#AC-3]', async ({ page, request }) => {
  const rooms = [];
  for (const suffix of ['A', 'B']) {
    const bot = await ensureReviewBot(request, `E2E Review Scope ${suffix}`);
    const { room } = await (await request.post('/api/bot-rooms', { data: { title: `Scope ${bot.id} ${Date.now()}`, botIds: [bot.id] } })).json();
    rooms.push({ bot, room });
  }
  await page.goto('/#/agents/bots');
  const panel = page.getByTestId('bot-rooms');
  await panel.getByRole('button', { name: rooms[0].room.title, exact: true }).click();
  await panel.getByLabel('群消息', { exact: true }).fill('Draft for room A only');
  await panel.getByLabel('提及成员（可多选）').selectOption([rooms[0].bot.id]);
  // The existing attachment-reference field has a translated accessible name.
  await panel.getByLabel('附件引用（逗号分隔）').fill('room-a-attachment');
  await panel.getByRole('button', { name: rooms[1].room.title, exact: true }).click();
  await expect(panel.getByLabel('群消息', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('提及成员（可多选）')).toHaveValues([]);
  await expect(panel.getByLabel('附件引用（逗号分隔）')).toHaveValue('');
  await panel.getByLabel('群消息', { exact: true }).fill('Reply ready.');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.getByRole('log').getByText(rooms[1].bot.name, { exact: true })).toBeVisible({ timeout: 30000 });
});
