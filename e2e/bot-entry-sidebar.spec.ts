import { test, expect, type Locator, type Page } from '@playwright/test';

/** Center the row and press it before revealing the drop target. `dragTo` scrolls after mouse-down, so a partly visible row drags whichever neighbor sits under that point. */
async function dragSessionRow(page: Page, row: Locator, target: Locator) {
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

test.beforeAll(async ({ request }) => {
 const { bots } = await (await request.get('/api/bots')).json();
 for (let index = bots.filter((bot: { hidden?: boolean }) => !bot.hidden).length; index < 2; index++) {
  const response = await request.post('/api/bots', { data: { name: `Entry fixture ${Date.now()} ${index}` } });
  expect(response.ok()).toBeTruthy();
 }
});

test('one accessible New menu opens dedicated creation without losing the current view [AC:bot-entry-simplification#AC-1] [AC:bot-entry-simplification#AC-2]', async ({page}) => {
 await page.goto('/#/bot');
 const sidebar=page.locator('#panel-play.active .play-sidebar');
 await expect(sidebar.locator('.play-sidebar__head a')).toHaveCount(0);
 await expect(sidebar.getByTestId('play-group-create')).toHaveCount(0);
 const create=sidebar.locator('#btnPlayCreate'); await expect(create).toHaveText('新建');
 await create.hover(); await expect(sidebar.getByRole('menu')).toBeVisible();
 const itemBounds=await sidebar.getByRole('menuitem').first().boundingBox();expect(itemBounds).toBeTruthy();await page.mouse.move(itemBounds!.x+itemBounds!.width/2,itemBounds!.y+itemBounds!.height/2,{steps:20});await expect(sidebar.getByRole('menu')).toBeVisible();
 await expect(sidebar.getByRole('menuitem')).toHaveCount(3);
 await sidebar.getByRole('menuitem',{name:'新建 Bot',exact:true}).click();
 const dialog=page.getByRole('dialog'); await expect(dialog.getByTestId('bot-create')).toBeVisible();
 await expect(dialog.getByTestId('bot-group-create')).toHaveCount(0);
 await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(create).toBeFocused(); await expect(page).toHaveURL(/#\/bot$/);
 await create.focus(); await create.press('ArrowDown'); await expect(sidebar.getByRole('menuitem').first()).toBeFocused();
 await page.keyboard.press('Escape'); await expect(sidebar.getByRole('menu')).toHaveCount(0);
 await create.click(); await sidebar.getByRole('menuitem',{name:'新建群聊',exact:true}).click();
 await expect(dialog.getByTestId('bot-group-create')).toBeVisible(); await dialog.getByRole('button',{name:'取消',exact:true}).click();
 await create.click(); await sidebar.getByRole('menuitem',{name:'新建功能分组',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible(); await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
});

test('dedicated room and functional group creation report failures then show saved objects immediately [AC:bot-entry-simplification#AC-3]',async({page})=>{
 const {bots}=await (await page.request.get('/api/bots')).json(); expect(bots.length).toBeGreaterThan(1);
 const rooms: any[]=[];const groups: any[]=[];let fail=true;
 await page.route('**/api/bot-rooms',route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{rooms}});
  if(fail)return route.fulfill({status:503,json:{error:'Room unavailable'}});
  const room={...route.request().postDataJSON(),id:'entry-room',status:'active'};rooms.push(room);return route.fulfill({json:{room}});
 });
 await page.route('**/api/bot-functional-groups',route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{groups}});
  if(fail)return route.fulfill({status:503,json:{error:'Group unavailable'}});
  const group={...route.request().postDataJSON(),id:'entry-functional',botIds:[]};groups.push(group);return route.fulfill({json:{group}});
 });
 await page.goto('/#/bot');const newMenu=async(name:string)=>{await page.locator('#btnPlayCreate').click();await page.getByRole('menuitem',{name,exact:true}).click();};
 await newMenu('新建群聊');const dialog=page.getByRole('dialog');
 await dialog.getByTestId('bot-group-name').fill('Entry room');
 for(const bot of bots.slice(0,2))await dialog.getByTestId(`bot-group-member-${bot.id}`).check();
 await dialog.locator('button[type=submit]').click();await expect(dialog.getByRole('alert').filter({hasText:'Room unavailable'})).toBeVisible();expect(rooms).toHaveLength(0);
 fail=false;await dialog.locator('button[type=submit]').click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'打开群聊 Entry room',exact:true})).toBeVisible();expect(rooms).toHaveLength(1);
 fail=true;await newMenu('新建功能分组');await dialog.getByRole('textbox').fill('Entry functional');await dialog.locator('button[type=submit]').click();await expect(dialog.getByRole('alert')).toContainText('Group unavailable');expect(groups).toHaveLength(0);
 fail=false;await dialog.locator('button[type=submit]').click();await expect(dialog).toHaveCount(0);await expect(page.getByTestId('functional-group-entry-functional')).toContainText('Entry functional');expect(groups).toHaveLength(1);
});

