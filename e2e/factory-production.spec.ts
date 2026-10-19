import { test, expect, type Page } from "@playwright/test";
const initial = {
  environment: "local",
  host: "",
  entryUrl: "",
  visibility: "private",
  repository: "",
  repositoryNodeId: "",
  target: "main",
  workerIds: [],
  modelIds: [],
  connectionIds: [],
  sourceSha: "",
  daemonDigest: "",
  webDigest: "",
  maxTasks: 2,
  maxRounds: 8,
  maxCostUsd: 0,
  deadlineMs: 14400000,
  minFreeDiskGiB: 14,
  scopeConfirmed: false,
  publicConfirmed: false,
};
async function setup(page: Page, loseFirstCreate = false) {
  const createRequests: { requestKey: string; revision: string }[] = [];
  let settings = { ...initial, revision: "r1" },
    runs: any[] = [];
  const writes: any[] = [];
  await page.route("**/api/bots", (r) => r.fulfill({ json: { bots: [] } }));
  await page.route("**/api/bot-rooms", (r) =>
    r.fulfill({ json: { rooms: [] } }),
  );
  await page.route("**/api/factory/**", async (r) => {
    const u = new URL(r.request().url()),
      method = r.request().method(),
      path = u.pathname;
    if (path === "/api/factory/settings")
      return r.fulfill({
        json: {
          settings: {
            owner: { userId: "owner" },
            machines: [],
            roomId: "",
            coordinatorBotId: "",
            patrol: { enabled: false, timezone: "Asia/Shanghai" },
          },
        },
      });
    if (path === "/api/factory/board")
      return r.fulfill({ json: { machines: [], tasks: [] } });
    if (path === "/api/factory/patrol")
      return r.fulfill({ json: { settings: { enabled: false }, state: {} } });
    if (path === "/api/factory/development/decisions")
      return r.fulfill({ json: { tasks: [] } });
    if (path.endsWith("/production/settings")) {
      if (method === "PATCH") {
        settings = { ...r.request().postDataJSON(), revision: "r2" };
        writes.push(settings);
      }
      return r.fulfill({ json: { settings } });
    }
    if (path.endsWith("/production/preflight"))
      return r.fulfill({
        json: {
          ready: false,
          canDeploy: false,
          scope: "local",
          blockers: ["local-only", "real-project-unconfirmed"],
        },
      });
    if (path.endsWith("/production/runs")) {
      if (method === "POST") {
        const requestKey = r.request().postDataJSON().requestKey;
        createRequests.push({ requestKey, revision: settings.revision });
        if (loseFirstCreate && createRequests.length === 1)
          return r.fulfill({
            status: 500,
            json: { error: "response lost after persisted create" },
          });
        if (
          createRequests.some(
            (c) =>
              c.requestKey === requestKey && c.revision !== settings.revision,
          )
        )
          return r.fulfill({
            status: 409,
            json: { error: "revision mismatch" },
          });
        const run = {
          id: "production_one",
          stage: "LOCAL_ONLY",
          settings,
          createdAt: new Date().toISOString(),
        };
        runs = [run];
        return r.fulfill({ status: 201, json: { run } });
      }
      return r.fulfill({ json: { runs } });
    }
    if (path.endsWith("/assess"))
      return r.fulfill({
        json: {
          run: runs[0],
          assessment: {
            ready: false,
            canPromote: false,
            deployment: "not_deployed",
            businessDeployment: "not_authorized",
            blockers: ["local-only"],
            missing: ["soak", "real-project"],
          },
        },
      });
    return r.fulfill({ json: {} });
  });
  await page.goto("/#/settings/ops/factory");
  await page.getByTestId("factory-production").locator("summary").click();
  return { writes, createRequests };
}
test("production preparation persists settings and requires save before freezing [AC:multi-machine-production-readiness#AC-1] [AC:multi-machine-production-readiness#AC-6]", async ({
  page,
}) => {
  const f = await setup(page),
    panel = page.getByTestId("factory-production");
  await expect(panel.getByLabel("真实项目仓库（owner/repo）")).toBeVisible();
  await panel
    .getByLabel("真实项目仓库（owner/repo）")
    .fill("owner/private-project");
  await expect(
    panel.getByRole("button", { name: "新建本地验证记录" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "保存准备配置" }).click();
  await expect(
    panel.getByRole("button", { name: "新建本地验证记录" }),
  ).toBeEnabled();
  expect(f.writes[0].repository).toBe("owner/private-project");
  expect(f.writes[0].environment).toBe("local");
});
test("local assessment names missing evidence without claiming deployment or readiness [AC:multi-machine-production-readiness#AC-29] [AC:multi-machine-production-readiness#AC-40]", async ({
  page,
}) => {
  await setup(page);
  const p = page.getByTestId("factory-production");
  await p.getByRole("button", { name: "新建本地验证记录" }).click();
  await p.getByRole("button", { name: "核对本地记录" }).click();
  await expect(
    p.getByText("未部署；不具备发布就绪结论。", { exact: true }),
  ).toBeVisible();
  await expect(p.getByText("24 小时连续运行", { exact: true })).toBeVisible();
  await expect(p.getByText("真实项目双机交付", { exact: true })).toBeVisible();
  await expect(
    p.getByRole("button", { name: "部署", exact: true }),
  ).toHaveCount(0);
});

test("lost create response keeps idempotency within a revision and rotates it after saving a new revision", async ({
  page,
}) => {
  const f = await setup(page, true),
    panel = page.getByTestId("factory-production"),
    create = panel.getByRole("button", { name: "新建本地验证记录" });
  await create.click();
  await expect(create).toBeEnabled();
  await panel.getByLabel("真实项目仓库（owner/repo）").fill("owner/changed");
  await panel.getByRole("button", { name: "保存准备配置" }).click();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    panel.getByRole("button", { name: "核对本地记录" }),
  ).toBeEnabled();
  expect(f.createRequests).toHaveLength(2);
  expect(f.createRequests[0].requestKey).not.toBe(
    f.createRequests[1].requestKey,
  );
});
test("lost create response retries the same revision with the original idempotency key", async ({
  page,
}) => {
  const f = await setup(page, true),
    panel = page.getByTestId("factory-production"),
    create = panel.getByRole("button", { name: "新建本地验证记录" });
  await create.click();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    panel.getByRole("button", { name: "核对本地记录" }),
  ).toBeEnabled();
  expect(f.createRequests).toHaveLength(2);
  expect(f.createRequests[0].requestKey).toBe(f.createRequests[1].requestKey);
});
