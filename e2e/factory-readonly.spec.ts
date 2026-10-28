import { test, expect } from "@playwright/test";

test("factory Lab saves configuration, probes and shows unified task progress [AC:multi-machine-readonly-pilot#AC-1] [AC:multi-machine-readonly-pilot#AC-13]", async ({
  page,
}) => {
  let settings = {
    owner: { userId: "owner" },
    machines: [] as unknown[],
    roomId: "room",
    coordinatorBotId: "bot",
    patrol: { enabled: false, timezone: "Asia/Shanghai" },
  };
  let completed = false;
  await page.route("**/api/factory/**", async (route) => {
    const u = new URL(route.request().url());
    let body: unknown = {};
    if (u.pathname.endsWith("/settings")) {
      if (route.request().method() === "PATCH")
        settings = { ...settings, ...route.request().postDataJSON() };
      body = { settings };
    }
    if (u.pathname.endsWith("/board"))
      body = {
        machines: settings.machines,
        tasks: settings.machines.length
          ? [
            {
              id: "factory-test",
              machineId: "ubuntu1",
              status: completed ? "succeeded" : "running",
              updatedAt: new Date().toISOString(),
              history: [],
              result: completed ? { sha: "verified-sha" } : undefined,
            },
          ]
          : [],
      };
    if (u.pathname.endsWith("/probe"))
      body = { online: true, identity: "verified-machine" };
    if (u.pathname.endsWith("/patrol"))
      body = { settings: settings.patrol, state: { checks: {}, notified: {} } };
    await route.fulfill({ json: body });
  });
  await page.route("**/api/bot-rooms", (route) =>
    route.fulfill({ json: { rooms: [{ id: "room", title: "Factory Room", botIds: [] }] } }),
  );
  await page.route("**/api/bots", (route) =>
    route.fulfill({ json: { bots: [{ id: "bot", name: "Coordinator" }] } }),
  );
  await page.goto("/#/settings/ops/factory");
  await expect(page.getByTestId("factory-panel")).toBeVisible();
  await page.getByTestId("factory-add-machine").click();
  await page.getByTestId("factory-machine-id").fill("ubuntu1");
  await page.getByTestId("factory-machine-name").fill("Ubuntu1");
  await page.getByTestId("factory-machine-alias").fill("ubuntu1");
  await page.getByTestId("factory-machine-capacity").fill("2");
  await page.getByTestId("factory-machine-users").fill("owner");
  await page.getByTestId("factory-machine-bots").selectOption(["bot"]);
  await page.getByTestId("factory-room").selectOption("room");
  await page.getByTestId("factory-coordinator").selectOption("bot");
  await page.getByTestId("factory-save").click();
  await expect(page.getByText("factory-test", { exact: true })).toBeVisible();
  await page.getByTestId("factory-probe-ubuntu1").click();
  await expect(
    page.getByText("verified-machine", { exact: false }),
  ).toBeVisible();
  completed = true;
  await page.getByTestId("factory-refresh").click();
  await page.locator('[data-testid="factory-panel"] .factory-table summary').click();
  await expect(page.getByText("verified-sha", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("factory-machine-capacity")).toHaveValue("2");
});

async function mockConfiguredFactory(page: import("@playwright/test").Page, board: (route: import("@playwright/test").Route) => Promise<void>, patrol: () => boolean = () => false) {
  await page.route("**/api/factory/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/board")) return board(route);
    if (path.endsWith("/settings")) return route.fulfill({
      json: {
        settings: {
          owner: { userId: "owner" },
          roomId: "room", coordinatorBotId: "bot",
          patrol: { enabled: false, timezone: "Asia/Shanghai" },
          machines: [{ id: "ubuntu1", name: "Ubuntu1", sshAlias: "ubuntu1", capacity: 2, botIds: ["bot"], allowedUserIds: ["owner"], repositories: [{ id: "core", path: "/repo" }] }],
        }
      }
    });
    return route.fulfill({ json: { settings: { enabled: patrol(), timezone: "Asia/Shanghai" }, state: { checks: {}, notified: {} } } });
  });
  await page.route("**/api/bots", route => route.fulfill({ json: { bots: [{ id: "bot", name: "Coordinator" }] } }));
  await page.route("**/api/bot-rooms", route => route.fulfill({ json: { rooms: [{ id: "room", title: "Factory Room", botIds: [] }, { id: "other", title: "Other Room", botIds: [] }] } }));
  await page.goto("/#/settings/ops/factory");
  await expect(page.getByTestId("factory-machine-name")).toHaveValue("Ubuntu1");
}

