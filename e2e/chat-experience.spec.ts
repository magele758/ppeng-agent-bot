import { test, expect, type Page } from '@playwright/test';

const LONG_BASH_PROMPT = '跑一段长 bash dump';
const STORED_MARKER = 'MODEL_VIEW_BASH_MARKER-';

async function sendAndWait(page: Page, text: string) {
  await page.getByLabel('消息内容').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('#playMessages .chat-turn--streaming')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('Chat experience', () => {
  test('the composer shows only the essentials; secondary options sit behind one session-settings entry [AC:chat-experience#AC-1]', async ({
    page
  }) => {
    await page.goto('/');
    const composer = page.locator('.chat-composer-outer');
    await expect(composer.getByLabel('消息内容')).toBeVisible();
    await expect(composer.getByRole('button', { name: '发送' })).toBeVisible();
    await expect(composer.getByRole('button', { name: '附件' })).toBeVisible();
    await expect(composer.getByRole('button', { name: '选择可用模型' })).toBeVisible();
    await expect(composer.getByLabel('工作区')).toBeVisible();
    await expect(composer.locator('.composer-config-summary')).toBeVisible();

    await expect(page.getByLabel('通用执行模式')).toHaveCount(0);
    await expect(page.getByLabel('自主度')).toHaveCount(0);
    await expect(page.getByLabel('目标条件')).toHaveCount(0);
    await expect(page.locator('#composerConfigPanel')).toHaveCount(0);
  });

  test('common options are visible at once, the rest hides under a collapsed Advanced section [AC:chat-experience#AC-2]', async ({
    page
  }) => {
    await page.goto('/');
    await page.locator('.composer-config-summary').click();
    const panel = page.locator('#composerConfigPanel');
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('通用执行模式')).toBeVisible();
    await expect(panel.getByLabel('Agent', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('自主度')).toBeVisible();

    const advanced = panel.locator('details.session-settings__advanced');
    await expect(advanced).toHaveCount(1);
    await expect(advanced).not.toHaveAttribute('open', '');
    await expect(panel.getByLabel('目标条件')).toBeHidden();

    await advanced.locator(':scope > summary').click();
    await expect(panel.getByLabel('目标条件')).toBeVisible();
    await expect(panel.getByLabel('任务编排引擎')).toBeVisible();
  });

  test('global loop / compaction settings are not duplicated in the panel and link to Settings [AC:chat-experience#AC-3]', async ({
    page
  }) => {
    await page.goto('/');
    await page.locator('.composer-config-summary').click();
    const panel = page.locator('#composerConfigPanel');
    await expect(panel).toBeVisible();
    await panel.locator('details.session-settings__advanced > summary').click();
    await expect(panel.getByLabel('工具结果压缩策略')).toHaveCount(0);
    await expect(panel.locator('#card-agent-loop, #card-compact')).toHaveCount(0);
    await expect(panel.getByText('Agent 循环', { exact: false })).toHaveCount(0);

    await panel.getByRole('link', { name: /全局设置/ }).click();
    await expect(page.locator('#section-settings')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings/);
  });

  test('tool calls, results and thinking are collapsed by default and expand on click [AC:chat-experience#AC-4]', async ({
    page
  }) => {
    await page.goto('/');
    await page.getByRole("button", { name: "新增" }).click();
    await page.getByRole("menuitem", { name: /新建会话/ }).click();
    await page.locator(".composer-config-summary").click();
    await page.locator("#composerConfigPanel").getByLabel("Agent", { exact: true }).selectOption("");
    await page.locator(".composer-config-summary").click();
    await sendAndWait(page, LONG_BASH_PROMPT);

    const folds = page.locator('#playMessages .chat-tool-fold');
    await expect(folds.first()).toBeVisible({ timeout: 30_000 });
    const count = await folds.count();
    for (let i = 0; i < count; i += 1) {
      await expect(folds.nth(i)).not.toHaveAttribute('open', '');
    }

    const resultFold = page.locator('#playMessages .chat-tool-fold--result').first();
    await expect(resultFold.locator(':scope > summary .chat-tool-fold__name')).not.toBeEmpty();
    await resultFold.locator(':scope > summary').click();
    await expect(resultFold.locator('.chat-tool-io__block--out')).toContainText(STORED_MARKER);

    await expect(page.locator('#playMessages .chat-turn--assistant .chat-bubble__md').last()).toBeVisible();
  });

  test('the session list groups by date, only busy or failed sessions carry a status label, and it filters [AC:chat-experience#AC-5]', async ({
    page
  }) => {
    await page.goto('/');
    const title = `e2e list ${Date.now()}`;
    await sendAndWait(page, title);

    const list = page.locator('#sessionListMini');
    await expect(list.locator('.session-date-group__label').first()).toBeVisible();
    const item = list.locator('.list-item--session', { hasText: title });
    await expect(item).toBeVisible();
    await expect(item.locator('.session-item__title')).toContainText(title);
    await expect(item.locator('.session-item__status')).toHaveCount(0);

    await page.getByRole('button', { name: '新增' }).click();
    await page.getByRole('menuitem', { name: /新建会话/ }).click();
    await page.getByRole('button', { name: '筛选会话', exact: true }).click();
    await page.getByLabel('筛选会话列表').fill('zzz-no-such-session-zzz');
    await expect(item).toHaveCount(0);
    await page.getByLabel('筛选会话列表').fill(title);
    await expect(item).toBeVisible();
  });

  test('the Bot view points to Bots & Agents for managing bots [AC:chat-experience#AC-6]', async ({ page }) => {
    await page.goto('/');
    await page.locator('#nav-bot').click();
    await page.locator('#sessionListMini .list-item--bot-chat').first().click();
    await expect(page.getByTestId('bot-detail-toggle')).toHaveCount(1);
    const manage = page.locator('#panel-play').getByRole('link', { name: /的权限设置/ });
    await expect(manage.first()).toBeVisible();
    await manage.first().click();
    await expect(page.locator('#section-agents')).toBeVisible();
    await expect(page).toHaveURL(/#\/agents\/bots/);
  });
});
