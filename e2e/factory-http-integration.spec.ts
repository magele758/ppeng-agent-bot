import { test, expect } from "@playwright/test";

test("real Lab proxy persists factory configuration and shares Room task state [AC:multi-machine-readonly-pilot#AC-1] [AC:multi-machine-readonly-pilot#AC-3] [AC:multi-machine-readonly-pilot#AC-13]", async ({
  page,
  request,
}) => {
  const initial = await (await request.get("/api/factory/settings")).json();
  const bot = (
    await (
      await request.post("/api/bots", {
        data: { name: "Factory HTTP " + Date.now() },
      })
    ).json()
  ).bot;
  const room = (
    await (
      await request.post("/api/bot-rooms", {
        data: { title: "Factory HTTP", botIds: [bot.id], hostBotId: bot.id },
      })
    ).json()
  ).room;
  await page.goto("/#/settings/ops/factory");
  await expect(page.getByTestId("factory-panel")).toBeVisible();
  await page.getByTestId("factory-room").selectOption(room.id);
  await page.getByTestId("factory-coordinator").selectOption(bot.id);
  await page.getByTestId("factory-add-machine").click();
  await page.getByTestId("factory-machine-id").fill("pilot");
  await page.getByTestId("factory-machine-name").fill("Pilot");
  await page
    .getByTestId("factory-machine-alias")
    .fill("factory-e2e-unreachable");
  await page.getByTestId("factory-machine-capacity").fill("1");
  await page
    .getByTestId("factory-machine-users")
    .fill(initial.settings.owner.userId);
  await page.getByTestId("factory-machine-bots").selectOption([bot.id]);
  await page.getByRole("button", { name: "添加仓库", exact: true }).click();
  await page
    .getByRole("textbox", { name: "仓库标识", exact: true })
    .fill("core");
  await page
    .getByRole("textbox", { name: "远程仓库绝对路径", exact: true })
    .fill("/repo");
  await page.getByTestId("factory-save").click();
  await expect(
    page.getByRole("status").filter({ hasText: "配置已保存" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("factory-machine-capacity")).toHaveValue("1");
  const rejected = await request.post(`/api/bot-rooms/${room.id}/messages`, {
    data: {
      text: "/factory run pilot core snapshot",
      mentions: ["outsider"],
      idempotencyKey: "invalid",
    },
  });
  expect(rejected.status()).toBe(400);
  expect(
    (await (await request.get("/api/factory/board")).json()).tasks,
  ).toHaveLength(0);
  const body = {
    text: "/factory run pilot core snapshot",
    idempotencyKey: "accepted",
  };
  const first = await request.post(`/api/bot-rooms/${room.id}/messages`, {
    data: body,
  });
  expect(first.status()).toBe(202);
  const task = (await first.json()).task;
  const again = await request.post(`/api/bot-rooms/${room.id}/messages`, {
    data: body,
  });
  expect((await again.json()).task.id).toBe(task.id);
  await page.getByTestId("factory-refresh").click();
  const row = page.getByRole("row").filter({ hasText: task.id });
  await expect(row).toBeVisible();
  await expect(row).toContainText("排队");
  const query = await request.post(`/api/bot-rooms/${room.id}/messages`, {
    data: { text: "/factory status " + task.id, idempotencyKey: "query" },
  });
  expect(query.ok()).toBeTruthy();
  const messages = (
    await (await request.get(`/api/bot-rooms/${room.id}/messages`)).json()
  ).messages;
  expect(
    messages.some(
      (m: { text: string }) =>
        m.text.includes(task.id) && m.text.includes(task.updatedAt),
    ),
  ).toBe(true);
  await row.getByRole("button", { name: "取消排队任务" }).click();
  await expect(row).toContainText("已取消");
  expect(
    (await (await request.get(`/api/factory/tasks/${task.id}`)).json()).task
      .status,
  ).toBe("cancelled");
});

test("real Lab proxy shares controlled-development Room admission, task evidence and cancellation [AC:multi-machine-controlled-development#AC-3] [AC:multi-machine-controlled-development#AC-5] [AC:multi-machine-controlled-development#AC-21] [AC:multi-machine-controlled-development#AC-24] [AC:multi-machine-controlled-development#AC-27]", async ({ page, request }) => {
  const initial = await (await request.get("/api/factory/settings")).json();
  const userId = initial.settings.owner.userId;
  const botResponse = await request.post("/api/bots", { data: { name: "Development HTTP " + Date.now() } });
  expect(botResponse.ok()).toBe(true);
  const { bot } = await botResponse.json();
  const roomResponse = await request.post("/api/bot-rooms", { data: { title: "Development HTTP", botIds: [bot.id], hostBotId: bot.id } });
  expect(roomResponse.ok()).toBe(true);
  const { room } = await roomResponse.json();
  const configured = await request.patch("/api/factory/settings", { data: {
    roomId: room.id, coordinatorBotId: bot.id,
    machines: [{ id: "development-offline", name: "Development offline", sshAlias: "factory-e2e-unreachable", capacity: 1, botIds: [bot.id], allowedUserIds: [userId], repositories: [{ id: "core", path: "/repo" }] }],
  } });
  expect(configured.status()).toBe(200);
  const policy = {
    enabled: true, allowedUserIds: [userId], image: "sha256:" + "a".repeat(64),
    toolPath: "/tools/claude", model: "integration-offline-model", modelUrl: "https://model.example", credentialRef: "integration-offline-credential",
    codeArgv: ["/tools/claude"], reviewArgv: ["/tools/claude"],
    checks: [{ id: "unit", argv: ["node", "--test"], required: true }], redCheck: "unit", install: ["true"],
    timeoutMs: 10000, maxRounds: 6, maxRetries: 1, minDiskMb: 128, maxWorkspaceMiB: 1024,
    criteria: [{ id: "AC-1", given: "An approved isolated change", when: "the task runs", then: "the local result passes checks" }], criteriaApproved: true, baselineFailures: [],
  };
  const saved = await request.patch("/api/factory/development/development-offline/core", { data: policy });
  expect(saved.status()).toBe(200);
  const savedPolicy = (await saved.json()).settings;
  await page.goto("/#/settings/ops/factory");
  await expect(page.getByTestId("development-enabled")).toBeChecked();
  await expect(page.getByTestId("development-model")).toHaveValue(policy.model);
  const baseline = "b".repeat(40);
  const body = { text: "/factory develop " + JSON.stringify({ machineId: "development-offline", repositoryId: "core", requirement: "Exercise approved isolated development without contacting a worker", baseline }), idempotencyKey: "development-http-admission" };
  const first = await request.post(`/api/bot-rooms/${room.id}/messages`, { data: body });
  expect(first.status()).toBe(202);
  const { task } = await first.json();
  const duplicate = await request.post(`/api/bot-rooms/${room.id}/messages`, { data: body });
  expect(duplicate.status()).toBe(202);
  expect((await duplicate.json()).task.id).toBe(task.id);
  const detailResponse = await request.get(`/api/factory/development/tasks/${task.id}`);
  expect(detailResponse.status()).toBe(200);
  const detail = (await detailResponse.json()).task;
  expect(detail.id).toBe(task.id);
  expect(detail.status).toBe("queued");
  expect(detail.startedAt).toBeUndefined();
  expect(detail.evidenceCurrent).toBe(true);
  expect(detail.development).toMatchObject({ stage: "QUEUED", round: 0, baseline, delivery: "not_pushed", policy: { revision: savedPolicy.revision, criteriaApproved: true } });
  const board = (await (await request.get("/api/factory/board")).json()).tasks;
  expect(board.filter((item: { id: string }) => item.id === task.id)).toHaveLength(1);
  await page.getByTestId("factory-refresh").click();
  const row = page.getByRole("row").filter({ hasText: task.id });
  await expect(row).toContainText("QUEUED");
  await expect(row).toContainText("修复轮次");
  await expect(row).toContainText("尚未发布交付");
  await row.locator("summary").click();
  await expect(row.locator("pre")).toContainText(baseline);
  await expect(row.locator("pre")).toContainText("not_pushed");
  await row.getByRole("button", { name: "取消开发任务", exact: true }).click();
  await expect(row).toContainText("CANCELLED");
  await expect(row.getByRole("button", { name: "暂停开发任务" })).toHaveCount(0);
  const cancelled = (await (await request.get(`/api/factory/development/tasks/${task.id}`)).json()).task;
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.development.stage).toBe("CANCELLED");
  expect(cancelled.development.delivery).toBe("not_pushed");
  const query = await request.post(`/api/bot-rooms/${room.id}/messages`, { data: { text: "/factory status " + task.id, idempotencyKey: "development-http-status" } });
  expect(query.status()).toBe(202);
  expect((await query.json()).task.id).toBe(task.id);
  const messages = (await (await request.get(`/api/bot-rooms/${room.id}/messages`)).json()).messages;
  expect(messages.some((message: { text: string }) => message.text.includes(task.id) && message.text.includes("CANCELLED") && message.text.includes(baseline) && message.text.includes("not_pushed"))).toBe(true);
});
