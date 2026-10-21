import { expect, test } from '@playwright/test';
import { openChat } from './font-fixture';
test.use({ viewport: { width: 1280, height: 950 } });
test('font defaults, options, instant update and draft preservation [AC:console-font-size-preference#AC-1] [AC:console-font-size-preference#AC-2] [AC:console-font-size-preference#AC-3]', async ({page}) => {
  await openChat(page);
  await expect(page.locator('#playInput')).toHaveCSS('font-size','14px');
  await page.locator('#playInput').fill('保留草稿');
  await page.getByRole('link',{name:'设置',exact:true}).click();
  const card=page.locator('#card-font-size');
  await expect(card).toBeVisible();
  await expect(card.locator('option')).toHaveText(['13px','14px（默认）','15px','16px','18px']);
  await expect(card.locator('.font-size-preview')).toContainText('Aa');
  await page.locator('#settingsSearch').fill('字体大小');
  await expect(card).toBeVisible();
  await page.locator('#settingsSearch').fill('');
  for(const size of [13,14,15,16,18]) {
    await card.getByRole('combobox',{name:'字体大小',exact:true}).selectOption(String(size));
    await expect(card.locator('.font-size-preview')).toHaveCSS('font-size',`${size}px`);
    await expect(card.getByRole('button')).toHaveCSS('font-size',`${size-1}px`);
    await page.getByRole('link',{name:'对话',exact:true}).click();
    await expect(page.locator('#playInput')).toHaveValue('保留草稿');
    await expect(page.locator('#playInput')).toHaveCSS('font-size',`${size}px`);
    await expect(page.locator('.chat-bubble__body').first()).toHaveCSS('font-size',`${size}px`);
    await page.getByRole('link',{name:'设置',exact:true}).click();
  }
  await page.getByRole('link',{name:'对话',exact:true}).click();
  await expect(page.locator('#playInput')).toHaveValue('保留草稿');
  await expect(page.locator('#playInput')).toHaveCSS('font-size','18px');
  await expect(page.locator('.chat-bubble__body').first()).toHaveCSS('font-size','18px');
});
test('saved font is applied before content and storage failure stays usable [AC:console-font-size-preference#AC-4]',async({page})=>{
  await page.addInitScript(()=>{if(!localStorage.getItem('lab.fontSize')) localStorage.setItem('lab.fontSize','15');});
  await openChat(page);
  await expect(page.locator('#playInput')).toHaveCSS('font-size','15px');
  await page.getByRole('link',{name:'设置',exact:true}).click();
  await page.locator('#card-font-size select').selectOption('18');
  await page.reload();
  await expect(page.locator('.font-size-preview')).toHaveCSS('font-size','18px');
  await page.getByRole('link',{name:'设置',exact:true}).click();
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('blocked');};});
  await page.locator('#card-font-size select').selectOption('13');
  await expect(page.locator('#card-font-size [role=alert]')).toBeVisible();
  await expect(page.locator('.font-size-preview')).toHaveCSS('font-size','13px');
});
test('keyboard reset and translated font controls [AC:console-font-size-preference#AC-6]',async({page})=>{
  await openChat(page);
  await page.getByRole('link',{name:'设置',exact:true}).click();
  const select=page.locator('#card-font-size select');
  await select.focus(); await select.press('ArrowDown'); await select.press('ArrowDown'); await select.press('ArrowDown'); await select.press('Tab');
  await expect(select).toHaveValue('18');
  await expect(page.getByRole('button',{name:'恢复默认',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue('14');
  await page.getByRole('button',{name:'English',exact:true}).first().click();
  await expect(page.locator('#card-font-size')).toContainText('Font size');
});
test('font extremes keep composer usable in narrow and desktop layouts [AC:console-font-size-preference#AC-5]',async({page})=>{
  await openChat(page);
  for(const width of [1280,640]) for(const size of [13,18]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/#/settings/general');
    await page.locator('#card-font-size select').selectOption(String(size));
    await page.goto('/#/chat');
    await page.locator('#playInput').fill('中英文 draft');
    const input=await page.locator('#playInput').boundingBox();
    const send=await page.locator('#btnSend').boundingBox();
    expect(input && send).toBeTruthy();
    expect(input!.x+input!.width).toBeLessThanOrEqual(send!.x+1);
    await expect(page.locator('#btnSend')).toBeVisible();
  }
});
