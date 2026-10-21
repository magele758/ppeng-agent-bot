import { expect, test, type Page } from '@playwright/test';

async function start(page: Page, locale = 'zh') {
  const session = { id: 'retry-e2e', title: 'retry acceptance', mode: 'chat', status: 'running', agentId: 'general', metadata: {} };
  await page.route(/\/api\/sessions\/retry-e2e(?:\?|$)/, route => route.fulfill({ json: {
    session, messages: [{ id: 'retry-user', sessionId: session.id, seq: 1, role: 'user', parts: [{ type: 'text', text: 'retry acceptance message' }] }],
  } }));
  await page.route('**/api/sessions/retry-e2e/cancel', route => route.fulfill({ json: { session: { ...session, status: 'idle' } } }));
  await page.addInitScript((locale) => {
    localStorage.setItem('lab.locale', locale);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/api/chat/stream')) {
        const stream = new ReadableStream({ start(controller) {
          (window as any).retryEmit = (event: string, data: unknown) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          (window as any).retryEnd = () => controller.close();
        }});
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  }, locale);
  await page.goto('/');
  await page.locator('#playInput').fill('retry acceptance message');
  await page.locator('#btnSend').click();
  await page.waitForFunction(() => typeof (window as any).retryEmit === 'function');
  await emit(page, { session }, 'session');
}

async function emit(page: Page, data: Record<string, unknown>, event = 'model') {
  await page.evaluate(({ event, data }) => (window as any).retryEmit(event, data), { event, data });
}

const progress = { type: 'model_retry', phase: 'waiting', model: 'alpha-1', retry: 1, maxRetries: 5, requests: 1, message: 'HTTP 503', reason: 'temporary', delayMs: 8000 };

for (const locale of ['zh', 'en']) {
  test(`retry progress counts down and switches models (${locale}) [AC:model-retry-progress#AC-6]`, async ({ page }) => {
    await start(page, locale);
    await emit(page, progress);
    const status = page.getByTestId('model-retry-progress');
    await expect(status).toContainText('alpha-1');
    await expect(status).toContainText('1/5');
    await expect(status).toContainText('HTTP 503');
    await expect(status).toContainText(locale === 'zh' ? '8 秒' : '8s');
    await expect(status).toContainText(locale === 'zh' ? '7 秒' : '7s');
    await emit(page, { ...progress, phase: 'requesting' });
    await expect(status).toContainText(locale === 'zh' ? '正在重试' : 'Retrying');
    await emit(page, { ...progress, phase: 'switching', model: 'beta-1' });
    await expect(status).toContainText('beta-1');
    await expect(status).toContainText(locale === 'zh' ? '切换' : 'Switching');
  });
}

test('successful retry clears progress and replaces partial text [AC:model-retry-progress#AC-8]', async ({ page }) => {
  await start(page);
  await emit(page, { type: 'text_delta', text: 'discard this partial' });
  await emit(page, progress);
  await expect(page.getByTestId('model-retry-progress')).toBeVisible();
  await emit(page, { type: 'stream_reset', reason: 'retry' });
  await emit(page, { type: 'text_delta', text: 'successful answer' });
  await emit(page, { ...progress, phase: 'recovered' });
  await expect(page.getByTestId('model-retry-progress')).toHaveCount(0);
  await expect(page.locator('#playMessages')).not.toContainText('discard this partial');
  await expect(page.locator('#playMessages')).toContainText('successful answer');
  await expect(page.locator('.chat-turn--user', { hasText: 'retry acceptance message' })).toHaveCount(1);
});

test('exhaustion reports total requests and preserves the user message [AC:model-retry-progress#AC-9]', async ({ page }) => {
  await start(page);
  await emit(page, progress);
  await emit(page, { ...progress, phase: 'failed', reason: 'exhausted', requests: 8, message: 'HTTP 503 unavailable' });
  await emit(page, { message: 'HTTP 503 unavailable' }, 'error');
  await expect(page.getByTestId('model-retry-progress')).toHaveCount(0);
  await expect(page.locator('.chat-turn--streaming')).toHaveCount(0);
  await expect(page.getByText(/自动重试已耗尽.*8.*HTTP 503 unavailable/)).toBeVisible();
  await expect(page.locator('#playMessages')).toContainText('retry acceptance message');
});

test('stop dismisses retry progress immediately [AC:model-retry-progress#AC-7]', async ({ page }) => {
  await start(page);
  await emit(page, progress);
  await expect(page.getByTestId('model-retry-progress')).toBeVisible();
  await page.locator('#btnStopChat').click();
  await expect(page.getByTestId('model-retry-progress')).toHaveCount(0, { timeout: 1000 });
  await expect(page.getByText('已停止', { exact: true })).toBeVisible({ timeout: 1000 });
});
