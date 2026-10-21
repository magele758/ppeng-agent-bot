import { expect, type APIRequestContext, type Page } from '@playwright/test';

export type LabBot = {
  id: string;
  name: string;
  agentId: string;
  canonicalSessionId: string;
  hidden?: boolean;
};

/**
 * The shared Lab already has Bot messages. This makes the open page treat the
 * account as not having sent one, so a new-user guide can appear.
 */
export async function presentAsNewBotUser(page: Page) {
  await page.route(/\/api\/sessions\/[^/?]+\/history(?:\?|$)/, route => {
    const url = route.request().url();
    if (route.request().method() === 'GET' && /(?:\?|&)role=user(?:&|$)/.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ messages: [], hasMore: false, nextCursor: null })
      });
    }
    return route.continue();
  });
}

/** Tests own their Bots and never borrow or hide a pre-existing user's Bot. */
export async function allocateBot(request: APIRequestContext, _options?: { exclusive?: boolean }): Promise<{ bot: LabBot; release: () => Promise<void> }> {
  const response = await request.post('/api/bots', { data: { name: `First guide ${crypto.randomUUID()}` } });
  expect(response.status(), await response.text()).toBe(201);
  const { bot } = await response.json() as { bot: LabBot };
  return { bot, release: async () => { const hidden = await request.patch(`/api/bots/${bot.id}`, { data: { hidden: true } }); expect(hidden.ok(), await hidden.text()).toBeTruthy(); } };
}

export async function openFirstBot(page: Page, id: string) {
  await page.addInitScript(id => {
    if (!localStorage.getItem('lab.selectedBot')) localStorage.setItem('lab.selectedBot', id);
  }, id);
  await page.goto('/#/bot');
}
