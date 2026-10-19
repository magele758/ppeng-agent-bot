import { test, expect } from './helpers/bot-pair';

test('list idle faces blink, peek and sway out of phase without moving rows [AC:bot-list-idle-motion#AC-1]', async ({ page, botPair }) => {
  expect(botPair.length).toBeGreaterThan(1);
  await page.route('**/api/bot-work/status', r => r.fulfill({ json: { bots: [] } }));
  await page.goto('/#/bot');
  const faces = page.locator('#sessionListMini .session-item__face svg.bot-face');
  await expect(faces.nth(1)).toBeVisible();
  const result = await faces.evaluateAll(nodes => nodes.slice(0, 2).map(face => {
    const row = face.closest('.list-item')!;
    const before = row.getBoundingClientRect().toJSON();
    const animations = face.getAnimations({ subtree: true });
    const names = animations.map(a => (a as CSSAnimation).animationName);
    const samples = Array.from({ length: 80 }, (_, index) => index * 110).map(time => {
      animations.forEach(a => { a.pause(); a.currentTime = time; });
      return ['[data-bob]', '[data-look]', '[data-eye]'].map(selector => getComputedStyle(face.querySelector(selector)!).transform);
    });
    return { names, samples, before, after: row.getBoundingClientRect().toJSON(), phase: getComputedStyle(face).getPropertyValue('--bot-face-idle-delay'), working: face.getAttribute('data-face-working') };
  }));
  for (const face of result) {
    expect(face.names).toEqual(expect.arrayContaining(['bot-face-idle-body', 'bot-face-idle-look', 'bot-face-idle-blink']));
    for (const index of [0, 1, 2]) expect(new Set(face.samples.map(sample => sample[index])).size).toBeGreaterThan(1);
    expect(face.after).toEqual(face.before);
    expect(face.working).toBe('false');
  }
  expect(result[0].phase).not.toEqual(result[1].phase);
});

test('reduced motion stops idle animation and retains working cues [AC:bot-list-idle-motion#AC-3]', async ({ page, botPair: bots }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/bot-work/status', r => r.fulfill({ json: { bots: bots.map((bot: { id: string }, i: number) => ({ bot, activeWorkCount: i === 0 ? 1 : 0 })) } }));
  await page.goto('/#/bot');
  const faces = page.locator('#sessionListMini .session-item__face svg.bot-face');
  await expect(faces.locator('[data-bob]').first()).toBeVisible();
  // Hydration/status changes can leave cancelled CSS animations in the browser's
  // animation list until its next rendering update. Wait for the observable state.
  await expect.poll(() => faces.evaluateAll(nodes => nodes.reduce((count, face) => count + face.getAnimations({ subtree: true }).length, 0))).toBe(0);
  const working = faces.filter({ has: page.locator('title') }).first();
  await expect(working).toHaveAttribute('data-face-working', 'true');
  await expect(working.locator('.bot-face__work-label')).toBeVisible();
});
