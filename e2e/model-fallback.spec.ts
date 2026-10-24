import { test, expect } from '@playwright/test';

type FallbackBody = { settings: { chain: Array<{ providerId: string; modelId: string }> } };

test.describe('Model fallback card', () => {
  let providerId = '';

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/model-providers', {
      data: {
        name: 'E2E Fallback Provider',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-e2e-fallback',
        models: [
          { id: 'e2e-fb-one', enabled: true },
          { id: 'e2e-fb-two', enabled: true }
        ]
      }
    });
    expect(res.status()).toBe(201);
    providerId = ((await res.json()) as { provider: { id: string } }).provider.id;
    expect((await request.patch('/api/model-fallback/settings', {data:{chain:[],enabled:true}})).ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.patch('/api/model-fallback/settings', { data: { chain: [], enabled: false } });
    if (providerId) await request.delete(`/api/model-providers/${providerId}`);
  });

  test('build an ordered chain, save, and keep it after reload [AC:model-fallback#AC-1]', async ({ page, request }) => {
    await page.addInitScript(() => window.localStorage.setItem('lab.settings.advanced', '1'));
    await page.goto('/#/settings/experimental');
    const card = page.locator('#card-model-fallback');
    await expect(card.getByRole('heading', { name: '模型备选' })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('未配置备选模型，当前不会回退')).toBeVisible();

    const add = async (modelId: string) => {
      await card.getByLabel('添加备选模型').selectOption({ label: `E2E Fallback Provider / ${modelId}` });
      await card.getByRole('button', { name: '添加', exact: true }).click();
    };
    await add('e2e-fb-one');
    await add('e2e-fb-two');
    const rows = card.locator('[data-testid^="model-fallback-row-"]');
    await expect(rows).toHaveCount(2);

    await rows.nth(1).getByRole('button', { name: '上移' }).click();
    await expect(rows.nth(0)).toContainText('e2e-fb-two');
    await expect(rows.nth(1)).toContainText('e2e-fb-one');

    await card.getByRole('button', { name: '保存备选链' }).click();
    await expect(card.getByText('已保存，立即生效')).toBeVisible();

    const saved = (await (await request.get('/api/model-fallback/settings')).json()) as FallbackBody;
    expect(saved.settings.chain.map((r) => r.modelId)).toEqual(['e2e-fb-two', 'e2e-fb-one']);

    await page.reload();
    const reloaded = page.locator('#card-model-fallback').locator('[data-testid^="model-fallback-row-"]');
    await expect(reloaded).toHaveCount(2);
    await expect(reloaded.nth(0)).toContainText('e2e-fb-two');
    await expect(reloaded.nth(1)).toContainText('e2e-fb-one');

    await reloaded.nth(0).getByRole('button', { name: '移除' }).click();
    await page.locator('#card-model-fallback').getByRole('button', { name: '保存备选链' }).click();
    await expect(page.locator('#card-model-fallback').locator('[data-testid^="model-fallback-row-"]')).toHaveCount(1);
    const after = (await (await request.get('/api/model-fallback/settings')).json()) as FallbackBody;
    expect(after.settings.chain.map((r) => r.modelId)).toEqual(['e2e-fb-one']);
  });

  test('the daemon rejects models that are not configured [AC:model-fallback#AC-2]', async ({ request }) => {
    const bad = await request.patch('/api/model-fallback/settings', {
      data: { chain: [{ providerId, modelId: 'not-configured' }] }
    });
    expect(bad.status()).toBe(400);
  });
});
