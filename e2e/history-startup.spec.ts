import { expect, test } from '@playwright/test';

test('opened Bot shows history while the task list is pending [AC:history-startup-contention#AC-3]', async ({ page }) => {
  const bot = { id: 'history-bot', name: 'History', agentId: 'general', canonicalSessionId: 'history-chat' };
  const session = { id: bot.canonicalSessionId, title: bot.name, status: 'idle', mode: 'chat', agentId: bot.agentId, metadata: { botId: bot.id, canonicalBotChat: true } };
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'offline' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { loginRequired: false } }));
  const opened = page.waitForResponse(r => r.url().endsWith('/api/bots/history-bot/open'));
  const tasks = page.waitForRequest(r => r.url().endsWith('/api/tasks'));
  await page.route('**/api/bot-work/default', route => route.fulfill({ json: { bot } }));
  await page.route('**/api/bots/history-bot/open', route => route.fulfill({ json: { bot, session } }));
  await page.route('**/api/bots', route => route.fulfill({ json: { bots: [bot] } }));
  await page.route(url => url.pathname === '/api/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route(url => url.pathname === '/api/sessions/history-chat', route => route.fulfill({ json: {
    session, messages: [{ id: 'msg', seq: 1, role: 'user', parts: [{ type: 'text', text: 'Previously saved message' }] }]
  } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/tasks', async route => { await pending; await route.fulfill({ json: { tasks: [] } }); });
  try {
    await page.goto('/#/bot');
    await Promise.all([opened, tasks]);
    await expect(page.locator('.chat-bubble').filter({ hasText: 'Previously saved message' }).first()).toBeVisible({ timeout: 5000 });
  } finally {
    release();
  }
});
