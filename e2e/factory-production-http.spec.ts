import { test, expect } from "@playwright/test";

test("real Lab proxy persists a frozen production plan and exposes local-only assessment without deployment [AC:multi-machine-local-foundation#AC-2] [AC:multi-machine-local-foundation#AC-3] [AC:multi-machine-local-foundation#AC-4]", async ({
  page,
  request,
}) => {
  const settingsResponse = await request.get(
    "/api/factory/production/settings",
  );
  expect(settingsResponse.status()).toBe(200);
  await page.goto("/#/settings/ops/factory");
  const panel = page.getByTestId("factory-production");
  await panel.locator("summary").click();
  await panel
    .getByLabel("真实项目仓库（owner/repo）")
    .fill("local-only/preparation");
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/factory/production/settings") &&
      r.request().method() === "PATCH",
  );
  await panel.getByRole("button", { name: "保存准备配置" }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  const { settings } = await saved.json();
  const createdResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/factory/production/runs") &&
      r.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "新建本地验证记录" }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const { run } = await created.json();
  expect(run.stage).toBe("LOCAL_ONLY");
  expect(run.settings.revision).toBe(settings.revision);
  await panel.getByRole("button", { name: "核对本地记录" }).click();
  await expect(
    panel.getByText("未部署；不具备发布就绪结论。", { exact: true }),
  ).toBeVisible();
  const detail = await (
    await request.get("/api/factory/production/runs/" + run.id)
  ).json();
  expect(detail.run.assessment).toMatchObject({
    ready: false,
    canPromote: false,
    deployment: "not_deployed",
    businessDeployment: "not_authorized",
  });
  await page.reload();
  await panel.locator("summary").click();
  await expect(panel.getByLabel("真实项目仓库（owner/repo）")).toHaveValue(
    "local-only/preparation",
  );
  await panel
    .getByRole("combobox", { name: "本地验证记录" })
    .selectOption(run.id);
  await expect(panel).toContainText(settings.revision);
});
