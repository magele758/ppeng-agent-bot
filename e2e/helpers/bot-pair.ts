import { test as base, expect } from '@playwright/test';
import type { BotInfo } from '../../apps/web-console/lib/types';

/** Each check owns two visible Bots; earlier specs may hide or restyle their roster. */
export const test = base.extend<{ botPair: BotInfo[] }>({
  botPair: async ({ request }, use) => {
    const bots: BotInfo[] = [];
    const created: string[] = [];
    try {
      while (bots.length < 2) {
        const response = await request.post('/api/bots', { data: { name: `E2E-avatar-${crypto.randomUUID()}` } });
        expect(response.ok()).toBeTruthy();
        const { bot } = await response.json();
        bots.push(bot);
        created.push(bot.id);
      }
      await use(bots);
    } finally {
      for (const id of created) {
        const response = await request.patch(`/api/bots/${id}`, { data: { hidden: true } });
        expect(response.ok()).toBeTruthy();
      }
    }
  }
});

export { expect };
