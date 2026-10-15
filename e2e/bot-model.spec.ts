import { test, expect, type APIRequestContext } from '@playwright/test';

type SessionBody = { session: { metadata: { modelOverride?: { providerId: string; modelId: string } } } };

async function pinnedModel(request: APIRequestContext, sessionId: string) {
  const res = await request.get(`/api/sessions/${sessionId}`);
  return ((await res.json()) as SessionBody).session.metadata.modelOverride?.modelId;
}

test.describe('Bot model setting', () => {
  let providerId = '';

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/model-providers', {
      data: {
        name: 'E2E Bot Model',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-e2e-bot-model',
        models: [
          { id: 'e2e-model-a', enabled: true },
          { id: 'e2e-model-b', enabled: true }
        ]
      }
    });
    expect(res.status()).toBe(201);
    providerId = ((await res.json()) as { provider: { id: string } }).provider.id;
  });

  test.afterAll(async ({ request }) => {
    if (providerId) await request.delete(`/api/model-providers/${providerId}`);
  });

  test('pick a model for the Bot, persist it across reload, then follow default again [AC:bots#AC-4] [AC:agents-management#AC-6]', async ({
    page,
    request
  }) => {
    const name = `E2E Model ${Date.now()}`;
    const created = await request.post('/api/bots', { data: { name } });
    expect(created.status()).toBe(201);
    const { bot } = (await created.json()) as { bot: { id: string } };
    const opened = await request.post(`/api/bots/${bot.id}/open`);
    const { session } = (await opened.json()) as { session: { id: string } };

    const openSettings = async () => {
      await page.goto('/#/agents/bots');
      await page.getByRole('listitem').filter({ hasText: name }).first().click();
      await expect(page.getByTestId('bot-detail').getByLabel('Bot 使用的模型')).toBeEnabled();
    };
    const composerModelSelect = async () => {
      await page.getByTestId('bot-detail').getByRole('button', { name: '打开对话' }).click();
      await expect(page.locator('#playModelSelect')).toBeVisible();
      await expect(page).toHaveURL(/#\/bot/);
      await expect(page.locator('#nav-bot')).toHaveAttribute('aria-current', 'page');
      return page.locator('#playModelSelect');
    };

    await openSettings();
    const select = page.getByLabel('Bot 使用的模型');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('');
    await expect(select.locator('option', { hasText: '跟随默认' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'e2e-model-b' })).toHaveCount(1);

    await select.selectOption({ label: 'e2e-model-b' });
    await expect.poll(() => pinnedModel(request, session.id)).toBe('e2e-model-b');
    await expect(select).toHaveValue(`${providerId}::e2e-model-b`);
    await expect(await composerModelSelect()).toBeDisabled();

    await openSettings();
    await expect(page.getByLabel('Bot 使用的模型')).toHaveValue(`${providerId}::e2e-model-b`);

    await page.getByLabel('Bot 使用的模型').selectOption('');
    await expect.poll(() => pinnedModel(request, session.id)).toBeUndefined();
    await expect(page.getByLabel('Bot 使用的模型')).toHaveValue('');
    await expect(await composerModelSelect()).toBeEnabled();
  });

  test('the daemon rejects a model that is not in the configured list [AC:bots#AC-4]', async ({ request }) => {
    const created = await request.post('/api/bots', { data: { name: `E2E Bad Model ${Date.now()}` } });
    const { bot } = (await created.json()) as { bot: { id: string } };
    const bad = await request.patch(`/api/bots/${bot.id}`, {
      data: { modelOverride: { providerId, modelId: 'not-configured' } }
    });
    expect(bad.status()).toBe(400);
  });
});
