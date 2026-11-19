import type { Page } from '@playwright/test';
import { test, expect } from './helpers/bot-pair';

async function holdInitialOpen(page: Page, remembered?: string) {
  if (remembered) await page.addInitScript(id => localStorage.setItem('lab.selectedBot', id), remembered);
  const path = remembered ? '/api/bots/' + remembered + '/open' : '/api/bot-work/default';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = page.waitForRequest(req => new URL(req.url()).pathname === path);
  await page.route('**' + path, async route => { await held; await route.continue(); }, { times: 1 });
  await page.goto(remembered ? '/#/bot' : '/', { waitUntil: 'domcontentloaded' });
  await requested;
  const composer = page.locator('.lab-shell [data-surface="bot"] #playInput');
  await composer.fill('Typed while opening');
  await expect(page.getByTestId('composer-bot-face')).toHaveCount(0);
  return { composer, release: async () => {
    const response = page.waitForResponse(res => new URL(res.url()).pathname === path);
    release();
    return (await (await response).json()).bot.name as string;
  } };
}

test('first visit binds the draft to the default Bot [AC:composer-draft-per-session#AC-4] [AC:lab-performance-regression-gate#AC-4]', async ({ page }) => {
  const opening = await holdInitialOpen(page);
  await expect(page.locator('#playTitle')).toHaveText(await opening.release());
  await expect(opening.composer).toHaveValue('Typed while opening', { timeout: 1500 });
});

test('remembered Bot adopts the opening draft and manual switches restore each draft [AC:composer-draft-per-session#AC-1] [AC:composer-draft-per-session#AC-2] [AC:composer-draft-per-session#AC-4] [AC:lab-performance-regression-gate#AC-4]', async ({ page, botPair: [first, second] }) => {
  const opening = await holdInitialOpen(page, first.id);
  await expect(page.locator('#playTitle')).toHaveText(await opening.release());
  await expect(opening.composer).toHaveValue('Typed while opening', { timeout: 1500 });
  const select = async (bot: typeof first) => {
    await page.locator('#sessionListMini [data-bot-id="' + bot.id + '"] .list-item--session').click();
    await expect(page.locator('#playTitle')).toHaveText(bot.name);
  };
  await select(second);
  await expect(opening.composer).toHaveValue('');
  await opening.composer.fill('Second draft');
  await select(first);
  await expect(opening.composer).toHaveValue('Typed while opening');
  await select(second);
  await expect(opening.composer).toHaveValue('Second draft');
});

test('manual selection supersedes a pending remembered Bot without claiming its input [AC:composer-draft-per-session#AC-1]', async ({ page, botPair: [first, second] }) => {
  const opening = await holdInitialOpen(page, first.id);
  await page.locator('#sessionListMini [data-bot-id="' + second.id + '"] .list-item--session').click();
  await expect(page.locator('#playTitle')).toHaveText(second.name);
  await expect(opening.composer).toHaveValue('');
  await opening.composer.fill('Second draft');
  await opening.release();
  await expect(page.locator('#playTitle')).toHaveText(second.name);
  await expect(opening.composer).toHaveValue('Second draft');
});

test('input delivered with the initial selection survives the same render [AC:composer-draft-per-session#AC-4] [AC:lab-performance-regression-gate#AC-4]', async ({ page }) => {
  // Deliver an input event after the open is accepted, before the new Bot paints.
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      write.call(this, key, value);
      if (key !== 'lab.selectedBot') return;
      Storage.prototype.setItem = write;
      queueMicrotask(() => {
        const field = document.querySelector<HTMLTextAreaElement>('#playInput')!;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(field, '同一帧输入');
        field.dispatchEvent(new InputEvent('input', { bubbles: true, data: '同一帧输入', inputType: 'insertText' }));
      });
    };
  });
  await page.goto('/');
  await expect(page.locator('#playTitle').getByTestId('bot-detail-toggle')).toBeVisible();
  await expect(page.locator('#playInput')).toHaveValue('同一帧输入', { timeout: 1500 });
});
