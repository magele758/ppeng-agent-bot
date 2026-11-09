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

test('drag both ways without activating the starting face [AC:bot-network-pan#AC-1]', async ({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await openNetwork(page);
  const view=page.getByTestId('network-viewport');
  const offset=()=>view.evaluate(el=>el.scrollLeft);
  const face=page.getByRole('button',{name:'Linus',exact:true});
  const box=await face.boundingBox();
  const start=await offset();
  await page.mouse.move(box!.x+10,box!.y+10);
  await page.mouse.down();
  await page.mouse.move(box!.x-100,box!.y+10,{steps:8});
  await page.mouse.up();
  expect(await offset()).toBeGreaterThan(start+90);
  await expect(face).toHaveAttribute('data-selected','false');
  await page.mouse.down();
  await page.mouse.move(box!.x+10,box!.y+10,{steps:8});
  await page.mouse.up();
  expect(Math.abs(await offset()-start)).toBeLessThan(3);
  await face.click();
  await expect(face).toHaveAttribute('data-selected','true');
});

test('unfocused panorama cycles observed handoffs among actual faces [AC:bot-network-pan#AC-2]',async({page})=>{
  const bots=['A','B','C','Idle'].map(name=>({id:name,name,canonicalSessionId:name,agentId:'general'}));
  await page.route('**/api/bots',r=>r.fulfill({json:{bots}}));
  await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[]}}));
  const tasks=['B','C'].map((targetBotId,i)=>({id:String(i),requesterBotId:'A',targetBotId,
    updatedAt:new Date(Date.now()-i*1000).toISOString(),input:'Review '+targetBotId,status:'done'}));
  await page.route('**/api/bot-work/tasks?limit=100',r=>r.fulfill({json:{tasks,collaborations:[]}}));
  await page.goto('/#/tasks/flows');
  const scene=page.getByTestId('network-scene');
  await expect(scene.getByRole('button',{name:'Idle',exact:true})).toBeVisible();
  const preview=scene.getByTestId('handoff-preview');
  await expect(preview).toHaveText('Review B');
  await expect(preview).toHaveText('Review C',{timeout:9500});
});
