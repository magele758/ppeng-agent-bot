import { test, expect, type Page, type Route } from '@playwright/test';

type Provider = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  useJsonMode: boolean;
  models: Array<{ id: string; enabled: boolean }>;
  createdAt: string;
  updatedAt: string;
  source: 'ui' | 'builtin';
};

const NOW = '2026-01-01T00:00:00.000Z';

const heuristic: Provider = {
  id: 'heuristic',
  name: '本地启发式',
  kind: 'heuristic',
  baseUrl: '',
  hasApiKey: false,
  apiKeyMasked: '',
  useJsonMode: false,
  models: [{ id: 'heuristic', enabled: true }],
  createdAt: NOW,
  updatedAt: NOW,
  source: 'builtin'
};

function catalog(providers: Provider[], defaultRef: { providerId: string; modelId: string }) {
  return {
    catalog: { providers, defaultRef, updatedAt: NOW },
    options: providers.flatMap((p) =>
      p.models
        .filter((m) => m.enabled)
        .map((m) => ({ providerId: p.id, providerName: p.name, modelId: m.id, kind: p.kind, source: p.source }))
    ),
    persisted: providers.some((p) => p.source === 'ui'),
    effective: { source: providers.some((p) => p.source === 'ui') ? 'ui' : 'heuristic', defaultRef }
  };
}

const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** In-memory model catalog so the wizard is exercised without touching the shared daemon state. */
async function mockModelCatalog(page: Page, opts: { scan?: 'ok' | 'auth' } = {}) {
  const state = {
    providers: [heuristic] as Provider[],
    defaultRef: { providerId: 'heuristic', modelId: 'heuristic' },
    scanBodies: [] as unknown[],
    createBodies: [] as Array<Record<string, unknown>>,
    defaultBodies: [] as unknown[],
    scan: opts.scan ?? 'ok'
  };
  await page.route(/\/api\/model-providers(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      state.createBodies.push(body);
      const provider: Provider = {
        id: 'prov-e2e',
        name: String(body.name || 'DeepSeek'),
        kind: String(body.kind),
        baseUrl: String(body.baseUrl),
        hasApiKey: true,
        apiKeyMasked: 'sk-…cret',
        useJsonMode: true,
        models: (body.models as Array<{ id: string; enabled: boolean }>) ?? [],
        createdAt: NOW,
        updatedAt: NOW,
        source: 'ui'
      };
      state.providers = [heuristic, provider];
      await fulfillJson(route, { provider, ...catalog(state.providers, state.defaultRef) }, 201);
      return;
    }
    await fulfillJson(route, catalog(state.providers, state.defaultRef));
  });
  await page.route('**/api/model-providers/default', async (route) => {
    const body = route.request().postDataJSON() as { defaultRef: { providerId: string; modelId: string } };
    state.defaultBodies.push(body);
    state.defaultRef = body.defaultRef;
    await fulfillJson(route, catalog(state.providers, state.defaultRef));
  });
  await page.route('**/api/model-providers/preview-scan', async (route) => {
    state.scanBodies.push(route.request().postDataJSON());
    if (state.scan === 'auth') {
      await fulfillJson(route, {
        ok: false,
        error: 'HTTP 401: {"error":"Incorrect API key"} (https://api.deepseek.com/v1/models, status 401)',
        models: []
      });
      return;
    }
    await fulfillJson(route, {
      ok: true,
      endpoint: 'https://api.deepseek.com/v1/models',
      suggestedName: 'DeepSeek',
      models: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }, { id: 'text-embedding-x' }]
    });
  });
  return state;
}

