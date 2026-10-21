import { test, expect, type Page } from '@playwright/test';
import { allocateBot, openFirstBot, presentAsNewBotUser } from './helpers/bot-first-task';

async function selectBot(page: Page, id: string) {
  await page.locator(`#sessionListMini [data-bot-id="${id}"] .list-item--session`).click();
}

const guideOf = (page: Page) => page.getByTestId('bot-first-task');
const composerOf = (page: Page) => page.getByTestId('composer-drop-target');

test('a new user sees the first-task guide on the first empty Bot and can choose or type a goal [AC:bot-first-task-new-user#AC-1] [AC:low-interference-onboarding-goals#AC-2]', async ({ page, request }) => {
  await presentAsNewBotUser(page);
  const held = await allocateBot(request);
  try {
    await openFirstBot(page, held.bot.id);
    await selectBot(page, held.bot.id);
    const guide = guideOf(page);
    const input = page.locator('#playInput');
    let sends = 0;
    page.on('request', req => { if (req.method() === 'POST' && /\/messages/.test(req.url())) sends += 1; });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('让 Bot 完成第一件事');
    await expect(guide).toContainText('可以直接说明目标');
    await guide.getByRole('button', { name: '整理我提供的材料', exact: true }).click();
    await expect(input).toHaveValue(/材料/);
    expect(sends).toBe(0);
    await input.fill('把本周安排整理成三件事');
    await expect(input).toHaveValue('把本周安排整理成三件事');
    await expect(guide).toBeVisible();
    expect(sends).toBe(0);
  } finally {
    await held.release();
  }
});

test('the first-task guide does not follow a new user onto another empty Bot [AC:bot-first-task-new-user#AC-2]', async ({ page, request }) => {
  await presentAsNewBotUser(page);
  const first = await allocateBot(request);
  const second = await allocateBot(request);
  const third = await allocateBot(request);
  try {
    await openFirstBot(page, first.bot.id);
    await selectBot(page, first.bot.id);
    await expect(guideOf(page)).toBeVisible();
    await selectBot(page, second.bot.id);
    await expect(page.locator('#playTitle')).toHaveText(second.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guideOf(page)).toHaveCount(0);
    await selectBot(page, third.bot.id);
    await expect(page.locator('#playTitle')).toHaveText(third.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guideOf(page)).toHaveCount(0);
  } finally {
    await first.release();
    await second.release();
    await third.release();
  }
});

test('the first-task guide and composer draft survive refresh and re-entry [AC:bot-first-task-new-user#AC-3]', async ({ page, request }) => {
  await presentAsNewBotUser(page);
  const bot = await allocateBot(request);
  const other = await allocateBot(request);
  try {
    await openFirstBot(page, bot.bot.id);
    await selectBot(page, bot.bot.id);
    const guide = guideOf(page);
    const input = page.locator('#playInput');
    await expect(guide).toBeVisible();
    await input.fill('这份草稿要留下来');
    await page.reload();
    await expect(page.locator('#playTitle')).toHaveText(bot.bot.name);
    await expect(guide).toBeVisible();
    await expect(input).toHaveValue('这份草稿要留下来');
    await page.locator('#nav-settings').click();
    await page.locator('#nav-bot').click();
    await expect(page.locator('#playTitle')).toHaveText(bot.bot.name);
    await expect(guide).toBeVisible();
    await expect(input).toHaveValue('这份草稿要留下来');
    await selectBot(page, other.bot.id);
    await expect(page.locator('#playTitle')).toHaveText(other.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
    await selectBot(page, bot.bot.id);
    await expect(page.locator('#playTitle')).toHaveText(bot.bot.name);
    await expect(guide).toBeVisible();
    await expect(input).toHaveValue('这份草稿要留下来');
  } finally {
    await bot.release();
    await other.release();
  }
});

test('an account that already messaged a Bot never sees the first-task guide on a new empty Bot [AC:bot-first-task-new-user#AC-4] [AC:low-interference-onboarding-goals#AC-1] [AC:low-interference-onboarding-goals#AC-2]', async ({ page, request }) => {
  const previous = await allocateBot(request);
  const sent = await request.post(`/api/sessions/${previous.bot.canonicalSessionId}/messages`, { data: { message: 'Previous user conversation', autoRun: false } });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const held = await allocateBot(request);
  try {
    await openFirstBot(page, held.bot.id);
    await selectBot(page, held.bot.id);
    const guide = guideOf(page);
    const composer = composerOf(page);
    await expect(page.locator('#playTitle')).toHaveText(held.bot.name);
    await expect(composer).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#playTitle')).toHaveText(held.bot.name);
    await expect(composer).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
    await page.locator('#nav-settings').click();
    await page.locator('#nav-bot').click();
    await expect(page.locator('#playTitle')).toHaveText(held.bot.name);
    await expect(composer).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
  } finally {
    await held.release();
    await previous.release();
  }
});

test('closing the first-task guide keeps it off later empty Bots [AC:bot-first-task-new-user#AC-4] [AC:low-interference-onboarding-goals#AC-1] [AC:low-interference-onboarding-goals#AC-2]', async ({ page, request }) => {
  await presentAsNewBotUser(page);
  const first = await allocateBot(request);
  const second = await allocateBot(request);
  try {
    await openFirstBot(page, first.bot.id);
    await selectBot(page, first.bot.id);
    const guide = guideOf(page);
    const input = page.locator('#playInput');
    await expect(guide).toBeVisible();
    await input.fill('关闭后这份草稿还在');
    await guide.getByRole('button', { name: '关闭首次任务引导', exact: true }).click();
    await expect(guide).toHaveCount(0);
    await expect(input).toHaveValue('关闭后这份草稿还在');
    await page.reload();
    await expect(page.locator('#playTitle')).toHaveText(first.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
    await selectBot(page, second.bot.id);
    await expect(page.locator('#playTitle')).toHaveText(second.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#playTitle')).toHaveText(second.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
    await page.locator('#nav-settings').click();
    await page.locator('#nav-bot').click();
    await expect(page.locator('#playTitle')).toHaveText(second.bot.name);
    await expect(composerOf(page)).toHaveAttribute('data-first-task', 'hidden');
    await expect(guide).toHaveCount(0);
  } finally {
    await first.release();
    await second.release();
  }
});
