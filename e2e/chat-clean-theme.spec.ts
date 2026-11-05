import { expect, test } from '@playwright/test';

test('经典浅色使用干净的阅读底色 [AC:chat-clean-theme#AC-1] [AC:chat-clean-theme#AC-2]', async ({ page }) => {
  await page.goto('/');
  await page.locator('.lab-shell').first().waitFor();
  await page.evaluate(() => {
    Object.assign(document.documentElement.dataset, { theme: 'light', skin: 'classic' });
    const panel = document.createElement('section');
    panel.id = 'theme-sample';
    panel.className = 'chat-panel-body';
    panel.innerHTML = '<div class="chat-bubble__body chat-bubble__md"><p>示例</p></div><div class="chat-turn chat-turn--user"><div class="chat-bubble">问题</div></div><div class="chat-composer"><button>+</button><div class="chat-composer-field">消息</div></div>';
    document.querySelector('.lab-shell')!.append(panel);
  });
  await expect(page.locator('#theme-sample .chat-turn--user .chat-bubble')).toHaveCSS('border-radius', '18px', {timeout:1500});
  const field = await page.locator('#theme-sample .chat-composer-field').boundingBox();
  const button = await page.locator('#theme-sample button').boundingBox();
  expect(field!.y + field!.height).toBeLessThanOrEqual(button!.y);
  await expect(page.locator('body')).toHaveCSS('background-image', 'none', {timeout:1500});
  await expect(page.locator('#theme-sample p')).toHaveCSS('color', 'rgb(51, 60, 57)');
  await expect(page.locator('#theme-sample .chat-composer')).toHaveCSS('box-shadow', 'none');
});
