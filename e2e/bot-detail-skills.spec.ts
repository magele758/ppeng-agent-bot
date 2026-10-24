import { test, expect, type Page } from "@playwright/test";
const bots = [
  { id: "a", name: "Bot A", agentId: "general", canonicalSessionId: "sa" },
  { id: "b", name: "Bot B", agentId: "general", canonicalSessionId: "sb" },
];
async function setup(page: Page, long = false) {
  let policy = { mode: "all", ids: [] as string[] };
  let rows = [
    {
      id: "own",
      name: long ? "LongSkill".repeat(50) : "check",
      description: "health check",
      ownerBotId: "a",
      sharedBotIds: [],
      canManage: true,
      enabled: true,
      content: long ? "long-content-".repeat(500) : "# Own checks",
      revision: "r1",
    },
    {
      id: "shared",
      name: "check",
      description: "shared check",
      ownerBotId: "b",
      sharedBotIds: ["a"],
      canManage: false,
      enabled: true,
      content: "# Shared checks",
      revision: "r2",
    },
  ];
  await page.addInitScript(() => localStorage.setItem("lab.locale", "zh"));
  await page.route("**/api/bots", (r) => r.fulfill({ json: { bots } }));
  await page.route(/\/api\/bots\/[ab]\/open$/, (r) => {
    const b = bots.find((b) =>
      r
        .request()
        .url()
        .includes("/" + b.id + "/"),
    )!;
    return r.fulfill({
      json: { bot: b, session: { id: b.canonicalSessionId } },
    });
  });
  await page.route(/\/api\/sessions\/s[ab](?:\?|$)/, (r) =>
    r.fulfill({ json: { session: { metadata: {} }, messages: [] } }),
  );
  await page.route(/\/api\/bots\/[ab]\/skills$/, async (r) => {
    if (r.request().method() === "PATCH")
      policy = r.request().postDataJSON().policy;
    await r.fulfill({
      json: {
        skills: r.request().url().includes("/a/") ? rows : [],
        policy,
        revision: "v1",
        operations: [],
      },
    });
  });
  await page.goto("/#/agents/bots?botId=a");
  await page.getByText("Bot A", { exact: true }).first().click();
  await page
    .getByTestId("bot-detail")
    .getByRole("tab", { name: "技能", exact: true })
    .click();
  return { panel: page.getByTestId("bot-detail-skills"), policy: () => policy };
}
test("available catalog, duplicate names and readonly body [AC:bot-detail-skill-management#AC-1] [AC:bot-detail-skill-management#AC-2] [AC:bot-detail-skill-management#AC-5]", async ({
  page,
}) => {
  const { panel } = await setup(page);
  await expect(panel.getByTestId("skill-row-own")).toBeVisible();
  const row = panel.getByTestId("skill-row-shared");
  await expect(row).toContainText("只读");
  await expect(
    row.getByRole("button", { name: "撤销", exact: true }),
  ).toHaveCount(0);
  await row.locator("summary").click();
  await expect(row).toContainText("# Shared checks");
  await panel.getByLabel("搜索技能").fill("health");
  await expect(row).toHaveCount(0);
});
test("selected empty is saved explicitly and survives reload [AC:bot-detail-skill-management#AC-3]", async ({
  page,
}) => {
  const { panel, policy } = await setup(page);
  await panel.getByLabel("技能使用范围").selectOption("selected");
  await panel.getByRole("button", { name: "保存使用范围" }).click();
  await expect.poll(policy).toEqual({ mode: "selected", ids: [] });
  await page.reload();
  await page.getByText("Bot A", { exact: true }).first().click();
  await page
    .getByTestId("bot-detail")
    .getByRole("tab", { name: "技能", exact: true })
    .click();
  await expect(panel.getByLabel("技能使用范围")).toHaveValue("selected");
});
test("share and revoke show affected Bots [AC:bot-detail-skill-management#AC-4] [AC:bot-detail-skill-management#AC-6]", async ({
  page,
}) => {
  let action: any;
  await page.route("**/api/bots/a/skills/manage", (r) => {
    action = r.request().postDataJSON();
    return r.fulfill({ json: { status: "saved" } });
  });
  const { panel } = await setup(page);
  const row = panel.getByTestId("skill-row-own");
  await row.getByLabel("Bot B", { exact: true }).check();
  await row.getByRole("button", { name: "保存共享范围" }).click();
  await expect.poll(() => action?.botIds).toEqual(["b"]);
  page.once("dialog", async (d) => {
    expect(d.message()).toContain("Bot A");
    await d.accept();
  });
  await row.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(() => action?.action).toBe("delete");
  await expect(panel).toContainText("历史对话");
});
test("empty search recoverable [AC:bot-detail-skill-management#AC-7]", async ({
  page,
}) => {
  const { panel } = await setup(page);
  await panel.getByLabel("搜索技能").fill("absent");
  await expect(panel).toContainText("没有匹配的技能");
  await panel.getByRole("button", { name: "清除搜索" }).click();
  await expect(panel.getByTestId("skill-row-own")).toBeVisible();
});
test("failed save preserves selection and allows retry [AC:bot-detail-skill-management#AC-8]", async ({
  page,
}) => {
  const { panel } = await setup(page);
  await page.route("**/api/bots/a/skills", (r) =>
    r.request().method() === "PATCH"
      ? r.fulfill({ status: 409, json: { error: "Settings changed" } })
      : r.fallback(),
  );
  await panel.getByLabel("技能使用范围").selectOption("selected");
  await panel.getByRole("button", { name: "保存使用范围" }).click();
  await expect(panel.getByRole("alert")).toContainText("Settings changed");
  await expect(panel.getByLabel("技能使用范围")).toHaveValue("selected");
  await expect(panel).toContainText("尚未保存");
});
test("switching Bots does not carry drafts or save [AC:bot-detail-skill-management#AC-9]", async ({
  page,
}) => {
  const { panel, policy } = await setup(page);
  await panel.getByLabel("技能使用范围").selectOption("selected");
  await expect(panel).toContainText("尚未保存");
  await page.locator(".ag-card").filter({ hasText: "Bot B" }).click();
  await page
    .getByTestId("bot-detail")
    .getByRole("tab", { name: "技能", exact: true })
    .click();
  await expect(panel.getByLabel("技能使用范围")).toHaveValue("all");
  expect(policy().mode).toBe("all");
});

