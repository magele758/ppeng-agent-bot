import { test, expect } from '@playwright/test';
const SOFT_BOT_SILHOUETTES = ['pebble', 'squish', 'capsule', 'cloud', 'drop', 'bean', 'nub', 'pillow'];
const SOFT_BOT_COLORS = ['butter', 'peach', 'coral', 'blush', 'lilac', 'sky', 'mint', 'sage'];
const SOFT_BOT_EXPRESSIONS = ['neutral', 'happy', 'curious', 'sleepy', 'wink', 'content', 'wide', 'shy'];

test('all picker soft shapes persist through the real API [AC:bot-soft-create-runtime#AC-1]', async ({ request }) => {
  for (const [i, faceShape] of SOFT_BOT_SILHOUETTES.entries()) {
    const appearance = { faceStyle: 'soft', faceShape, faceColor: SOFT_BOT_COLORS[i], faceExpression: SOFT_BOT_EXPRESSIONS[i] };
    const response = await request.post('/api/bots', { data: { name: `Soft contract ${faceShape} ${Date.now()}`, ...appearance } });
    expect(response.status(), await response.text()).toBe(201);
    const { bot } = await response.json();
    const saved = await (await request.get(`/api/bots/${bot.id}`)).json();
    expect(saved.bot).toMatchObject(appearance);
  }
});

test('soft creation preview survives submit and reload [AC:bot-soft-create-runtime#AC-2]', async ({ page }) => {
  await page.goto('/#/agents/bots');
  await page.getByTestId('bot-create-open').click();
  const form = page.getByRole('form', { name: '新建 Bot', exact: true });
  await form.getByTestId('bot-create-name').fill(`Soft UI ${Date.now()}`);
  await form.getByRole('button', { name: '软萌机器人', exact: true }).click();
  const preview = form.locator('[data-soft-bot-face]').first();
  const shape = await preview.getAttribute('data-soft-bot-face');
  const color = await preview.getAttribute('data-soft-bot-color');
  const expression = await preview.getAttribute('data-soft-bot-expression');
  const pending = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/bots');
  await form.getByTestId('bot-create-submit').click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  const { bot } = await response.json();
  await expect(form).toHaveCount(0);
  await page.reload();
  const face = page.getByTestId(`bot-card-${bot.id}`).locator('[data-soft-bot-face]');
  await expect(face).toHaveAttribute('data-soft-bot-face', shape!);
  await expect(face).toHaveAttribute('data-soft-bot-color', color!);
  await expect(face).toHaveAttribute('data-soft-bot-expression', expression!);
});
