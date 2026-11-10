import { expect, test } from '@playwright/test';

test('cron input stays in its detail dialog [AC:cron-message-details#AC-1] [AC:cron-message-details#AC-2] [AC:cron-detail-markdown#AC-1]', async ({ page }) => {
  const bot = { id: 'radar', name: 'Radar', agentId: 'general', canonicalSessionId: 'radar-chat' };
  const session = { id: bot.canonicalSessionId, title: bot.name, mode: 'chat', status: 'idle', agentId: bot.agentId, metadata: { botId: bot.id, canonicalBotChat: true } };
  const body = '汇总五个平台\n' + '采集资料\n'.repeat(200) + '最后一条资料\nInput sources: 只读资料\n' +
    JSON.stringify({ day: '2026-11-09', week: [{ file: 'daily.md', excerpt: '## 汇总\n\n- 已完成\n\n| 平台 | 数量 |\n| --- | --- |\n| A | 3 |' }] }) + '\n资料结束';
  const messages = ['[cron:日报] ' + body, '正常的回复'].map((text, i) => ({
    id: 'm' + i, seq: i + 1, role: i ? 'assistant' : 'user', parts: [{ type: 'text', text }]
  }));
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const replies: Record<string, unknown> = {
      '/api/auth/me': { loginRequired: false }, '/api/bots': { bots: [bot] },
      '/api/sessions': { sessions: [session] }, '/api/bot-work/default': { bot, session },
      '/api/bots/radar/open': { bot, session }, '/api/sessions/radar-chat': { session, messages },
      '/api/sessions/radar-chat/history': { session, messages }
    };
    return route.fulfill(replies[pathname] ? { json: replies[pathname] } : { status: 503, json: { error: 'offline' } });
  });
  await page.goto('/#/bot');
  const feed = page.locator('#playMessages');
  await expect(feed).toContainText('正常的回复');
  await expect(feed).not.toContainText('最后一条资料', { timeout: 2000 });
  const trigger = feed.getByRole('button', { name: /日报/ });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /日报/ });
  await expect(dialog).toContainText('汇总五个平台');
  await expect(dialog).toContainText('最后一条资料');
  await expect(dialog.locator('.chat-turn, .chat-bubble')).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: '汇总' })).toBeVisible();
  await expect(dialog.getByRole('listitem')).toContainText('已完成');
  await expect(dialog.getByRole('cell', { name: '3' })).toBeVisible();
  await expect(dialog).toContainText('2026-11-09');
  await expect(dialog).toContainText('资料结束');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
