import { expect, test, type Page } from '@playwright/test';

async function openNetwork(page: Page) {
  const bots = ['Ada', 'Linus'].map(name => ({ id: name, name, agentId: 'general', canonicalSessionId: name }));
  await page.route('**/api/bots', route => route.fulfill({ json: { bots } }));
  await page.route('**/api/bot-rooms', route => route.fulfill({ json: { rooms: [] } }));
  const task = { id: 'test', requesterBotId: 'Ada', targetBotId: 'Linus', status: 'done',
    updatedAt: new Date().toISOString(), input: 'Review the sign-in flow' };
  await page.route('**/api/bot-work/tasks?limit=100', route => route.fulfill({ json: { tasks: [task], collaborations: [] } }));
  await page.goto('/#/tasks/flows?bot=Ada');
  const edge = page.getByRole('button', { name: 'Ada → Linus' });
  await expect(edge).toBeVisible();
  return edge;
}

test('pull back and inspect a handoff [AC:bot-network-motion#AC-1]', async ({ page }) => {
  const edge = await openNetwork(page);
  await expect(page.getByTestId('network-scene')).not.toHaveCSS('animation-name', 'none');
  await expect(edge.locator('path').first()).not.toHaveCSS('animation-name', 'none');
  await edge.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('handoff-preview')).toHaveText('Review the sign-in flow');
});

test('reduced motion retains the handoff [AC:bot-network-motion#AC-2]', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const edge = await openNetwork(page);
  await expect(page.getByTestId('network-scene')).toHaveCSS('animation-name', 'none');
  await expect(edge.locator('path').first()).toHaveCSS('animation-name', 'none');
  await edge.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('handoff-preview')).toBeVisible();
});
