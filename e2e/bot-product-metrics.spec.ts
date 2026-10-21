import { test, expect } from '@playwright/test';

test('outcome metrics show their denominators and keep missing measurements distinct from zero [AC:bot-product-p2#AC-8]', async ({ page }) => {
  const ranges: Array<{from: string;to: string}> = [];
  await page.route('**/api/bot-work/metrics?*', route => {
    const url = new URL(route.request().url());
    const range = { from: url.searchParams.get('from')!, to: url.searchParams.get('to')! };
    ranges.push(range);
    return route.fulfill({ json: { metrics: { ...range, tasks: 5, reviewed: 4, accepted: 2,
      acceptanceRate: 0.5, firstAcceptedDeliveryMs: 0, recordedHumanInterventions: 3,
      recoveryCandidates: 0, recovered: 0, recoveryRate: null, knownCostDeliveries: 1, costPerAcceptedDeliveryUsd: null,
    } } });
  });
  await page.goto('/#/tasks/bots');
  const panel = page.getByTestId('bot-product-metrics');
  await panel.locator('summary').click();
  await expect(panel).toContainText('50.0% (2/4)');
  await expect(panel).toContainText('0.0 秒');
  await expect(panel.getByText('缺少观测数据', { exact: true })).toHaveCount(1);
  await expect(panel).toContainText('缺少观测数据 (0/0)');
  await expect(panel).toContainText('成本覆盖 1/2');
  await panel.getByLabel('统计时间范围', { exact: true }).selectOption('7');
  await expect.poll(() => {
    const last = ranges.at(-1);
    return last ? Date.parse(last.to)-Date.parse(last.from) : null;
  }).toBe(7*86400000);
});
