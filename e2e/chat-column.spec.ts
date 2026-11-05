import { expect, test } from '@playwright/test';

test('对话列边缘和正文留白 [AC:chat-column#AC-1] [AC:chat-column#AC-2]', async ({ page }) => {
  await page.goto('/');
  await page.locator('.lab-shell').first().waitFor();
  const fixture = page.locator('#column-fixture');
  await page.evaluate(() => {
    const sample = document.createElement('div');
    sample.id = 'column-fixture';
    sample.className = 'lab-shell';
    sample.innerHTML = `<div class="chat-panel-body">
      <div class="chat-feed-shell"><div class="chat-feed"><div class="chat-feed__track">
        <div class="chat-bubble__body chat-bubble__md"><p>正文 <code>example.ts</code></p><p>下一段</p></div>
      </div></div></div>
      <div class="chat-composer-outer"><div class="session-recap-bar"><div class="session-recap">摘要</div></div>
        <div class="chat-composer"></div></div></div>`;
    sample.style.cssText = 'position:fixed;inset:0;display:block;height:400px';
    document.body.append(sample);
  });
  for (const width of [960, 480, 320]) {
    await fixture.evaluate((node, width) => { node.style.width = width + 'px'; }, width);
    const edges = await fixture.locator('.chat-feed__track,.session-recap,.chat-composer').evaluateAll(nodes =>
      nodes.map(node => [node.getBoundingClientRect().left, node.getBoundingClientRect().right]));
    expect(edges).toEqual([edges[0], edges[0], edges[0]]);
  }
  await expect(fixture.locator('code')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(fixture.locator('code')).toHaveCSS('border-top-width', '0px');
  const rhythm = await fixture.locator('p').first().evaluate(node => {
    const s = getComputedStyle(node);
    return [parseFloat(s.lineHeight), parseFloat(s.marginBottom)].map(px => px / parseFloat(s.fontSize));
  });
  expect(rhythm[0]).toBeGreaterThanOrEqual(1.8);
  expect(rhythm[1]).toBeGreaterThanOrEqual(1);
});
