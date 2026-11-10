import { test, expect } from '@playwright/test';

test('isolated and sustained status failures are distinguished and recover [AC:bot-status-polling#AC-2]', async ({ page }) => {
  let failure: 'ok' | 'network' | 'server' | 'timeout' = 'ok';
  let attempts = 0;
  await page.route('**/api/bot-work/status', async route => {
    attempts++;
    if (failure === 'timeout') return;
    if (failure === 'network') return route.abort('internetdisconnected');
    if (failure === 'server') return route.fulfill({ status: 503, json: { error: 'busy' } });
    return route.fulfill({ json: { bots: [] } });
  });
  await page.goto('/#/bot');
  await expect.poll(() => attempts).toBeGreaterThan(0);
  const notice = page.getByTestId('bot-work-connection');
  for (const [kind, label] of [['network', '连接中断'], ['server', '服务暂不可用'], ['timeout', '响应较慢']] as const) {
    attempts = 0;
    failure = kind;
    await expect.poll(() => attempts).toBeGreaterThan(0);
    await expect(notice).toHaveCount(0);
    await expect(notice).toContainText(label, { timeout: 30000 });
    await expect(notice.locator('time')).toBeVisible();
    failure = 'ok';
    await expect(notice).toHaveCount(0, { timeout: 10000 });
  }
});
