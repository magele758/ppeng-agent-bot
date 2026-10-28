import { test, expect, type Page } from '@playwright/test';

/**
 * The renderer's fold + binding logic is unit-tested in core; here we
 *   1) pin the browser ↔ daemon action-callback contract;
 *   2) render a hand-crafted SurfaceUpdatePart payload through the live
 *      A2uiSurface + bindings + basic-catalog renderers and verify the
 *      DOM actually paints (so a refactor that breaks rendering is caught).
 */

const ACTION_FIXTURE = {
  surfaceId: 'a2ui-e2e',
  name: 'demo.click',
  context: { source: 'playwright' }
};

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';

async function createChatSession(page: Page): Promise<string> {
  const baseUrl = page.context()._options.baseURL ?? 'http://127.0.0.1:33815';
  const res = await page.request.post(`${baseUrl}/api/chat`, {
    data: {
      title: 'a2ui-e2e',
      message: 'a2ui e2e bootstrap',
      autoRun: false
    }
  });
  expect(res.ok(), `chat bootstrap: HTTP ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return body.session.id as string;
}

test.describe('A2UI', () => {
  test('action endpoint accepts a synthetic click from the browser', async ({ page }) => {
    await page.goto('/#/chat');
    const sessionId = await createChatSession(page);

    // Drive the action POST exactly like A2uiSurface.postAction would.
    const baseUrl = page.context()._options.baseURL ?? 'http://127.0.0.1:33815';
    const res = await page.request.post(
      `${baseUrl}/api/sessions/${sessionId}/a2ui/action`,
      {
        data: { ...ACTION_FIXTURE, autoRun: false }
      }
    );
    expect(res.ok(), `action: HTTP ${res.status()}`).toBeTruthy();

    // The synthetic user message should be present in the session log.
    const sess = await page.request.get(`${baseUrl}/api/sessions/${sessionId}`);
    expect(sess.ok()).toBeTruthy();
    const data = await sess.json();
    const messages = data.messages as Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    const synthetic = messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'text' && p.text?.startsWith('[a2ui:action demo.click]'));
    expect(synthetic, 'expected [a2ui:action demo.click] user message').toBeTruthy();
  });

  test('rejects malformed action payloads', async ({ page }) => {
    await page.goto('/#/chat');
    const sessionId = await createChatSession(page);
    const baseUrl = page.context()._options.baseURL ?? 'http://127.0.0.1:33815';
    const res = await page.request.post(
      `${baseUrl}/api/sessions/${sessionId}/a2ui/action`,
      { data: { surfaceId: '', name: '' }, failOnStatusCode: false }
    );
    expect(res.status()).toBe(400);
  });

  test('renders a surface_update part injected into the session response', async ({ page }) => {
    // Intercept the session detail fetch and return a hand-crafted SurfaceUpdatePart.
    // That payload exercises the A2uiSurface renderer, JSON Pointer bindings,
    // and the basic catalog (Card / Column / Text / Button) end-to-end.
    const sessionId = 'a2ui-e2e-fake';
    const surfacePart = {
      type: 'surface_update',
      surfaceId: 'render-test',
      catalogId: BASIC_CATALOG_ID,
      messages: [
        { version: 'v0.9', createSurface: { surfaceId: 'render-test', catalogId: BASIC_CATALOG_ID } },
        {
          version: 'v0.9',
          updateComponents: {
            surfaceId: 'render-test',
            components: [
              { id: 'root', component: 'Card', child: 'col' },
              { id: 'col', component: 'Column', children: ['title', 'btn'] },
              { id: 'title', component: 'Text', text: { path: '/greeting' } },
              { id: 'btn', component: 'Button', child: 'btnLbl' },
              { id: 'btnLbl', component: 'Text', text: 'Click me' }
            ]
          }
        },
        { version: 'v0.9', updateDataModel: { surfaceId: 'render-test', value: { greeting: 'Hello A2UI!' } } }
      ]
    };

    await page.route('**/api/sessions', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            { id: sessionId, title: 'a2ui-render', mode: 'chat', status: 'idle', agentId: 'general' }
          ]
        })
      });
    });
    await page.route(new RegExp(`/api/sessions/${sessionId}(?:\\?|$)`), (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session: { id: sessionId, title: 'a2ui-render', mode: 'chat', status: 'idle', agentId: 'general' },
          messages: [
            {
              role: 'tool',
              parts: [
                { type: 'tool_result', toolCallId: 'c1', name: 'a2ui_render', ok: true, content: 'Surface render-test updated' },
                surfacePart
              ]
            }
          ],
          latestAssistant: ''
        })
      });
    });

    await page.goto('/#/chat');
    // Click into the (intercepted) session in the sidebar
    await page.getByRole('button', { name: /a2ui-render/ }).first().click();

    await page.locator('summary').filter({ hasText: '已收起 1 条过程' }).click();
    await page.locator('summary.chat-tool-fold__summary').filter({ hasText: 'a2ui_render' }).click();

    // The Text "Hello A2UI!" comes from the data model via { path: '/greeting' }.
    await expect(page.locator('.a2ui-surface').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Hello A2UI!')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Click me' })).toBeVisible();
  });
});
