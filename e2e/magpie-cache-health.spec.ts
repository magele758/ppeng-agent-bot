import { test, expect } from '@playwright/test';

test('health shows measured cache ratios, incident and last valid observation through missing data [AC:magpie-cache-monitor#AC-3]', async ({page}) => {
  const checkedAt = '2026-11-19T10:30:00Z', lastValidAt = '2026-11-19T08:00:00Z';
  const window = {from:'2026-11-19T07:00:00Z',to:lastValidAt,requests:10,input:1000,cached:340,hitRequests:7,ratio:.34,requestHitRatio:.7};
  let payload: object | null = {
    version:1, checkedAt, lastValidAt, sourceStatus:'incomplete',
    models:[{provider:'codex',model:'test-model',status:'insufficient',incidentOpen:true,lastValidAt,window,
      reference:{...window,requests:30,cached:720,ratio:.72}}]
  };
  await page.route('**/api/ops/magpie-cache', route => route.fulfill({json:{summary:payload}}));
  await page.goto('/#/ops/health');
  const card = page.getByTestId('magpie-cache-health');
  await expect(card).toContainText('test-model');
  for (const text of ['codex','34%','70%','72%','10','30','持续退化','观测不足']) await expect(card).toContainText(text);
  await expect(card.locator('time').first()).toHaveAttribute('datetime',checkedAt);
  await expect(card.locator('time').nth(1)).toHaveAttribute('datetime',lastValidAt);
  payload = null;
  await page.reload();
  await expect(card).toContainText('还没有监控结果');
  await page.route('**/api/ops/magpie-cache', route => route.fulfill({status:403, json:{error:'forbidden'}}));
  await page.reload();
  await expect(page.getByTestId('ops-health')).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('stale checks are labeled and a seed reference never appears as a current measurement [AC:magpie-cache-monitor#AC-3]', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-19T12:00:00Z'));
  const checkedAt = '2026-11-19T10:00:00Z';
  const reference = {from:'2026-11-19T08:00:00Z',to:checkedAt,requests:8,input:40000,cached:24500,hitRequests:8,
    ratio:24500/40000,requestHitRatio:1};
  await page.route('**/api/ops/magpie-cache', route => route.fulfill({json:{summary:{
    version:1,checkedAt,lastValidAt:checkedAt,sourceStatus:'ok',
    models:[{provider:'codex',model:'seeded',status:'insufficient',incidentOpen:false,lastValidAt:checkedAt,window:null,reference}]
  }}}));
  await page.goto('/#/ops/health');
  const card = page.getByTestId('magpie-cache-health');
  await expect(card).toContainText('监控更新已延迟');
  await expect(card.getByRole('row', {name:/上次检查时段/})).toContainText('暂无数据');
  const baseline = card.getByRole('row', {name:/参照/});
  await expect(baseline).toContainText('61.25%');
  await expect(baseline).toContainText('8 / 8');
});
