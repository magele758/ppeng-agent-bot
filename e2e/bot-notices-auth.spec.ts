import { expect, test } from '@playwright/test';

test('recover a stalled login check [AC:lab-auth-loading-recovery#AC-1]', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/me', async route => {
    await pending;
    await route.fulfill({ json: { loginRequired: true, providers: ['google'] } }).catch(() => {});
  });
  await page.goto('/');
  try {
    const retry = page.getByTestId('auth-retry');
    await expect(retry).toBeVisible({ timeout: 14000 });
    release();
    await retry.click();
    await expect(page.locator('.login-card')).toBeVisible();
  } finally { release(); }
});

test('document can recover before hydration [AC:lab-auth-loading-recovery#AC-2]', async ({ browser, baseURL }) => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    const response = await page.goto(baseURL!);
    expect(response?.headers()['cache-control']).toMatch(/no-store|no-cache/);
    await expect(page.locator('noscript')).toBeVisible();
    expect(await page.locator('body').innerText()).toContain('此页面需要 JavaScript');
    await expect(page.locator('form[data-auth-reload] button')).toBeVisible({ timeout: 14000 });
  } finally { await page.close(); }
});

test('enable, receive, open and disable desktop notices [AC:bot-browser-notices#AC-1] [AC:bot-browser-notices#AC-2] [AC:bot-browser-notices#AC-3]', async ({ page }) => {
  const bot = { id: 'notice-bot', name: 'Echo', canonicalSessionId: 'notice-chat', agentId: 'general' };
  const session = { id: bot.canonicalSessionId, title: 'Echo', mode: 'chat', status: 'idle', agentId: 'general', metadata: { botId: bot.id, canonicalBotChat: true } };
  let completed = 2;
  let status = 'idle';
  let polls = 0;
  await page.addInitScript(() => {
    class DesktopNotice {
      static permission = 'default';
      static async requestPermission() { this.permission = 'granted'; return 'granted'; }
      onclick?: () => void;
      close() {}
      constructor(title: string) {
        document.documentElement.dataset.noticeTitle = title;
        document.documentElement.dataset.notices = String(Number(document.documentElement.dataset.notices || 0) + 1);
        Object.assign(window, { clickLatestNotice: () => this.onclick?.() });
      }
    }
    Object.defineProperty(window, 'Notification', { value: DesktopNotice });
  });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/bot-work/status') {
      polls++;
      return route.fulfill({ json: { bots: [{ bot, sessionId: session.id, status, taskCounts: { completed } }] } });
    }
    const replies: Record<string, unknown> = { '/api/auth/me': { loginRequired: false }, '/api/bot-functional-groups': { groups: [] }, '/api/bots': { bots: [bot] }, '/api/sessions': { sessions: [session] }, '/api/bot-work/default': { bot, session }, '/api/sessions/notice-chat': { session, messages: [] } };
    return route.fulfill(replies[path] ? { json: replies[path] } : { status: 503, json: { error: 'offline' } });
  });
  await page.goto('/#/settings/general');
  const toggle = page.getByTestId('desktop-notices-toggle');
  await expect(toggle).toBeVisible();
  await expect.poll(() => polls).toBeGreaterThan(0);
  await toggle.click();
  const initial = polls;
  await expect.poll(() => polls).toBeGreaterThan(initial + 1);
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-notices', /.+/);
  completed++;
  await expect(html).toHaveAttribute('data-notices', '1');
  status = 'waiting_approval';
  await expect(html).toHaveAttribute('data-notices', '2');
  await expect(html).toHaveAttribute('data-notice-title', /Echo/);
  await page.evaluate(() => (window as Window & { clickLatestNotice(): void }).clickLatestNotice());
  await expect(page).toHaveURL(/#\/bot/);
  await page.goto('/#/settings/general');
  await toggle.click();
  completed++;
  const stopped = polls;
  await expect.poll(() => polls).toBeGreaterThan(stopped + 1);
  await expect(html).not.toHaveAttribute('data-notices', '3');
});

test('a blocked site permission keeps notifications off [AC:bot-browser-notices#AC-2]', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lab.desktopNotices', 'previous');
    Object.defineProperty(window, 'Notification', { value: { permission: 'denied' } });
  });
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'offline' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { loginRequired: false } }));
  await page.goto('/#/settings/general');
  const toggle = page.getByTestId('desktop-notices-toggle');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});
