import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function replicaName(id: string) {
  const bytes = Buffer.from('sand.client.slice.account.fixture.transcript.replicas.' + id);
  const bits = [...bytes].map(n => n.toString(2).padStart(8, '0')).join('');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return bits.match(/.{1,5}/g)!.map(chunk => alphabet[parseInt(chunk.padEnd(5, '0'), 2)]).join('') + '.blob';
}

test('local source opens ordered read-only history alongside a broken replica [AC:grok-local-history#AC-1] [AC:grok-local-history#AC-2] [AC:grok-local-history#AC-3]', async ({page}) => {
  const dir = await mkdtemp(join(tmpdir(), 'grok-lab-'));
  try {
    await writeFile(join(dir, replicaName('abcd1234-1234-1234-1234-123456789abc')), JSON.stringify({schemaVersion:1, value:{entries:[
      {kind:'message', role:'user', content:'fixture question', seq:1},
      {kind:'send-message', message:{type:'text',content:'fixture answer'}, seq:2},
    ]}}));
    await writeFile(join(dir, replicaName('abcd1234-1234-1234-1234-123456789abd')), '{');
    await writeFile(join(dir,'other.blob'), 'unrelated');
    await page.goto('/#/chat');
    await page.locator('#sessionListMini').getByRole('button', {name:'Grok Bot（本机）'}).click();
    const dialog = page.getByRole('dialog', {name:'Grok Bot（本机）'});
    await dialog.locator('input[type=file]').setInputFiles(dir);
    await expect(dialog.getByRole('status')).toContainText('1 个缓存文件');
    await dialog.getByRole('button', {name:'fixture question'}).click();
    await expect(dialog.getByRole('listitem')).toHaveText([/用户.*fixture question/, /Grok Bot.*fixture answer/]);
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await dialog.getByRole('button', {name:'返回会话列表'}).click();
    await expect(dialog.getByRole('button', {name:'fixture question'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});

test('reopens a previously authorized folder after reload', async ({page}) => {
  await page.addInitScript(({name}) => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, {create:true});
      const writer = await handle.createWritable();
      await writer.write(JSON.stringify({schemaVersion:1,value:{entries:[
        {kind:'message', role:'user', content:'remembered conversation'}
      ]}}));
      await writer.close();
      return root;
    }});
  }, {name: replicaName('abcd1234-1234-1234-1234-123456789abc')});
  await page.goto('/#/chat');
  const source = page.locator('#sessionListMini').getByRole('button', {name:'Grok Bot（本机）'});
  await source.click();
  await page.getByRole('button', {name:'选择缓存目录'}).click();
  const row = page.getByRole('button', {name:'remembered conversation'});
  await expect(row).toBeVisible();
  await page.reload();
  await source.click();
  await row.click();
  await expect(page.getByRole('listitem').filter({hasText:'remembered conversation'})).toBeVisible();
});

test('history source belongs to the conversation list [AC:bot-sidebar-routing#AC-2]', async ({ page }) => {
  await page.goto('/#/bot');
  await expect(page.getByTestId('functional-group-ungrouped')).toBeVisible();
  const source = page.locator('#sessionListMini').getByRole('button', { name: 'Grok Bot（本机）' });
  await expect(source).toHaveCount(0);
  await page.goto('/#/chat');
  await expect(source).toBeVisible();
});