test('Bot removal names its preserved data and failure preserves the Bot [AC:bot-entry-simplification#AC-7]',async({page})=>{
 const {bots}=await(await page.request.get('/api/bots')).json();const bot=bots.find((b:any)=>!b.hidden);expect(bot).toBeTruthy();let writes=0;let fail=true;let removed=false;
 await page.route('**/api/bots',route=>route.fulfill({json:{bots:bots.map((b:any)=>b.id===bot.id&&removed?{...b,hidden:true}:b)}}));
 await page.route(`**/api/bots/${bot.id}`,route=>{writes++;if(!fail)removed=true;return fail?route.fulfill({status:503,json:{error:'Removal unavailable'}}):route.fulfill({json:{bot:{...bot,hidden:true}}});});
 await page.goto('/#/bot');const remove=page.getByRole('button',{name:`移除 Bot「${bot.name}」`,exact:true});await expect(remove).toBeVisible();
 page.once('dialog',async d=>{expect(d.message()).toContain(bot.name);expect(d.message()).toContain('不会删除会话');await d.dismiss();});await remove.click();expect(writes).toBe(0);await expect(remove).toBeVisible();
 page.once('dialog',d=>d.accept());await remove.click();await expect(page.getByRole('alert').filter({hasText:'Removal unavailable'})).toBeVisible();await expect(remove).toBeVisible();
 fail=false;page.once('dialog',d=>d.accept());await remove.click();await expect(remove).toHaveCount(0);await expect(page.getByLabel(`移动 ${bot.name} 到功能分组`,{exact:true})).toHaveCount(0);expect(writes).toBe(2);
});

test('functional group deletion confirms retained members and preserves them on cancellation or failure [AC:bot-entry-simplification#AC-7]',async({page})=>{
 const {bots}=await(await page.request.get('/api/bots')).json();const bot=bots.find((b:any)=>!b.hidden);let exists=true;let fail=true;let writes=0;
 await page.route('**/api/bot-functional-groups**',route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{groups:exists?[{id:'remove-probe',name:'Remove probe',botIds:[bot.id]}]:[]}});
  writes++;if(fail)return route.fulfill({status:503,json:{error:'Group removal unavailable'}});exists=false;return route.fulfill({json:{ok:true}});
 });
 await page.goto('/#/bot');const group=page.getByTestId('functional-group-remove-probe');const remove=group.getByRole('button',{name:'删除功能分组',exact:true});await expect(group).toContainText(bot.name);
 page.once('dialog',async d=>{expect(d.message()).toContain('Remove probe');expect(d.message()).toContain('Bot 将回到未分组');await d.dismiss();});await remove.click();expect(writes).toBe(0);await expect(group).toBeVisible();
 page.once('dialog',d=>d.accept());await remove.click();await expect(page.getByRole('alert').filter({hasText:'Group removal unavailable'})).toBeVisible();await expect(group).toContainText(bot.name);
 fail=false;page.once('dialog',d=>d.accept());await remove.click();await expect(group).toHaveCount(0);await expect(page.getByTestId('functional-group-ungrouped')).toContainText(bot.name);expect(writes).toBe(2);
});


test('Bot rows have no move control or footer while chat and confirmed removal remain available [AC:bot-group-drag-only#AC-1]', async ({ page }) => {
 const { bots } = await (await page.request.get('/api/bots')).json();
 const bot = bots.find((item: { hidden?: boolean }) => !item.hidden);
 expect(bot).toBeTruthy();
 await page.goto('/#/bot');
 const row = page.locator('#sessionListMini [draggable="true"]').filter({ has: page.getByRole('button', { name: `移除 Bot「${bot.name}」`, exact: true }) });
 await expect(row).toHaveCount(1);
 await expect(page.getByRole('combobox', { name: /^移动 .* 到功能分组$/ })).toHaveCount(0);
 const chatRow = row.locator('.list-item--session');
 const wrapperBox = await row.boundingBox();
 const chatBox = await chatRow.boundingBox();
 expect(wrapperBox).toBeTruthy(); expect(chatBox).toBeTruthy();
 expect(Math.abs(wrapperBox!.height - chatBox!.height)).toBeLessThanOrEqual(1);
 await chatRow.click();
 await expect(page.locator('#playTitle')).toContainText(bot.name);
 let confirms = 0;
 page.once('dialog', async dialog => { confirms++; expect(dialog.message()).toContain(bot.name); await dialog.dismiss(); });
 await row.getByRole('button', { name: `移除 Bot「${bot.name}」`, exact: true }).click();
 expect(confirms).toBe(1);
 await expect(row).toBeVisible();
});