test("one operation confirmation completes without body review [AC:agent-skill-management#AC-2] [AC:agent-skill-management#AC-4] [AC:agent-skill-management#AC-8]", async ({
  page,
}) => {
  const session = {
    id: "manage-ui",
    title: "Manage UI",
    mode: "chat",
    status: "idle",
    agentId: "general",
  };
  const row = {
    id: "sm_ui",
    name: "check",
    affectedBotIds: ["a", "b"],
    input: { action: "share", reason: "Reusable checks" },
    status: "pending",
  };
  let confirmations = 0;
  await page.route("**/api/bots", (r) => r.fulfill({ json: { bots } }));
  await page.route("**/api/sessions", (r) =>
    r.fulfill({ json: { sessions: [session] } }),
  );
  await page.route(/\/api\/sessions\/manage-ui(?:\?|$)/, (r) =>
    r.fulfill({ json: { session, messages: [] } }),
  );
  await page.route("**/api/sessions/manage-ui/skill-operations", (r) =>
    r.fulfill({ json: { operations: [row] } }),
  );
  await page.route(
    "**/api/sessions/manage-ui/skill-operations/sm_ui/confirm",
    (r) => {
      confirmations++;
      row.status = "saved";
      return r.fulfill({ json: { operation: row } });
    },
  );
  await page.goto("/#/chat");
  await page
    .getByRole("button", { name: /Manage UI/ })
    .first()
    .click();
  const card = page.getByRole("dialog", { name: "技能管理建议" });
  await expect(card).toContainText("Bot B");
  await card.getByRole("button", { name: "确认并执行" }).click();
  await expect(card).toContainText("已完成");
  await expect(card.getByRole("button", { name: "确认并执行" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "关闭提示", exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
});

test("chat detail exposes and manages current Bot skills [AC:bot-detail-skill-management#AC-1] [AC:bot-detail-skill-management#AC-3]", async ({ page }) => {
  const { policy } = await setup(page);
  await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: bots.map(b => ({ id: b.canonicalSessionId, title: b.name, agentId: b.agentId, status: 'idle', mode: 'chat', metadata: { botId: b.id } })) } }));
  await page.goto('/#/bot');
  await page.reload();
  await page.getByRole('button', { name: /^Bot A/ }).first().click();
  const sidebar = page.getByTestId('bot-detail-panel');
  if (!(await sidebar.isVisible())) await page.getByTestId('bot-detail-toggle').click();
  await sidebar.getByRole('tab', { name: '技能', exact: true }).click({ timeout: 5000 });
  await expect(sidebar.getByTestId('skill-row-own')).toBeVisible();
  await expect(sidebar.getByTestId('skill-row-shared')).toContainText('只读');
  await sidebar.getByLabel('技能使用范围').selectOption('selected');
  await sidebar.getByRole('button', { name: '保存使用范围' }).click();
  await expect.poll(policy).toEqual({ mode: 'selected', ids: [] });
  await expect(page).toHaveURL(/#\/bot$/);
});

