import type { Page } from '@playwright/test';
import { test, expect } from './helpers/bot-pair';

async function pauseOpening(page: Page, botId: string) {
  const path = '/api/bots/' + botId + '/open';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === path);
  await page.route('**' + path, async route => { await held; await route.continue(); }, {times:1});
  return { requested, release, async finish() {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === path);
    release();
    await response;
  } };
}

test('returning to an empty Bot does not reveal a different Bot’s pending draft [AC:composer-draft-per-session#AC-1] [AC:composer-draft-per-session#AC-2] [AC:lab-performance-regression-gate#AC-4]', async ({page, request, botPair:[first]}) => {
  await page.addInitScript(id => localStorage.setItem('lab.selectedBot', id), first.id);
  const original = await pauseOpening(page, first.id);
  const draft = 'Private draft for the initially remembered Bot';
  let createdId: string | undefined;
  try {
    await page.goto('/#/bot', {waitUntil:'domcontentloaded'});
    await original.requested;
    const composer = page.locator('.lab-shell [data-surface="bot"] #playInput');
    await composer.fill(draft);
    await page.locator('#btnPlayCreate').click();
    await page.getByRole('menuitem',{name:'新建 Bot',exact:true}).click();
    const form = page.getByRole('form',{name:'新建 Bot'});
    const name = 'Draft-isolation-' + crypto.randomUUID();
    await form.getByTestId('bot-create-name').fill(name);
    const created = page.waitForResponse(res => new URL(res.url()).pathname === '/api/bots' && res.request().method() === 'POST');
    await form.getByTestId('bot-create-submit').click();
    const second = (await (await created).json()).bot;
    createdId = second.id;
    await expect(page.locator('#playTitle')).toHaveText(name);
    await expect(composer).toHaveValue('');
    await original.finish();

    await page.locator('#nav-chat').click();
    await expect(page.locator('.lab-shell [data-surface="chat"] #playInput')).toBeVisible();
    const reopened = await pauseOpening(page, second.id);
    try {
      await page.locator('#nav-bot').click();
      await reopened.requested;
      await expect(page.getByTestId('composer-bot-face')).toHaveCount(0);
      await expect(composer).toHaveValue('', {timeout:1500});
      await reopened.finish();
    } finally {
      reopened.release();
    }
    await expect(page.getByTestId('composer-bot-face')).toBeVisible();
    await expect(composer).toHaveValue('');
    const select = async (id: string, title: string) => {
      await page.locator('#sessionListMini [data-bot-id="' + id + '"] .list-item--session').click();
      await expect(page.locator('#playTitle')).toHaveText(title);
    };
    await select(first.id, first.name);
    await expect(composer).toHaveValue(draft);
    await select(second.id, name);
    await expect(composer).toHaveValue('');
  } finally {
    original.release();
    if (createdId) await request.patch('/api/bots/' + createdId, {data:{hidden:true}});
  }
});
