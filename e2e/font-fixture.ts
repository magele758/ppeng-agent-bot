import { expect, type Page } from '@playwright/test';
const title = 'Retina 中英文长会话名称 Reading a long conversation title without losing controls';
const text = '中英文正文阅读 Reading comfortably on a Retina display.\n第二行消息与标点，保持清晰可读。';

export async function openChat(page: Page, theme = 'light', botView = false) {
  await page.addInitScript((value) => {
    localStorage.setItem('theme', value);
    localStorage.setItem('lab.locale', 'zh');
  }, theme);
  const session = { id: 'retina-readability', title, mode: 'chat', status: 'idle', agentId: 'general' };
  const bot = { id: 'retina-bot', name: title, agentId: 'general', canonicalSessionId: session.id };
  await page.route('**/api/bots', route => route.fulfill({ json: { bots: botView ? [bot] : [] } }));
  await page.route('**/api/bots/retina-bot/open', route => route.fulfill({ json: { bot, session } }));
  await page.route('**/api/bot-functional-groups', route => route.fulfill({ json: { groups: [] } }));
  await page.route('**/api/bot-rooms', route => route.fulfill({ json: { rooms: [] } }));
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route(/\/api\/sessions\/retina-readability(?:\?|$)/, route => route.fulfill({
    json: {
      session,
      messages: [
        { role: 'user', parts: [{ type: 'text', text }] },
        { role: 'assistant', parts: [{ type: 'text', text: `${text}\n\n\`\`\`text\n${'long_code_identifier_'.repeat(30)}\n\`\`\`` }] }
      ],
      latestAssistant: text
    }
  }));
  await page.route('**/api/sessions/retina-readability/goal', route => route.fulfill({ json: { goal: null } }));
  await page.goto(botView ? '/#/bot' : '/#/chat');
  await page.locator('.session-item__title', { hasText: title }).click();
  await expect(page.locator('.chat-turn--assistant .chat-bubble__md')).toContainText('Reading comfortably');
}
