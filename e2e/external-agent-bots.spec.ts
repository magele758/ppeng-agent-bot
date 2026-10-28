import {test,expect} from '@playwright/test';

test('Lab configures inbound Bot grants and scoped remote connections in both languages [AC:external-agent-bots#AC-3]',async({page,request})=>{
 const inboundPath='/api/external-agents/settings', remotePath='/api/external-agents/connections';
 const before=(await (await request.get(inboundPath)).json()).settings;
 const remoteBefore=(await (await request.get(remotePath)).json()).settings;
 const bots=(await (await request.get('/api/bots')).json()).bots;
 const bot=bots[0];expect(bot).toBeTruthy();
 const id=`peer-${Date.now()}`,token=`remote-${crypto.randomUUID()}`;
 try {
  await page.addInitScript(()=>{if(!localStorage.getItem('lab.locale'))localStorage.setItem('lab.locale','zh');});
  await page.goto('/#/settings/integrations');
  const inbound=page.locator('#card-externalAgents');
  await inbound.getByRole('button',{name:'添加接入方',exact:true}).click();
  const client=inbound.locator('[data-external-agent-client]').last();
  await client.getByLabel('接入方标识',{exact:true}).fill(id);
  await client.getByLabel('名称',{exact:true}).fill('Test client');
  await client.getByLabel('接入凭证',{exact:true}).fill(token);
  await client.getByLabel('允许的 Bot',{exact:true}).fill(bot.id);
  await inbound.getByRole('button',{name:'保存',exact:true}).click();
  await expect(inbound.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  const card=page.locator('#card-externalAgentConnections');
  await card.getByRole('button',{name:'添加远端连接',exact:true}).click();
  const row=card.locator('[data-external-agent-connection]').last();
  await row.getByLabel('连接标识',{exact:true}).fill(id);
  await row.getByLabel('名称',{exact:true}).fill('Test peer');
  await row.getByLabel('服务地址',{exact:true}).fill('https://peer.example.com');
  await row.getByLabel('远端凭证',{exact:true}).fill(token);
  await row.getByLabel('允许调用的本地 Bot',{exact:true}).fill(bot.id);
  await row.getByLabel('远端目标标识',{exact:true}).fill('remote-worker');
  await card.getByRole('button',{name:'保存',exact:true}).click();
  await expect(card.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  await expect(row.getByLabel('远端凭证',{exact:true})).toHaveValue('');
  await page.reload();
  await expect(card.locator('[data-external-agent-connection]').last().getByLabel('服务地址',{exact:true})).toHaveValue('https://peer.example.com');
  const saved=(await (await request.get(remotePath)).json()).settings;
  expect(JSON.stringify(saved)).not.toContain(token);
  await page.evaluate(()=>localStorage.setItem('lab.locale','en'));
  await page.reload();
  await expect(card.getByRole('button',{name:'Add remote connection',exact:true})).toBeVisible();
  await expect(inbound.getByLabel('Allowed Bots',{exact:true}).last()).toHaveValue(bot.id);
 } finally {await request.patch(inboundPath,{data:before});await request.patch(remotePath,{data:remoteBefore});}
});
