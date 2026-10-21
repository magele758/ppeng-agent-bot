import { test, expect, type Page } from "@playwright/test";
const bots = [
  { id: "a", name: "Bot A", agentId: "general", canonicalSessionId: "sa" },
  { id: "b", name: "Bot B", agentId: "general", canonicalSessionId: "sb" },
];
async function setup(page: Page) {
  let policy = { mode: "all", ids: [] as string[] };
  let rows = [
    {
      id: "own",
      name: "check",
      description: "health check",
      ownerBotId: "a",
      sharedBotIds: [],
      canManage: true,
      enabled: true,
      content: "# Own checks",
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
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(confirmations).toBe(1);
});
