import { expect, test } from '@playwright/test';

const ASK_REASON = 'Approval required for ask_user (permissionMode=auto)';

test('pending approval sits in the transcript beside the waiting tool [AC:chat-approval-inline#AC-1] [AC:chat-approval-inline#AC-2] [AC:chat-approval-inline#AC-3]', async ({
  page
}) => {
  const sessionId = 'approval-inline-e2e';
  const session = {
    id: sessionId,
    title: 'approval-inline',
    mode: 'chat',
    status: 'waiting_approval',
    agentId: 'general'
  };
  const approval = {
    id: 'apr-ask-1',
    toolName: 'ask_user',
    sessionId,
    status: 'pending',
    reason: ASK_REASON,
    args: {},
    createdAt: '2026-10-15T00:00:00Z'
  };
  await page.route('**/api/sessions', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [session] })
    });
  });
  await page.route(`**/api/sessions/${sessionId}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session,
        messages: [
          {
            role: 'assistant',
            parts: [
              { type: 'tool_call', toolCallId: 'ask-1', name: 'ask_user', input: { question: '' } }
            ]
          }
        ],
        latestAssistant: ''
      })
    });
  });
  await page.route('**/api/approvals**', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ approvals: [approval] })
    });
  });
  await page.route(`**/api/sessions/${sessionId}/ask-user/reply`, (route) => {
    void route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /approval-inline/ }).first().click();

  const feed = page.locator('#playMessages');
  const banner = feed.locator('.approval-banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('.chat-panel > .approval-banner')).toHaveCount(0);
  await expect(banner).toHaveAttribute('aria-label', '待审批');
  await expect(banner.getByText(ASK_REASON, { exact: true })).toHaveCount(1);

  const toolName = feed.locator('.chat-tool-fold__name', { hasText: 'ask_user' });
  await expect(toolName).toBeVisible();
  const toolBox = await toolName.boundingBox();
  const bannerBox = await banner.boundingBox();
  expect(toolBox).toBeTruthy();
  expect(bannerBox).toBeTruthy();
  expect(bannerBox!.y).toBeGreaterThan(toolBox!.y);

  const replyBox = banner.locator('textarea.ask-user-reply');
  await expect(replyBox).toBeVisible();
  const replyButton = banner.getByRole('button', { name: '回复并继续' });
  await expect(replyButton).toBeDisabled();
  await replyBox.fill('用第一个');
  await expect(replyButton).toBeEnabled();

  const replyCall = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().includes('/ask-user/reply')
  );
  const approveCall = page.waitForRequest(
    (req) => req.method() === 'POST' && req.url().includes('/api/approvals/apr-ask-1/approve')
  );
  await replyButton.click();
  expect((await replyCall).postDataJSON()).toEqual({ reply: '用第一个' });
  await approveCall;

  await expect(banner.getByRole('button', { name: '拒绝' })).toBeVisible();
});
