import { expect, type Locator, type Page } from '@playwright/test';

/** Center the row and press it before revealing the drop target. `dragTo` scrolls after mouse-down, so a partly visible row drags whichever neighbor sits under that point. */
export async function dragSessionRow(page: Page, row: Locator, target: Locator) {
  await row.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const source = await row.boundingBox();
  expect(source).toBeTruthy();
  const start = { x: source!.x + 24, y: source!.y + source!.height / 2 };
  expect(await row.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return !!hit && (hit === element || element.contains(hit));
  }, start)).toBe(true);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y, { steps: 4 });
  await target.scrollIntoViewIfNeeded();
  const drop = await target.boundingBox();
  expect(drop).toBeTruthy();
  await page.mouse.move(drop!.x + Math.min(40, drop!.width / 2), drop!.y + Math.min(12, drop!.height / 2), { steps: 12 });
  await page.mouse.up();
}