test('chat detail close icon works on narrow screens [AC:bot-detail-menu#AC-7]', async ({ page }) => {
  await setup(page);
  await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: bots.map(b => ({ id: b.canonicalSessionId, title: b.name, agentId: b.agentId, status: 'idle', mode: 'chat', metadata: { botId: b.id } })) } }));
  await page.setViewportSize({ width: 823, height: 804 });
  await page.goto('/#/bot');
  await page.reload();
  await page.getByRole('button', { name: /^Bot A/ }).first().click();
  const sidebar = page.getByTestId('bot-detail-panel');
  if (!(await sidebar.isVisible())) await page.getByTestId('bot-detail-toggle').click();
  await sidebar.getByTestId('bot-detail-close').click({ timeout: 5000 });
  await expect(sidebar).toHaveCount(0);
  await page.getByTestId('bot-detail-toggle').click();
  await expect(sidebar).toBeVisible();
});

for (const width of [1280, 820]) test(`skills controls stay grouped at every font size at ${width} [AC:bot-skill-panel-layout#AC-1] [AC:bot-skill-panel-layout#AC-2] [AC:bot-skill-panel-layout#AC-3] [AC:bot-skill-panel-layout#AC-4]`, async ({page}) => {
  await page.setViewportSize({width,height:804});
  const {policy}=await setup(page, true);
  await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:bots.map(b=>({id:b.canonicalSessionId,title:b.name,agentId:b.agentId,status:'idle',mode:'chat',metadata:{botId:b.id}}))}}));
  await page.goto('/#/bot'); await page.reload();await page.getByRole('button',{name:/^Bot A/}).first().click();
  const drawer=page.getByTestId('bot-detail-panel');await expect(drawer.or(page.getByTestId('bot-detail-toggle')).first()).toBeVisible();if(!await drawer.isVisible()) await page.getByTestId('bot-detail-toggle').click();
  await drawer.getByRole('tab',{name:'技能',exact:true}).click();
  const panel=drawer.getByTestId('bot-detail-skills');
  for(const size of [13,14,15,16,18]){
    await page.evaluate(size=>document.documentElement.setAttribute('data-font-size',String(size)),size);
    const select=panel.getByLabel('技能使用范围'),search=panel.getByLabel('搜索技能'),save=panel.getByRole('button',{name:'保存使用范围'});
    await expect(search).toBeVisible();
    const label=search.locator('..');
    expect(await label.evaluate(el=>{const range=document.createRange();range.selectNode(el.firstChild!);return range.getClientRects().length;})).toBe(1);
    const a=await save.boundingBox(),b=await search.boundingBox();expect(b!.y).toBeGreaterThanOrEqual(a!.y+a!.height);
    for(const control of [select,search,save,panel.getByRole('button',{name:'清除搜索'})]){
      const box=await control.boundingBox(),outer=await drawer.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(outer!.x);expect(box!.x+box!.width).toBeLessThanOrEqual(outer!.x+outer!.width);
      expect(await control.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    }
  }
  const longRow=panel.getByTestId('skill-row-own');
  await longRow.locator('summary').click();
  expect(await longRow.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await expect(longRow.locator('pre')).toBeVisible();
  await panel.getByLabel('技能使用范围').selectOption('selected');
  await panel.getByTestId('skill-row-own').getByRole('checkbox').first().check();
  await panel.getByLabel('搜索技能').fill('absent');await expect(panel).toContainText('没有匹配');
  await panel.getByRole('button',{name:'清除搜索'}).focus();await page.keyboard.press('Enter');
  await expect(panel.getByTestId('skill-row-own').getByRole('checkbox').first()).toBeChecked();
  await page.route('**/api/bots/a/skills',r=>r.request().method()==='PATCH'?r.fulfill({status:409,json:{error:'Save conflict'}}):r.fallback());
  await panel.getByRole('button',{name:'保存使用范围'}).click();await expect(panel.getByRole('alert')).toContainText('Save conflict');await expect(panel).toContainText('尚未保存');
  expect(policy().mode).toBe('all');
});

test('English skill controls preserve selection through search and save [AC:bot-skill-panel-layout#AC-4]', async ({page}) => {
 const {panel,policy}=await setup(page);
 await page.evaluate(()=>localStorage.setItem('lab.locale','en'));
 await page.addInitScript(()=>localStorage.setItem('lab.locale','en'));
 await page.reload();await page.getByText('Bot A',{exact:true}).first().click();
 await page.getByTestId('bot-detail').getByRole('tab',{name:'Skills',exact:true}).click();
 const select=panel.locator('select').first();await select.selectOption('selected');
 const own=panel.getByTestId('skill-row-own').getByRole('checkbox').first();await own.check();
 const search=panel.locator('input:not([type="checkbox"])').first();await search.fill('absent');
 await panel.getByRole('button',{name:'Clear search',exact:true}).click();await expect(own).toBeChecked();
 await panel.getByRole('button',{name:'Save selection',exact:true}).click();await expect.poll(policy).toEqual({mode:'selected',ids:['own']});
});
