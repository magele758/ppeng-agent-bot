import { test, expect, type APIRequestContext } from '@playwright/test';

const LOOP_DEFAULTS = {
  defaultTaskMode: 'auto',
  defaultSkillScope: 'full',
  steerInterruptPolicy: 'queue',
  steerDrainPolicy: 'next_shot_only',
  kernelVariant: 'agent-loop',
  assemblyPreset: 'max',
  inboxOverflowCap: null
};

async function resetSettings(request: APIRequestContext) {
  await request.patch('/api/loop/settings', { data: LOOP_DEFAULTS });
  await request.patch('/api/goals/settings', { data: { entityEnabled: true, defaultMaxTurns: 25, allowHttpVerify: true } });
  await request.patch('/api/sandbox/settings', { data: { mode: 'auto' } });
  await request.patch('/api/capabilities/settings', { data: { enabled: false, tailscaleEnabled: false, activeScanEnabled: false } });
}

test.describe('Settings categories: behavior / safety / tools / integrations', () => {
  test.beforeEach(async ({ request }) => {
    await resetSettings(request);
  });
  test.afterEach(async ({ request }) => {
    await resetSettings(request);
  });

  test('each category shows common settings; expert cards live in experimental [AC:settings-categories#AC-1]', async ({
    page
  }) => {
    const common: Array<[string, string]> = [
      ['behavior', 'agentLoop'],
      ['safety', 'sandbox'],
      ['tools', 'skills'],
      ['integrations', 'eventLog']
    ];
    const expert = ['agentLoopEngine', 'compact', 'goalVerify', 'sandboxCloudflare', 'dynTools', 'discovery', 'langfuse'];
    for (const [category, id] of common) {
      await page.goto(`/#/settings/${category}`);
      const entry = page.locator(`#setting-${id}`);
      await expect(entry).toBeVisible();
      await expect(entry.locator('.ui-group__desc').first()).toBeVisible();
      for (const hidden of expert) await expect(page.locator(`#setting-${hidden}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('advanced-toggle')).not.toBeChecked();
    await page.locator('#settings-cat-experimental').click();
    await expect(page).toHaveURL(/#\/settings\/experimental$/);
    for (const id of expert) {
      await expect(page.locator(`#setting-${id}`)).toBeVisible();
      await expect(page.locator(`#setting-${id} .ui-group__desc`).first()).toBeVisible();
    }
  });

  test('changing a select saves immediately and persists after reload [AC:settings-categories#AC-2]', async ({
    page,
    request
  }) => {
    await page.goto('/#/settings/behavior');
    const select = page.locator('#field-defaultTaskMode');
    await expect(select).toHaveValue('auto');
    await select.selectOption('fast');
    await expect(page.locator('#setting-agentLoop').getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    const saved = (await (await request.get('/api/loop/settings')).json()) as { settings: { defaultTaskMode: string } };
    expect(saved.settings.defaultTaskMode).toBe('fast');
    await page.reload();
    await expect(page.locator('#field-defaultTaskMode')).toHaveValue('fast');
  });

  test('non-default values show the default and can be restored [AC:settings-categories#AC-3]', async ({ page }) => {
    await page.goto('/#/settings/behavior');
    const entry = page.locator('#setting-agentLoop');
    await expect(entry.getByText('默认：自动').first()).toBeVisible();
    await expect(entry.getByRole('button', { name: '恢复默认' })).toHaveCount(0);
    await page.locator('#field-defaultTaskMode').selectOption('fast');
    const reset = entry.getByRole('button', { name: /恢复默认/ });
    await expect(reset).toHaveCount(1);
    await reset.click();
    await expect(page.locator('#field-defaultTaskMode')).toHaveValue('auto');
    await expect(entry.getByRole('button', { name: /恢复默认/ })).toHaveCount(0);
  });

  test('form fields show unsaved changes with save and undo [AC:settings-categories#AC-4]', async ({ page, request }) => {
    await page.goto('/#/settings/behavior');
    const entry = page.locator('#setting-goal');
    const input = page.locator('#field-goalMaxTurns');
    await expect(input).toHaveValue('25');
    await expect(entry.getByText('有未保存的修改')).toHaveCount(0);
    await expect(entry.getByRole('button', { name: '保存' })).toBeDisabled();
    await input.fill('40');
    await expect(entry.getByText('有未保存的修改')).toBeVisible();
    await entry.getByRole('button', { name: '撤销修改' }).click();
    await expect(input).toHaveValue('25');
    await expect(entry.getByText('有未保存的修改')).toHaveCount(0);

    await input.fill('40');
    await entry.getByRole('button', { name: '保存' }).click();
    await expect(entry.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    const saved = (await (await request.get('/api/goals/settings')).json()) as { settings: { defaultMaxTurns: number } };
    expect(saved.settings.defaultMaxTurns).toBe(40);
    await expect(entry.getByText('有未保存的修改')).toHaveCount(0);
  });

  test('out-of-range numbers show a range hint and are not saved [AC:settings-categories#AC-5]', async ({
    page,
    request
  }) => {
    await page.goto('/#/settings/behavior');
    const entry = page.locator('#setting-goal');
    await page.locator('#field-goalMaxTurns').fill('500');
    await entry.getByRole('button', { name: '保存' }).click();
    await expect(entry.getByRole('alert').filter({ hasText: '1–100' })).toBeVisible();
    const saved = (await (await request.get('/api/goals/settings')).json()) as { settings: { defaultMaxTurns: number } };
    expect(saved.settings.defaultMaxTurns).toBe(25);
  });

  test('risky choices show a warning that disappears when switching back [AC:settings-categories#AC-6]', async ({
    page,
    request
  }) => {
    await page.goto('/#/settings/safety');
    const sandbox = page.locator('#setting-sandbox');
    await expect(sandbox.getByRole('alert')).toHaveCount(0);
    await page.locator('#field-sandboxMode').selectOption('direct');
    await expect(sandbox.getByRole('alert').filter({ hasText: '无隔离' })).toBeVisible();
    await page.locator('#field-sandboxMode').selectOption('auto');
    await expect(sandbox.getByRole('alert')).toHaveCount(0);

    await request.patch('/api/capabilities/settings', { data: { enabled: true } });
    await page.goto('/#/settings/experimental');
    const discovery = page.locator('#setting-discovery');
    await expect(discovery.getByRole('alert')).toHaveCount(0);
    await page.locator('#field-discoveryActiveScan').check();
    await expect(discovery.getByRole('alert').filter({ hasText: '主动扫描' })).toBeVisible();
    await page.locator('#field-discoveryActiveScan').uncheck();
    await expect(discovery.getByRole('alert')).toHaveCount(0);
  });

  test('plain-language search finds advanced settings across categories [AC:settings-categories#AC-7]', async ({
    page
  }) => {
    await page.goto('/#/settings/behavior');
    const search = page.locator('#settingsSearch');
    const cases: Array<[string, string]> = [
      ['上下文太长', 'compact'],
      ['审计', 'eventLog'],
      ['追踪', 'langfuse'],
      ['无隔离', 'sandbox']
    ];
    for (const [query, id] of cases) {
      await search.fill(query);
      await expect(page.locator(`#setting-${id}`)).toBeVisible();
    }
  });

  test('English locale renders all four categories without Chinese text [AC:settings-categories#AC-8]', async ({
    page
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('lab.locale', 'en');
      window.localStorage.setItem('lab.settings.advanced', '1');
    });
    for (const category of ['behavior', 'safety', 'tools', 'integrations']) {
      await page.goto(`/#/settings/${category}`);
      const entries = page.locator('.settings-entries');
      await expect(entries.locator('.settings-entry').first()).toBeVisible();
      await expect(entries.getByRole('heading').first()).toBeVisible();
      const chrome = await entries.evaluate((root) => {
        const clone = root.cloneNode(true) as HTMLElement;
        // Bot names in pickers are stored records, not settings chrome.
        clone.querySelectorAll('option').forEach((node) => node.remove());
        return clone.textContent ?? '';
      });
      expect(chrome).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
});