test('drag-only grouping persists successful moves and restores failed moves without losing the conversation [AC:bot-group-drag-only#AC-2]', async ({ page }) => {
 const { bots } = await (await page.request.get('/api/bots')).json();
 const bot = bots.find((item: { hidden?: boolean }) => !item.hidden);
 expect(bot).toBeTruthy();
 const { bot: defaultBot } = await (await page.request.get('/api/bot-work/default')).json();
 await page.addInitScript(id => localStorage.setItem('lab.selectedBot', id), defaultBot.id);
 const groups = [{ id: 'drag-source', name: 'Drag source', botIds: [bot.id] }, { id: 'drag-target', name: 'Drag target', botIds: [] as string[] }];
 let fail = false; let writes = 0;
 await page.route('**/api/bot-functional-groups', route => route.fulfill({ json: { groups } }));
 await page.route(`**/api/bots/${bot.id}/functional-group`, async route => {
  writes++;
  await new Promise(resolve => setTimeout(resolve, 300));
  if (fail) return route.fulfill({ status: 503, json: { error: 'Drag save unavailable' } });
  const groupId = route.request().postDataJSON().groupId;
  for (const group of groups) group.botIds = group.botIds.filter(id => id !== bot.id);
  groups.find(group => group.id === groupId)?.botIds.push(bot.id);
  return route.fulfill({ json: { bot } });
 });
 const openReadyPage = async (reload = false) => {
  // A visible sidebar can precede the default Bot's post-open overview refresh.
  // That refresh restores scroll position, which can move another row beneath
  // native drag coordinates. Wait for its selected-session hydration first.
  const opened = page.waitForResponse(response =>
   new URL(response.url()).pathname === `/api/bots/${defaultBot.id}/open`);
  const hydrated = page.waitForResponse(response =>
   new URL(response.url()).pathname === `/api/sessions/${defaultBot.canonicalSessionId}/artifacts`);
  await Promise.all([reload ? page.reload() : page.goto('/#/bot'), opened, hydrated]);
  await expect(page.locator('#playTitle')).toHaveText(defaultBot.name);
 };
 await openReadyPage();
 const source = page.getByTestId('functional-group-drag-source');
 const target = page.getByTestId('functional-group-drag-target');
 const ungrouped = page.getByTestId('functional-group-ungrouped');
 const rowIn = (container: typeof source) => container.locator(`[data-bot-id="${bot.id}"] .list-item--session`);
 const moveTo = async (from: typeof source, to: typeof source, groupId: string | null, status: number) => {
  // Observe all Bot moves so accidentally dragging a neighbouring row fails
  // with its actual identity, instead of timing out on an unrelated error.
  const moved = page.waitForResponse(response =>
   response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/functional-group'));
  const [, response] = await Promise.all([dragSessionRow(page, rowIn(from), to.locator('h3')), moved]);
  expect(new URL(response.url()).pathname).toBe(`/api/bots/${bot.id}/functional-group`);
  expect(response.request().postDataJSON()).toEqual({ groupId });
  expect(response.status()).toBe(status);
  await response.finished();
  await expect(to).toHaveAttribute('aria-busy', 'false');
 };
 await moveTo(source, target, 'drag-target', 200);
 await expect(rowIn(target)).toBeVisible();
 await expect.poll(() => groups[1].botIds).toContain(bot.id);
 await openReadyPage(true); await expect(rowIn(target)).toBeVisible();
 await moveTo(target, ungrouped, null, 200);
 await expect(rowIn(ungrouped)).toBeVisible();
 await expect.poll(() => groups[1].botIds).toEqual([]);
 await openReadyPage(true); await expect(rowIn(ungrouped)).toBeVisible();
 fail = true;
 await moveTo(ungrouped, source, 'drag-source', 503);
 await expect(page.getByRole('alert').filter({ hasText: 'Drag save unavailable' })).toBeVisible();
 await expect(rowIn(ungrouped)).toBeVisible(); await expect(rowIn(source)).toHaveCount(0);
 await rowIn(ungrouped).click(); await expect(page.locator('#playTitle')).toContainText(bot.name);
 expect((await page.request.get(`/api/sessions/${bot.canonicalSessionId}`)).ok()).toBeTruthy();
 expect(writes).toBe(3);
});

test('create dialog keeps actions visible while content scrolls and backdrop dismisses [AC:bot-entry-dialog-shell#AC-1] [AC:bot-entry-dialog-shell#AC-2] [AC:bot-entry-dialog-shell#AC-3] [AC:bot-entry-dialog-shell#AC-4] [AC:bot-entry-dialog-shell#AC-5]', async ({ page }) => {
 await page.setViewportSize({ width: 1000, height: 600 });
 await page.goto('/#/bot');
 const open = async () => {
  await page.locator('#btnPlayCreate').click();
  await page.getByRole('menuitem', { name: '新建 Bot', exact: true }).click();
 };
 await open();
 const dialog = page.getByRole('dialog');
 const actions = dialog.locator('.ag-form__actions');
 const before = await actions.boundingBox();
 expect(before).not.toBeNull();
 expect(before!.y + before!.height).toBeLessThanOrEqual(600);
 const scroll = dialog.locator('.ag-form__scroll');
 expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
 await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
 expect((await actions.boundingBox())!.y).toBeCloseTo(before!.y, 0);
 await dialog.locator('h2,h3').first().click();
 await expect(dialog).toBeVisible();
 expect(await page.locator('.bot-entry-backdrop').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0.6)');
 await page.mouse.click(5, 5);
 await expect(dialog).toHaveCount(0);
 await open();
 await page.keyboard.press('Escape');
 await expect(dialog).toHaveCount(0);
});

test('pressing and cancelling a Bot row gesture preserves the current conversation [AC:bot-group-drag-only#AC-2]', async ({ page, request }) => {
 const { bots } = await (await request.get('/api/bots')).json();
 const [current, other] = bots.filter((bot: { hidden?: boolean }) => !bot.hidden);
 expect(current).toBeTruthy(); expect(other).toBeTruthy();
 await page.addInitScript(id => localStorage.setItem('lab.selectedBot', id), current.id);
 await page.goto('/#/bot');
 const title = page.locator('#playTitle');
 await expect(title).toHaveText(current.name);
 const row = page.locator(`#sessionListMini [data-bot-id="${other.id}"] .list-item--session`);
 await expect(row).toHaveCount(1);
 await row.scrollIntoViewIfNeeded();
 const box = await row.boundingBox();
 expect(box).not.toBeNull();
 await page.mouse.move(box!.x + 12, box!.y + box!.height / 2);
 await page.mouse.down();
 try {
  // Allow React to commit any pointer handler before checking the unchanged view.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(title).toHaveText(current.name);
  await expect(row).not.toHaveClass(/\bselected\b/);
  // Releasing outside the row cancels the click, as with a cancelled drag.
  await page.mouse.move(1, 1, { steps: 5 });
 } finally {
  await page.mouse.up();
 }
 await expect(title).toHaveText(current.name);
 await row.click();
 await expect(title).toHaveText(other.name);
});

test('an explicit Bot click wins a delayed saved-default lookup [AC:bot-face-first-creation#AC-4]', async ({ page, request }) => {
 const { bots } = await (await request.get('/api/bots')).json();
 const [saved, chosen] = bots.filter((bot: { hidden?: boolean }) => !bot.hidden);
 expect(saved).toBeTruthy(); expect(chosen).toBeTruthy();
 let releaseLookup!: () => void;
 const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
 let lookupStarted!: () => void;
 const lookupSeen = new Promise<void>(resolve => { lookupStarted = resolve; });
 let savedOpens = 0;
 page.on('request', req => {
  if (new URL(req.url()).pathname === `/api/bots/${saved.id}/open`) savedOpens++;
 });
 await page.addInitScript(id => localStorage.setItem('lab.selectedBot', id), saved.id);
 await page.route(`**/api/bots/${saved.id}`, async route => {
  if (route.request().method() !== 'GET') return route.continue();
  lookupStarted();
  await lookupGate;
  await route.fulfill({ json: { bot: saved } });
 });
 try {
  await page.goto('/#/bot');
  await lookupSeen;
  const row = page.locator(`#sessionListMini [data-bot-id="${chosen.id}"] .list-item--session`);
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.locator('#playTitle')).toHaveText(chosen.name);
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === `/api/bots/${saved.id}`);
  releaseLookup();
  const response = await returned;
  await response.finished();
  // The loader's promise continuation runs before the following rendered frame.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(page.locator('#playTitle')).toHaveText(chosen.name);
  await expect(row).toHaveClass(/\bselected\b/);
  expect(savedOpens).toBe(0);
 } finally {
  releaseLookup();
 }
});
