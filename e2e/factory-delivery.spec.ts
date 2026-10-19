import { test, expect, type Page } from "@playwright/test";
const machines = [
  {
    id: "u0",
    name: "Ubuntu",
    sshAlias: "ubuntu",
    capacity: 1,
    botIds: ["bot"],
    allowedUserIds: ["owner"],
    repositories: [{ id: "core", path: "/repo" }],
  },
];
const policy = {
  enabled: true,
  allowedUserIds: ["owner"],
  repository: "owner/trial",
  repositoryNodeId: "R_123",
  target: "main",
  credentialRef: "trial",
  operations: ["push", "pr", "merge"],
  requiredChecks: [{ workflowId: 42, job: "test", appId: 15368 }],
  workflowDigests: { ".github/workflows/ci.yml": "c".repeat(40) },
  mergeIdentity: {
    appId: 123,
    installationId: 456,
    rulesetId: 789,
    credentialRef: "merge-only",
  },
  mergeMethod: "squash",
  maxRetries: 1,
  deadlineMs: 60000,
  downstream: { confirmed: true, deploys: false },
};
async function setup(page: Page, tasks: unknown[] = []) {
  await page.route("**/api/bots", (r) =>
    r.fulfill({ json: { bots: [{ id: "bot", name: "Coordinator" }] } }),
  );
  await page.route("**/api/bot-rooms", (r) =>
    r.fulfill({ json: { rooms: [{ id: "room", title: "Factory" }] } }),
  );
  await page.route("**/api/factory/settings", (r) =>
    r.fulfill({
      json: {
        settings: {
          owner: { userId: "owner" },
          machines,
          roomId: "room",
          coordinatorBotId: "bot",
          patrol: { enabled: false, timezone: "Asia/Shanghai" },
        },
      },
    }),
  );
  await page.route("**/api/factory/board", (r) =>
    r.fulfill({ json: { tasks, machines } }),
  );
  await page.route("**/api/factory/patrol", (r) =>
    r.fulfill({
      json: {
        settings: { enabled: false, timezone: "Asia/Shanghai" },
        state: {},
      },
    }),
  );
  await page.route("**/api/factory/development/decisions", (r) =>
    r.fulfill({ json: { tasks: [] } }),
  );
  await page.route("**/api/factory/development/u0/core", (r) =>
    r.fulfill({ json: { settings: { enabled: false } } }),
  );
  await page.goto("/#/settings/ops/factory");
}
test("delivery policy loads, requires save before preflight, and persists by API [AC:multi-machine-controlled-delivery#AC-1]", async ({
  page,
}) => {
  let saved = policy;
  await page.route("**/api/factory/delivery/u0/core", async (r) => {
    if (r.request().method() === "PATCH") saved = r.request().postDataJSON();
    await r.fulfill({ json: { settings: saved } });
  });
  await page.route("**/api/factory/delivery/u0/core/preflight", (r) =>
    r.fulfill({
      json: { ready: true, reasons: [], facts: { repositoryNodeId: "R_123" } },
    }),
  );
  await setup(page);
  const panel = page.getByTestId("factory-delivery-settings");
  await panel.locator("summary").click();
  await panel
    .getByRole("combobox", { name: "机器", exact: true })
    .selectOption("u0");
  await panel
    .getByRole("combobox", { name: "仓库", exact: true })
    .selectOption("core");
  await expect(panel.getByLabel("GitHub 仓库（owner/repo）")).toHaveValue(
    "owner/trial",
  );
  await panel.getByLabel("目标分支", { exact: true }).fill("release");
  await expect(
    panel.getByRole("button", { name: "核对远端就绪条件" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "保存配置" }).click();
  await expect(
    panel.getByRole("button", { name: "核对远端就绪条件" }),
  ).toBeEnabled();
  expect(saved.target).toBe("release");
  expect(saved.mergeIdentity.credentialRef).toBe("merge-only");
  await page.reload();
  await panel.locator("summary").click();
  await panel
    .getByRole("combobox", { name: "机器", exact: true })
    .selectOption("u0");
  await panel
    .getByRole("combobox", { name: "仓库", exact: true })
    .selectOption("core");
  await expect(panel.getByLabel("目标分支", { exact: true })).toHaveValue(
    "release",
  );
});
test("merged task distinguishes local READY, actual merge and deferred deployment [AC:multi-machine-controlled-delivery#AC-30]", async ({
  page,
}) => {
  const candidate = "a".repeat(40),
    merge = "b".repeat(40);
  await page.route("**/api/factory/delivery/tasks/factory_ui", (r) =>
    r.fulfill({
      json: {
        delivery: {
          stage: "MERGED",
          candidate,
          mergeSha: merge,
          deployment: "not_deployed",
          pr: { number: 1, url: "https://github.com/owner/trial/pull/1" },
        },
      },
    }),
  );
  await setup(page, [
    {
      id: "factory_ui",
      machineId: "u0",
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      history: [],
      development: { stage: "READY", round: 1, delivery: "not_pushed" },
    },
  ]);
  const panel = page.getByTestId("factory-delivery-task");
  await expect(panel).toContainText("MERGED");
  await expect(panel).toContainText(merge);
  await expect(panel).toContainText("部署未由本阶段完成");
  await expect(panel.getByRole("link", { name: "PR #1" })).toHaveAttribute(
    "href",
    "https://github.com/owner/trial/pull/1",
  );
});

test("CI repair retains its published PR while describing local development separately [AC:multi-machine-controlled-delivery#AC-30]", async ({
  page,
}) => {
  const candidate = "a".repeat(40);
  await page.route("**/api/factory/delivery/tasks/factory_repair", (r) =>
    r.fulfill({
      json: {
        delivery: {
          stage: "SYNC_WAIT",
          candidate,
          pushedSha: candidate,
          deployment: "not_deployed",
          pr: { number: 4, url: "https://github.com/owner/trial/pull/4" },
        },
      },
    }),
  );
  await setup(page, [
    {
      id: "factory_repair",
      machineId: "u0",
      status: "queued",
      updatedAt: new Date().toISOString(),
      history: [],
      development: { stage: "QUEUED", round: 2, delivery: "not_pushed" },
    },
  ]);
  const local = page.getByTestId("development-task");
  const remote = page.getByTestId("factory-delivery-task");
  await expect(local).toContainText("本地开发尚未 READY");
  await expect(local).not.toContainText("尚未发布交付");
  await expect(remote).toContainText("SYNC_WAIT");
  await expect(remote).toContainText(candidate);
  await expect(remote.getByRole("link", { name: "PR #4" })).toHaveAttribute(
    "href",
    "https://github.com/owner/trial/pull/4",
  );
  await expect(remote).toContainText("部署未由本阶段完成");
});

test("a stale GET cannot replace the newer pause decision [AC:multi-machine-controlled-delivery#AC-28]", async ({
  page,
}) => {
  await page.clock.install();
  const delivery = {
    stage: "CI_WAIT",
    candidate: "a".repeat(40),
    deployment: "not_deployed",
    pr: { number: 5, url: "https://github.com/owner/trial/pull/5" },
  };
  let gets = 0;
  let releaseStale!: () => void;
  let markStaleStarted!: () => void;
  const staleStarted = new Promise<void>((resolve) => {
    markStaleStarted = resolve;
  });
  const staleRelease = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  await page.route(
    "**/api/factory/delivery/tasks/factory_race",
    async (route) => {
      const response = structuredClone(delivery);
      if (++gets === 2) {
        markStaleStarted();
        await staleRelease;
      }
      await route.fulfill({ json: { delivery: response } });
    },
  );
  await page.route(
    "**/api/factory/delivery/tasks/factory_race/control",
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({ action: "pause" });
      delivery.stage = "PAUSED";
      await route.fulfill({ json: { delivery } });
    },
  );
  await setup(page, [
    {
      id: "factory_race",
      machineId: "u0",
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      history: [],
      development: { stage: "READY", round: 1, delivery: "not_pushed" },
    },
  ]);
  const panel = page.getByTestId("factory-delivery-task");
  const state = panel.locator("p").filter({ hasText: /^远端交付状态:/ });
  await expect(state).toHaveText("远端交付状态: CI_WAIT");
  await page.clock.fastForward(5000);
  await staleStarted;
  await panel
    .getByRole("button", { name: "暂停远端交付", exact: true })
    .click();
  await expect(state).toHaveText("远端交付状态: PAUSED");
  const staleResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/factory/delivery/tasks/factory_race"),
  );
  releaseStale();
  await (await staleResponse).finished();
  // Let the old response's JSON/React update settle before checking the summary.
  // Assert the summary itself: the POST evidence also contains PAUSED.
  await page.waitForTimeout(200);
  expect(await state.textContent()).toBe("远端交付状态: PAUSED");
});
test("read-only verification records an external merge without granting delivery again [AC:multi-machine-controlled-delivery#AC-28]", async ({
  page,
}) => {
  let delivery = {
    stage: "WAITING_DECISION",
    candidate: "a".repeat(40),
    deployment: "not_deployed",
    pr: { number: 6, url: "https://github.com/owner/trial/pull/6" },
    mergeSha: undefined as string | undefined,
  };
  await page.route("**/api/factory/delivery/tasks/factory_observe", (r) =>
    r.fulfill({ json: { delivery } }),
  );
  await page.route(
    "**/api/factory/delivery/tasks/factory_observe/verify",
    async (r) => {
      expect(r.request().method()).toBe("POST");
      delivery = { ...delivery, stage: "MERGED", mergeSha: "b".repeat(40) };
      await r.fulfill({ json: { delivery } });
    },
  );
  await setup(page, [
    {
      id: "factory_observe",
      machineId: "u0",
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      development: {
        stage: "READY",
        delivery: "local_ready",
        round: 7,
        policy: { maxRounds: 8 },
      },
      history: [],
    },
  ]);
  const panel = page.getByTestId("factory-delivery-task");
  await panel
    .getByRole("button", { name: "只读核对实际远端状态", exact: true })
    .click();
  await expect(
    panel.getByText("远端交付状态: MERGED", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("b".repeat(40), { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "PR #6" })).toBeVisible();
});
