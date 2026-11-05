import { test, expect } from '@playwright/test';

test('管理卡片约束长内容 [AC:agents-clean-layout#AC-1]', async ({ page }) => {
  const bot = { id:'layout-bot', name:'Layout Bot', agentId:'bot_'+'a'.repeat(100), description:'长描述 '.repeat(100), canonicalSessionId:'layout-session' };
  await page.route('**/api/bots', r=>r.fulfill({json:{bots:[bot]}}));
  await page.route('**/api/bot-work/default', r=>r.fulfill({json:{bot}}));
  for (const width of [907,360]) {
    await page.setViewportSize({width,height:804});
    await page.goto('/#/agents/bots');
    const card=page.getByTestId('bot-card-layout-bot');
    await expect(card).toBeVisible();
    expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await expect(card.locator('.ag-card__agent')).toHaveCSS('text-overflow','ellipsis');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
