import { test, expect } from '@playwright/test';

// Inspect individual notice cards in full transcript; brief grouping has its own coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('lab.sessionBrief', '0'));
});

const BLOCKED_TEAMMATE = JSON.stringify({
  spawned: true,
  blocked: true,
  status: 'waiting_approval',
  teammateName: 'mate-e2e',
  teammateSessionId: 'sess-mate-e2e',
  blockedTools: ['bash'],
  approvalIds: ['apr-e2e-1'],
  approvals: [{ id: 'apr-e2e-1', tool: 'bash', reason: 'needs shell' }],
  remediation: 'Ask the user to approve it on the approvals page.'
});

test.describe('Blocked teammate result', () => {
  test('spawn_teammate blocked=true renders a prominent approval notice, other tools stay plain', async ({ page }) => {
    const sessionId = 'spawn-blocked-e2e';
    const session = { id: sessionId, title: 'spawn-blocked', mode: 'chat', status: 'idle', agentId: 'general' };
    await page.route('**/api/sessions', (route) => {
      void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [session] }) });
    });
    await page.route(new RegExp(`/api/sessions/${sessionId}(?:\\?|$)`), (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session,
          messages: [
            {
              role: 'tool',
              parts: [
                { type: 'tool_result', toolCallId: 'c1', name: 'spawn_teammate', ok: true, content: BLOCKED_TEAMMATE },
                { type: 'tool_result', toolCallId: 'c2', name: 'spawn_teammate', ok: true, content: 'Teammate mate-ok created' }
              ]
            }
          ],
          latestAssistant: ''
        })
      });
    });

    await page.goto('/#/chat');
    await page.getByRole('button', { name: /spawn-blocked/ }).first().click();

    await expect(page.locator('.chat-tool-fold__pill--blocked')).toHaveCount(1);
    const notice = page.locator('.spawn-blocked');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('被审批挡住');
    await expect(notice).toContainText('sess-mate-e2e');
    await expect(notice).toContainText('apr-e2e-1');
    await expect(notice).toContainText('Ask the user to approve it on the approvals page.');
    await expect(page.getByRole('button', { name: '复制审批 id' })).toBeVisible();
    await expect(page.locator('.spawn-blocked')).toHaveCount(1);
  });
});
