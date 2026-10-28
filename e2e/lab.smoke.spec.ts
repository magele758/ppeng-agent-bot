import { test, expect } from '@playwright/test';

test.describe('Agent Lab console', () => {
  test('loads home and title [AC:console-navigation#AC-1] [AC:single-host-bot-completion#AC-4]', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Agent Home/i);
    // 默认落在 Bot 页；左侧主导航恰好六项
    await expect(page.locator('#panel-play')).toBeVisible();
    await expect(page.getByRole('button', { name: '工作台' })).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: '一级导航' });
    await expect(nav.getByRole('link')).toHaveText(['Bot', '对话', 'Bots 与 Agents', '任务', '知识与记忆', '设置']);
    await expect(nav.getByRole('link', { name: 'Bot', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: '运维' })).toHaveCount(0);
  });

  test('chat and bot surfaces coexist with the default coordinator [AC:default-super-bot#AC-1]', async ({ page, request }) => {
    await page.goto('/#/chat');
    await expect(page.locator('#nav-chat')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('composer-bot-face')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新增' })).toBeVisible();

    await page.locator('#nav-bot').click();
    await expect(page.locator('#nav-bot')).toHaveAttribute('aria-current', 'page');
    const { bot: defaultBot } = await (await request.get('/api/bot-work/default')).json();
    await expect(page.getByTestId('composer-bot-face')).toBeVisible();
    await expect(page.locator('#playTitle')).toHaveText(defaultBot.name);
    await expect(page.locator(`#sessionListMini [data-bot-id="${defaultBot.id}"] .list-item--session`)).toHaveClass(/\bselected\b/);
    await expect(page.locator('#botSelect')).toHaveCount(0);
    await expect(page.locator('.chat-composer-dock').getByRole('button', { name: '新建 Bot' })).toHaveCount(0);
    await page.locator('#nav-chat').click();
    await expect(page.getByTestId('composer-bot-face')).toHaveCount(0);

    // 统一新建入口在独立弹窗里创建，保留当前对话。
    await page.getByRole('button', { name: '新增' }).click();
    await page.getByRole('menuitem', { name: '新建 Bot', exact: true }).click();
    await expect(page).toHaveURL(/#\/chat/);
    await expect(page.getByRole('dialog', { name: '新建 Bot' })).toBeVisible();
    await expect(page.locator('#composerBotForm')).toHaveCount(0);
    const form = page.getByRole('form', { name: '新建 Bot' });
    await expect(form).toBeVisible();
    await expect(form.getByLabel('名称')).toBeVisible();
    await expect(form.getByLabel('显示标题')).toBeVisible();
    await expect(form.getByLabel('描述')).toBeVisible();
  });

  test('model setup dialog opens from the rail', async ({ page }) => {
    await page.goto('/');
    await page.locator('#btnModelSetup').click();
    const dialog = page.getByRole('dialog', { name: '配置模型' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radiogroup', { name: '服务商' })).toBeVisible();
    await expect(dialog.getByLabel('API Key')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '测试连接' })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('ops tab shows session trajectory workspace', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: '设置' }).click();
    await page.locator('#settings-cat-ops').click();
    await expect(page.locator('#panel-ops').getByRole('heading', { name: '会话', exact: true })).toBeVisible();
    await expect(page.locator('#panel-ops').getByRole('heading', { name: '会话轨迹', exact: true })).toBeVisible();
    await expect(page.locator('#listSessions')).toBeVisible();
    await expect(page.locator('#traceTimeline')).toBeVisible();
  });

  test('switching sections updates the URL and survives reload [AC:console-navigation#AC-2]', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: '设置' }).click();
    await page.locator('#settings-cat-ops').click();
    await expect(page).toHaveURL(/#\/settings\/ops\/trajectory$/);
    await expect(page.locator('#panel-ops')).toBeVisible();

    await page.getByRole('link', { name: 'Bots 与 Agents' }).click();
    await page.getByRole('tab', { name: /^Teams$/ }).click();
    await expect(page).toHaveURL(/#\/agents\/teams$/);
    await expect(page.locator('#panel-teams')).toBeVisible();
    await expect(page.locator('#panel-ops')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('#panel-teams')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Bots 与 Agents' })).toHaveAttribute('aria-current', 'page');
  });

  test('rail collapse hides labels and the choice survives reload', async ({ page }) => {
    await page.goto('/');
    const rail = page.getByRole('complementary', { name: '主导航' });
    await rail.getByRole('button', { name: '收起导航' }).click();
    await expect(rail).toHaveClass(/is-collapsed/);
    await rail.getByRole('link', { name: '知识与记忆' }).click();
    await expect(page).toHaveURL(/#\/knowledge/);
    await page.reload();
    const again = page.getByRole('complementary', { name: '主导航' });
    await expect(again).toHaveClass(/is-collapsed/);
    await again.getByRole('button', { name: '展开导航' }).click();
    await expect(again).not.toHaveClass(/is-collapsed/);
    await expect(again.getByRole('link', { name: '知识与记忆' })).toBeVisible();
  });

  test('draft in chat survives visiting another section [AC:console-navigation#AC-4]', async ({ page }) => {
    await page.goto('/#/chat');
    await page.getByLabel('消息内容').fill('keep this draft');
    await page.getByRole('link', { name: '设置' }).click();
    await expect(page.locator('#section-settings')).toBeVisible();
    await page.getByRole('link', { name: '对话' }).click();
    await expect(page.getByLabel('消息内容')).toHaveValue('keep this draft');
  });

  test('settings hide remaining advanced groups by default and search reveals experimental items [AC:console-settings#AC-1] [AC:console-settings#AC-2] [AC:console-settings#AC-3] [AC:console-settings#AC-4]', async ({ page }) => {
    await page.goto('/#/settings/integrations');
    const settings = page.locator('#section-settings');
    await expect(settings.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
    await expect(page.locator('#gw-feishu-token')).toBeVisible();
    await expect(page.locator('#gw-webhook-senders')).toHaveCount(0);
    await expect(page.locator('#setting-langfuse')).toHaveCount(0);

    await page.locator('#settingsSearch').fill('langfuse');
    await expect(page.locator('#setting-langfuse')).toBeVisible();
    await expect(page.locator('#setting-sandbox')).toHaveCount(0);

    await page.locator('#settingsSearch').fill('zzz-no-such-setting');
    await expect(settings.getByText('没有匹配的设置')).toBeVisible();

    await page.locator('#settingsSearch').fill('');
    await page.getByTestId('advanced-toggle').check();
    await expect(page.locator('#gw-webhook-senders')).toBeVisible();
    await expect(page.locator('#setting-langfuse')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('advanced-toggle')).toBeChecked();
    await expect(page.locator('#gw-webhook-senders')).toBeVisible();
  });

  test('playground send shows user bubble after run [AC:chat-basics#AC-1]', async ({ page }) => {
    await page.goto('/#/chat');
    const content = `e2e ${Date.now()}`;
    await page.getByLabel('消息内容').fill(content);
    await page.getByRole('button', { name: '发送' }).click();
    const box = page.locator('#playMessages');
    await expect(box.locator('.chat-turn--user .chat-bubble__body').first()).toContainText(content, {
      timeout: 60_000
    });
    await expect(page.locator('#playInput')).toHaveValue('');
  });
});
