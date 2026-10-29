import { test, expect } from '@playwright/test';

test.describe('Lab new surfaces', () => {
  test('settings and knowledge pages keep goal / sandbox / event-log / ingestion cards [AC:console-navigation#AC-3]', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('lab.settings.advanced', '1'));
    await page.goto('/#/settings/behavior');
    const settings = page.locator('#section-settings');
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: '目标（Goal）' })).toBeVisible({ timeout: 15_000 });
    await page.locator('#settings-cat-safety').click();
    await expect(settings.getByRole('heading', { name: '命令沙箱' })).toBeVisible();
    await page.locator('#settings-cat-integrations').click();
    await expect(settings.getByRole('heading', { name: 'EventLog / Saga' })).toBeVisible();
    await page.goto('/#/knowledge/ingestion');
    await expect(page.locator('#section-knowledge').getByRole('heading', { name: '附件与浏览器' })).toBeVisible();
  });

  test('Teams tab shows DAG planner [AC:console-navigation#AC-3]', async ({ page }) => {
    await page.goto('/#/chat');
    await page.getByRole('link', { name: 'Bots 与 Agents' }).click();
    await page.getByRole('tab', { name: /^Teams$/ }).click();
    await expect(page.locator('#panel-teams')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Teams DAG' })).toBeVisible();
  });

  test('composer execution mode and workspace picker are present', async ({ page }) => {
    await page.goto('/#/chat');
    await expect(page.getByLabel('工作区')).toBeVisible();
    await page.locator('.composer-config-summary').click();
    await expect(page.locator('#composerConfigPanel')).toBeVisible();
    await expect(page.getByLabel('通用执行模式')).toBeVisible();
    await expect(page.getByText('自主度', { exact: false })).toBeVisible();
  });

  test('composer model picker does not show env fallback', async ({ page }) => {
    await page.goto('/#/chat');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '选择可用模型' }).click();
    const panel = page.getByRole('listbox', { name: '可用模型' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('环境变量', { exact: false })).toHaveCount(0);
    await expect(panel.getByText('回退')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '管理服务商…' })).toBeVisible();
  });
});
