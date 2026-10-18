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
