import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 1218, height: 1104 }, reducedMotion: 'reduce' });
const sid = 'polish-session';
const bot = { id: 'polish-bot', name: 'Polish Bot', agentId: 'general', canonicalSessionId: sid };
const session = { id: sid, title: bot.name, mode: 'chat', status: 'idle', agentId: 'general', metadata: { botId: bot.id, canonicalBotChat: true } };
const message = (id: string, text: string, role = 'assistant', key?: string, createdAt?: string) => ({ id, createdAt, seq: Number(id.replace(/\D/g, '')) || 1, role, parts: [{ type: 'text', text }], ...(key ? { key } : {}) });
async function setup(page: Page, messages = [message('m1', '这是一条可引用的回复。\n'.repeat(12))]) {
  await page.addInitScript(() => { localStorage.setItem('lab.locale', 'zh'); localStorage.setItem('theme', 'light'); });
  await page.route('**/api/bots', r => r.fulfill({ json: { bots: [bot] } }));
  await page.route('**/api/bots/polish-bot/open', r => r.fulfill({ json: { bot, session } }));
  await page.route('**/api/bot-functional-groups', r => r.fulfill({ json: { groups: [] } }));
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [] } }));
  await page.route(url => url.pathname === '/api/sessions', r => r.fulfill({ json: { sessions: [session] } }));
  await page.route(/\/api\/sessions\/polish-session(?:\?|$)/, r => r.fulfill({ json: { session, messages, latestAssistant: '' } }));
  await page.route('**/api/sessions/polish-session/goal', r => r.fulfill({ json: { goal: null } }));
  await page.goto('/#/bot');
  await page.locator('.session-item__title', { hasText: bot.name }).click();
  await expect(page.locator('#playInput')).toBeVisible();
}

test('composer items share one center line on desktop and narrow screens [AC:composer-quote-layout#AC-1]', async ({page}) => {
  await page.addInitScript(() => { (window as any).SpeechRecognition = class {}; });
  await setup(page);
  for (const width of [921,390]) {
    await page.setViewportSize({width,height:804});
    for (const draft of ['', '测试输入']) {
      await page.locator('#playInput').fill(draft);
      const centers = await page.locator('.chat-composer').evaluate(el => {
        const selectors=['.chat-composer__bot-face','.chat-composer__attach','#playInput','.chat-mic-btn','.chat-send-btn'];
        return selectors.map(selector=>{const node=el.querySelector(selector)!;const r=node.getBoundingClientRect();return {selector,y:r.y+r.height/2};});
      });
      const ys=centers.map(c=>c.y);
      expect(Math.max(...ys)-Math.min(...ys),JSON.stringify(centers)).toBeLessThanOrEqual(1.5);
    }
    await page.screenshot({path:`/tmp/composer-aligned-${width}.png`});
  }
});

test('quote controls float without a blank row and preserve drafts [AC:composer-quote-layout#AC-2] [AC:composer-quote-layout#AC-3]', async ({page}) => {
  await setup(page,[message('m1','第一条简短回复。'),message('m2','第二条简短回复。')]);
  const turn=page.locator('.chat-turn--assistant').last();
  const actions=turn.locator('.chat-turn__actions');
  await expect(actions).toHaveCSS('position','static');
  const bubble=(await turn.locator('.chat-bubble').boundingBox())!;
  const bar=(await actions.boundingBox())!;
  expect(bar.y).toBeGreaterThanOrEqual(bubble.y+bubble.height-1);
  await page.locator('#playInput').fill('保留草稿');
  const quote=turn.getByTestId('reply-quote-start');
  await expect(quote).toHaveCSS('opacity','1');
  await expect(page.locator('.chat-turn--assistant').first().getByTestId('reply-quote-start')).toHaveCount(0);
  await quote.click();
  await expect(page.getByTestId('composer-reply-quote')).toBeVisible();
  await expect(page.locator('#playInput')).toHaveValue('保留草稿');
  await page.getByTestId('composer-reply-quote-cancel').click();
  await page.mouse.move(0,0);
  await quote.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('composer-reply-quote')).toBeVisible();
});

test('all parts of a bot reply share one action row at the end [AC:whole-reply-hover#AC-1] [AC:turn-end-actions#AC-1] [AC:turn-end-actions#AC-3]', async ({page}) => {
  const endedAt = '2026-11-10T07:50:00Z';
  await setup(page, [
    message('m1', '检查进度', 'user'),
    message('m2', '已读取配置。'),
    message('m3', '工具记录', 'tool'),
    message('m4', '检查完成。', 'assistant', undefined, endedAt),
    message('m5', '下一题', 'user'),
    message('m6', '另一条回复。')
  ]);
  const quotes = page.getByTestId('reply-quote-start');
  await expect(quotes).toHaveCount(2);
  await expect(page.locator('.chat-turn--assistant', { hasText: '已读取配置。' }).getByTestId('reply-quote-start')).toHaveCount(0);
  const done = page.locator('.chat-turn--assistant', { hasText: '检查完成。' });
  const quote = done.getByTestId('reply-quote-start');
  await expect(quote).toHaveCSS('opacity', '1');
  const actions = done.locator('.chat-turn__actions');
  await expect(actions).toHaveCSS('position', 'static');
  await expect(actions.locator('time')).toHaveAttribute('datetime', endedAt);
  const bubble = (await done.locator('.chat-bubble').boundingBox())!;
  const bar = (await actions.boundingBox())!;
  expect(bar.y).toBeGreaterThanOrEqual(bubble.y + bubble.height - 1);
  await expect(actions.locator('.correction-capture__trigger')).toHaveCSS('opacity','1');
  await page.getByText('另一条回复。', {exact:true}).hover();
  await expect(quote).toHaveCSS('opacity','1');
  await quote.click();
  await expect(page.getByTestId('composer-reply-quote')).toContainText('已读取配置。 检查完成。');
});
