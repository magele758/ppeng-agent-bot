import { expect, test, type Page } from '@playwright/test';

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });

const title = 'Retina 中英文长会话名称 Reading a long conversation title without losing controls';
const text = '中英文正文阅读 Reading comfortably on a Retina display.\n第二行消息与标点，保持清晰可读。';

async function openChat(page: Page, theme = 'light', botView = false) {
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

async function minimumSize(page: Page, selector: string, minimum: number) {
  const sizes = await page.locator(selector).evaluateAll(elements => elements
    .filter(el => (el as HTMLElement).checkVisibility())
    .map(el => ({ element: `${el.tagName}.${el.className}`, size: parseFloat(getComputedStyle(el).fontSize) })));
  expect(sizes.length, selector).toBeGreaterThan(0);
  expect(sizes.filter(item => item.size < minimum), selector).toEqual([]);
}

async function expectControlLabelsFit(page: Page) {
  const clipped = await page.locator('button').evaluateAll(elements => elements.flatMap(button => {
    if (!button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return [];
    const bounds = button.getBoundingClientRect();
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const failures: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (!node.textContent?.trim() || parent.closest('svg, .sr-only') || !parent.checkVisibility()) continue;
      // Model names are intentionally ellipsized, like long session titles.
      if (getComputedStyle(parent).textOverflow === 'ellipsis') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ||
            rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
          failures.push(node.textContent);
        }
      }
    }
    return failures;
  }));
  expect(clipped).toEqual([]);
}

test('chat and composer are readable at native Retina density [AC:mac-retina-text-readability#AC-1]', async ({ page }) => {
  await openChat(page);
  await minimumSize(page, '.chat-bubble__body, .chat-bubble__md p, #playInput', 14);
  const lines = await page.locator('.chat-bubble__body').evaluateAll(elements => elements.map(el => {
    const style = getComputedStyle(el);
    return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
  }));
  for (const ratio of lines) expect(ratio).toBeGreaterThanOrEqual(1.5);
});

test('Bot page names controls and supporting copy remain legible in both themes [AC:mac-retina-text-readability#AC-2] [AC:mac-retina-text-readability#AC-3] [AC:console-font-size-preference#AC-5]', async ({ page }) => {
  await openChat(page, 'light', true);
  await minimumSize(page, '.session-item__title, .lab-rail__link', 13);
  await minimumSize(page, '#sessionListMini p, #sessionListMini h3, .session-item__meta', 12);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    for (const size of [13, 18]) {
      await page.evaluate(value => document.documentElement.setAttribute('data-font-size', String(value)), size);
      await expect.poll(() => contrastFailures(page), { message: `${theme} Bot ${size}px` }).toEqual([]);
    }
  }
});

test('navigation controls and supporting text meet the reading size floor [AC:mac-retina-text-readability#AC-2]', async ({ page }) => {
  await openChat(page);
  await minimumSize(page, '.session-item__title, .lab-rail__link, .composer-config-summary', 13);
  await minimumSize(page, '.session-item__meta, .session-date-group__label, .chat-turn__label', 12);
  await page.goto('/#/settings/general');
  await minimumSize(page, '#section-settings button, #section-settings select, #section-settings input, #section-settings label', 13);
});

// Composite text and background through ancestor opacity, including translucent surfaces.
async function contrastFailures(page: Page) {
  return page.locator('body *').evaluateAll(elements => {
    type Color = number[];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const color = (value: string): Color => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (fg: Color, bg: Color): Color => {
      const alpha = fg[3] + bg[3] * (1 - fg[3]);
      return [...[0, 1, 2].map(i => alpha ? (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha : 0), alpha];
    };
    const luminance = (rgb: Color) => rgb.slice(0, 3).map(c => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const failures: { element: string; text: string; ratio: number }[] = [];
    for (const el of elements) {
      if (!(el instanceof HTMLElement) || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (el.closest(':disabled, [aria-disabled="true"], svg, .sr-only') || ['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName)) continue;
      const directText = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
      const placeholder = el.matches('input, textarea') && el.getAttribute('placeholder');
      if (!directText && !placeholder && !el.matches('select')) continue;
      const style = getComputedStyle(el);
      let bg = color(style.backgroundColor);
      const textStyle = placeholder ? getComputedStyle(el, '::placeholder') : style;
      const ink = color(textStyle.color);
      if (placeholder) ink[3] *= Number(textStyle.opacity);
      let fg = over(ink, bg);
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        const current = getComputedStyle(node);
        bg[3] *= Number(current.opacity);
        fg[3] *= Number(current.opacity);
        const parentBg = node.parentElement ? color(getComputedStyle(node.parentElement).backgroundColor) : [255, 255, 255, 1];
        bg = over(bg, parentBg);
        fg = over(fg, parentBg);
      }
      const a = luminance(fg), b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) failures.push({ element: `${el.tagName}.${el.className}`, text: (directText || placeholder || '').slice(0, 50), ratio });
    }
    return failures;
  });
}

test('text including secondary labels and placeholders has contrast in both themes [AC:mac-retina-text-readability#AC-3] [AC:console-font-size-preference#AC-5]', async ({ page }) => {
  await openChat(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await expect.poll(() => contrastFailures(page), { message: `${theme} chat` }).toEqual([]);
    await page.goto('/#/settings/general');
    await expect(page.locator('#section-settings')).toBeVisible();
    await expect.poll(() => contrastFailures(page), { message: `${theme} settings` }).toEqual([]);
    await page.goto('/#/chat');
  }
});

test('larger text preserves long titles messages code and form controls [AC:mac-retina-text-readability#AC-4]', async ({ page }) => {
  await openChat(page);
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await minimumSize(page, '.chat-bubble__body, #playInput', 14);
    const code = page.locator('.chat-bubble__md pre');
    expect(await code.evaluate(el => el.scrollWidth > el.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expectControlLabelsFit(page);
    const bubbles = await page.locator('.chat-turn').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    for (let i = 1; i < bubbles.length; i++) expect(bubbles[i].top).toBeGreaterThanOrEqual(bubbles[i - 1].bottom);
    await page.locator('.composer-config-summary').click();
    await expect(page.locator('#composerConfigPanel')).toBeVisible();
    await expectControlLabelsFit(page);
    const clipped = await page.locator('#composerConfigPanel label, #composerConfigPanel select').evaluateAll(elements =>
      elements.filter(el => (el as HTMLElement).checkVisibility() && ['hidden', 'clip'].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).map(el => el.className));
    expect(clipped).toEqual([]);
    await page.locator('.composer-config-summary').click();
  }
});

test('200 percent desktop layout keeps reading typing and sending usable [AC:mac-retina-text-readability#AC-5]', async ({ page }) => {
  await openChat(page);
  // Emulate the CSS viewport at 200% desktop zoom; native browser zoom is a manual check.
  await page.setViewportSize({ width: 720, height: 500 });
  await minimumSize(page, '.chat-bubble__body, #playInput', 14);
  await expectControlLabelsFit(page);
  await page.getByLabel('消息内容').fill('放大后仍可编辑');
  await expect(page.getByLabel('消息内容')).toHaveValue('放大后仍可编辑');
  let sent = false;
  await page.route('**/api/sessions/retina-readability/stream', route => {
    sent = true;
    return route.fulfill({ status: 503, json: { error: 'Readability test: no upstream request' } });
  });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => sent).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