test.describe('Settings: model onboarding and guided setup', () => {
  test('first-run hint shows while only the demo model exists and disappears once configured [AC:settings-models-onboarding#AC-1]', async ({
    page
  }) => {
    const state = await mockModelCatalog(page);
    await page.goto('/#/settings/general');
    const banner = page.locator('#model-onboarding');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('还没有配置真实模型');
    await banner.getByRole('button', { name: '去配置模型' }).click();
    await expect(page).toHaveURL(/#\/settings\/models$/);

    state.providers = [
      heuristic,
      {
        ...heuristic,
        id: 'real',
        name: 'DeepSeek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        hasApiKey: true,
        apiKeyMasked: 'sk-…1234',
        models: [{ id: 'deepseek-chat', enabled: true }],
        source: 'ui'
      }
    ];
    await page.reload();
    await expect(page.locator('#setting-modelProviders')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#model-onboarding')).toHaveCount(0);
  });

  test('guided flow only needs an API key, auto-picks a model, and saves as default [AC:settings-models-onboarding#AC-2] [AC:settings-models-onboarding#AC-3]', async ({
    page
  }) => {
    const state = await mockModelCatalog(page);
    await page.goto('/#/settings/models');
    const wizard = page.locator('#model-wizard');
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    await wizard.getByRole('radio', { name: 'DeepSeek' }).click();
    await expect(wizard.getByLabel('API Key')).toBeVisible();
    await expect(wizard.getByLabel('Base URL')).toHaveCount(0);
    await expect(wizard.getByLabel('协议')).toHaveCount(0);
    await expect(wizard.getByLabel('服务商名称')).toHaveCount(0);

    await wizard.getByLabel('API Key').fill('sk-secret');
    await wizard.getByRole('button', { name: '测试连接' }).click();
    await expect(wizard.getByRole('status').filter({ hasText: '连接成功，发现 3 个模型' })).toBeVisible();
    await expect(wizard.getByLabel('默认模型')).toHaveValue('deepseek-chat');
    expect(state.scanBodies[0]).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-secret'
    });

    await wizard.getByRole('button', { name: '保存并使用 deepseek-chat' }).click();
    await expect(wizard.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    expect(state.createBodies).toHaveLength(1);
    expect(state.createBodies[0]).toMatchObject({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-secret' });
    expect(state.defaultBodies[0]).toEqual({ defaultRef: { providerId: 'prov-e2e', modelId: 'deepseek-chat' } });
    await expect(page.locator('#model-onboarding')).toHaveCount(0);
  });

  test('a failed connection test explains what to fix and allows retrying [AC:settings-models-onboarding#AC-4]', async ({
    page
  }) => {
    await mockModelCatalog(page, { scan: 'auth' });
    await page.goto('/#/settings/models');
    const wizard = page.locator('#model-wizard');
    await wizard.getByRole('radio', { name: 'DeepSeek' }).click();
    await wizard.getByLabel('API Key').fill('sk-wrong');
    await wizard.getByRole('button', { name: '测试连接' }).click();
    const alert = wizard.getByRole('alert');
    await expect(alert).toContainText('API Key 无效');
    await expect(alert).not.toContainText('status 401');
    await expect(wizard.getByRole('button', { name: '测试连接' })).toBeEnabled();
  });

  test('advanced options (name, protocol, Base URL, per-model list) stay hidden until opened [AC:settings-models-onboarding#AC-5]', async ({
    page
  }) => {
    await mockModelCatalog(page);
    await page.goto('/#/settings/models');
    const wizard = page.locator('#model-wizard');
    await wizard.getByRole('radio', { name: 'DeepSeek' }).click();
    await wizard.getByLabel('API Key').fill('sk-secret');
    await wizard.getByRole('button', { name: '测试连接' }).click();
    await expect(wizard.getByLabel('默认模型')).toBeVisible();
    await expect(wizard.getByRole('checkbox')).toHaveCount(0);

    await wizard.getByRole('button', { name: '高级选项' }).click();
    await expect(wizard.getByLabel('服务商名称')).toBeVisible();
    await expect(wizard.getByLabel('协议')).toBeVisible();
    await expect(wizard.getByLabel('Base URL')).toHaveValue('https://api.deepseek.com/v1');
    await expect(wizard.getByRole('checkbox')).toHaveCount(3);

    await wizard.getByRole('button', { name: '收起高级选项' }).click();
    await expect(wizard.getByLabel('Base URL')).toHaveCount(0);
  });
});

test.describe('Settings: search, saved states, gateway, theme', () => {
  test('search matches category names and synonyms, shows a count, and clears [AC:settings-models-onboarding#AC-6]', async ({
    page
  }) => {
    await mockModelCatalog(page);
    await page.goto('/#/settings/general');
    const search = page.locator('#settingsSearch');
    await search.fill('key');
    await expect(page.locator('#setting-modelProviders')).toBeVisible();
    await expect(page.locator('#setting-language')).toHaveCount(0);
    await expect(page.getByTestId('settings-search-count')).toBeVisible();

    await search.fill('飞书');
    await expect(page.locator('#setting-gateway')).toBeVisible();

    await search.fill('theme');
    await expect(page.locator('#setting-theme')).toBeVisible();

    await search.fill('通用');
    await expect(page.locator('#setting-language')).toBeVisible();
    await expect(page.locator('#setting-theme')).toBeVisible();

    await page.getByRole('button', { name: '清除搜索' }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('settings-search-count')).toHaveCount(0);
    await expect(page.locator('#setting-language')).toBeVisible();
  });

  test('fallback card flags unsaved edits and confirms saves [AC:settings-models-onboarding#AC-7]', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('lab.settings.advanced', '1'));
    let chain: Array<{ providerId: string; modelId: string }> = [];
    const view = () => ({
      settings: { chain, enabled: true, updatedAt: NOW },
      options: [{ providerId: 'p1', providerName: 'Prov', modelId: 'm1', kind: 'openai-compatible' }],
      chainStatus: chain.map((c) => ({ ...c, usable: true })),
      effective: { enabled: chain.length > 0, source: chain.length ? 'ui' : 'default' }
    });
    await page.route('**/api/model-fallback/settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        chain = (route.request().postDataJSON() as { chain: typeof chain }).chain;
      }
      await fulfillJson(route, view());
    });
    await mockModelCatalog(page);
    await page.goto('/#/settings/experimental');
    const card = page.locator('#card-model-fallback');
    await expect(card.getByRole('button', { name: '保存备选链' })).toBeDisabled({ timeout: 15_000 });
    await expect(card.getByText('有未保存的修改')).toHaveCount(0);

    await card.getByLabel('添加备选模型').selectOption({ label: 'Prov / m1' });
    await card.getByRole('button', { name: '添加', exact: true }).click();
    await expect(card.getByText('有未保存的修改')).toBeVisible();
    await expect(card.getByRole('button', { name: '保存备选链' })).toBeEnabled();

    await card.getByRole('button', { name: '保存备选链' }).click();
    await expect(card.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    await expect(card.getByText('有未保存的修改')).toHaveCount(0);
    await expect(card.getByRole('button', { name: '保存备选链' })).toBeDisabled();
  });

  test('gateway card never shows secrets and only sends what changed [AC:settings-models-onboarding#AC-7] [AC:settings-models-onboarding#AC-8]', async ({
    page
  }) => {
    const patches: Array<Record<string, unknown>> = [];
    let feishuTokenSet = true;
    let senders: string[] = ['ou_existing'];
    await page.route('**/api/gateway/settings', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, any>;
        patches.push(body);
        if (body.feishu?.verificationToken === null) feishuTokenSet = false;
        if (body.feishu?.allowedSenders) senders = body.feishu.allowedSenders;
      }
      await fulfillJson(route, {
        settings: {
          feishu: { verificationTokenSet: feishuTokenSet, encryptKeySet: false, allowedSenders: senders },
          wecom: { bridgeSecretSet: false, allowedSenders: [] },
          webhook: { allowedSenders: [] },
          updatedAt: NOW
        }
      });
    });
    await mockModelCatalog(page);
    await page.goto('/#/settings/integrations');
    const card = page.locator('#card-gateway');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('已设置').first()).toBeVisible();
    await expect(card.getByRole('button', { name: '保存网关设置' })).toBeDisabled();

    await card.getByLabel('飞书 Encrypt Key').fill('enc-secret-123');
    await card.getByLabel('飞书发送者白名单').fill('ou_existing\nou_new');
    await expect(card.getByText('有未保存的修改')).toBeVisible();
    await card.getByRole('button', { name: '保存网关设置' }).click();
    await expect(card.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      feishu: { encryptKey: 'enc-secret-123', allowedSenders: ['ou_existing', 'ou_new'] }
    });
    await expect(card.getByLabel('飞书 Encrypt Key')).toHaveValue('');
    await expect(page.locator('body')).not.toContainText('enc-secret-123');

    await card.getByRole('button', { name: '清除飞书 Verification Token' }).click();
    await card.getByRole('button', { name: '保存网关设置' }).click();
    await expect(card.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    expect(patches[1]).toEqual({ feishu: { verificationToken: null } });
  });

  test('theme choice applies immediately and survives reload [AC:settings-models-onboarding#AC-9]', async ({ page }) => {
    await mockModelCatalog(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/#/settings/general');
    const group = page.getByRole('radiogroup', { name: '主题' });
    await expect(group).toBeVisible({ timeout: 15_000 });
    await group.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(group.getByRole('radio', { name: '深色' })).toBeChecked();

    await group.getByRole('radio', { name: '浅色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await group.getByRole('radio', { name: '跟随系统' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => window.localStorage.getItem('theme'))).toBeNull();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('Login screen', () => {
  const requireLogin = (page: Page, providers: string[]) =>
    page.route('**/api/auth/me', (route) => fulfillJson(route, { loginRequired: true, providers, user: null }));

  test('shows the available sign-in methods, clear errors, and setup guidance [AC:settings-models-onboarding#AC-10]', async ({
    page
  }) => {
    await requireLogin(page, ['google', 'github']);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登录 Agent Home' })).toBeVisible();
    await expect(page.getByRole('link', { name: '使用 Google 登录' })).toHaveAttribute('href', '/api/auth/google/start');
    await expect(page.getByRole('link', { name: '使用 GitHub 登录' })).toHaveAttribute('href', '/api/auth/github/start');
    await expect(page.locator('.login-card__error')).toHaveCount(0);

    await page.goto('/?auth_error=denied');
    await expect(page.locator('.login-card__error')).toContainText('登录已取消');
    await page.goto('/?auth_error=failed');
    await expect(page.locator('.login-card__error')).toContainText('登录失败');
  });

  test('explains how to enable login when no method is configured [AC:settings-models-onboarding#AC-10]', async ({
    page
  }) => {
    await requireLogin(page, []);
    await page.goto('/');
    await expect(page.getByText('尚未配置登录方式')).toBeVisible();
    await expect(page.getByText('RAW_AGENT_OAUTH_GOOGLE_CLIENT_ID', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: /使用 .* 登录/ })).toHaveCount(0);
  });
});