const boardFor = (status: string) => ({
  machines: [], tasks: [{
    id: "factory-order", machineId: "ubuntu1", status,
    updatedAt: "2026-10-18T04:00:00.000Z", history: [],
    identity: "verified-host", startedAt: "2026-10-18T03:59:00.000Z",
    finishedAt: status === "succeeded" ? "2026-10-18T04:00:00.000Z" : undefined,
    result: status === "succeeded" ? { sha: "latest-sha" } : undefined,
  }]
});

for (const staleFailure of [false, true]) {
  test(`factory board ignores delayed ${staleFailure ? "failed" : "successful"} polls and preserves unsaved configuration [AC:multi-machine-readonly-pilot#AC-13]`, async ({ page }) => {
    let calls = 0;
    let releaseOld!: () => void;
    const held = new Promise<void>(resolve => { releaseOld = resolve; });
    let sawOld!: () => void;
    const oldRequested = new Promise<void>(resolve => { sawOld = resolve; });
    await mockConfiguredFactory(page, async route => {
      const call = ++calls;
      if (call === 2) { sawOld(); await held; }
      if (call === 2 && staleFailure) return route.fulfill({ status: 503, json: { error: "Obsolete poll failed" } });
      await route.fulfill({ json: boardFor(call < 3 ? "running" : "succeeded") });
    });
    await page.getByTestId("factory-machine-name").fill("Unsaved machine name");
    await oldRequested;
    await page.getByTestId("factory-refresh").click();
    await expect(page.getByRole("cell", { name: "只读任务成功", exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse(response => response.url().endsWith("/api/factory/board"));
    releaseOld();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.getByRole("cell", { name: "只读任务成功", exact: true }).count()).toBe(1);
    expect(await page.getByTestId("factory-panel").getByRole("alert").count()).toBe(0);
    await expect(page.getByTestId("factory-machine-name")).toHaveValue("Unsaved machine name");
  });
}

test("factory patrol reflects persisted updates and cannot target an unsaved room [AC:multi-machine-readonly-pilot#AC-19]", async ({ page }) => {
  let enabled = false;
  await mockConfiguredFactory(page, route => route.fulfill({ json: boardFor("succeeded") }), () => enabled);
  const toggle = page.getByRole("checkbox", { name: "启用巡检", exact: true });
  await expect(toggle).not.toBeChecked();
  enabled = true;
  await page.getByTestId("factory-refresh").click();
  await expect(toggle).toBeChecked();
  await page.getByTestId("factory-room").selectOption("other");
  await expect(toggle).toBeDisabled();
  await expect(page.getByText("请先保存协作群配置，再操作巡检。", { exact: true })).toBeVisible();
});

test("factory task details expose verified machine and execution times [AC:multi-machine-readonly-pilot#AC-14]", async ({ page }) => {
  await mockConfiguredFactory(page, route => route.fulfill({ json: boardFor("succeeded") }));
  await page.locator('[data-testid="factory-panel"] .factory-table summary').click();
  await expect(page.getByText("verified-host", { exact: true })).toBeVisible();
  await expect(page.getByText("开始时间", { exact: true })).toBeVisible();
  await expect(page.getByText("结束时间", { exact: true })).toBeVisible();
  await expect(page.locator('time[datetime="2026-10-18T03:59:00.000Z"]')).toBeVisible();
  await expect(page.locator('time[datetime="2026-10-18T04:00:00.000Z"]')).toBeVisible();
});
