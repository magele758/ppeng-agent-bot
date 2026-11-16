import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { SidechatMessage, SidechatThread } from '@ppeng/api-types';

async function openReply(page: Page, request: APIRequestContext) {
  const title = 'Sidechat controls ' + crypto.randomUUID();
  const response = await request.post('/api/sessions', { data: { title, agentId: 'general', mode: 'chat' } });
  expect(response.ok()).toBeTruthy();
  const { session } = await response.json();
  const answer = await request.post('/api/sessions/' + session.id + '/messages', {
    data: { message: '请解释缓存。' }
  });
  expect(answer.ok()).toBeTruthy();
  await page.goto('/#/chat');
  await page.locator('#sessionListMini .list-item--session').filter({ hasText: title }).click();
  const wholeReply = page.getByTestId('sidechat-whole').last();
  await wholeReply.focus();
  await wholeReply.press('Enter');
  return { sid: session.id as string, wholeReply };
}

test('整条回复的草稿关闭后可续写，已保存的首问丢失回执后重试只产生一条讨论 [AC:sidechat#AC-1] [AC:sidechat#AC-6]', async ({
  page,
  request
}) => {
  const { sid, wholeReply } = await openReply(page, request);
  const input = page.getByTestId('sidechat-input');
  await input.fill('展开这里的解释');
  await input.press('Escape');
  await expect(page.getByTestId('sidechat-panel')).toBeHidden();
  await expect(wholeReply).toBeFocused();
  await wholeReply.press('Enter');
  await expect(input).toHaveValue('展开这里的解释');
  const path = '/api/sidechats?sessionId=' + encodeURIComponent(sid);
  expect((await (await request.get(path)).json()).items).toHaveLength(0);

  const requestIds: string[] = [];
  await page.route('**/api/sidechats', async (route) => {
    requestIds.push(route.request().postDataJSON().requestId);
    if (requestIds.length > 1) return route.continue();
    const ack = await route.fetch();
    expect(ack.ok()).toBeTruthy();
    await route.abort();
  });
  const send = page.getByTestId('sidechat-send');
  await send.click();
  await expect(page.getByTestId('sidechat-panel').getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('展开这里的解释');
  await send.click();
  await expect(page.getByTestId('sidechat-thread')).toHaveCount(1);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
  const { items } = await (await request.get(path)).json();
  expect(items).toHaveLength(1);
  const { messages } = await (await request.get('/api/sidechats/' + items[0].thread.id)).json();
  expect(messages.filter((message: SidechatMessage) => message.role === 'user')).toHaveLength(1);
});

test('手机侧栏停止正在展示的回复并重试，草稿和主回答保持独立 [AC:sidechat#AC-6]', async ({ page, request }) => {
  await openReply(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  // Hold the generation open for a deterministic stop, including while CI uses the instant heuristic model.
  const path = '/api/sidechats/sc-controlled';
  const ids: string[] = [];
  let turn: { thread: SidechatThread; messages: SidechatMessage[] };
  await page.route('**/api/sidechats', async (route) => {
    const body = route.request().postDataJSON();
    const at = new Date().toISOString();
    const base = { requestId: body.requestId, createdAt: at };
    turn = {
      thread: {
        id: 'sc-controlled',
        sessionId: body.sessionId,
        messageId: body.messageId,
        agentId: 'general',
        ordinal: 1,
        title: body.question,
        anchor: body.anchor,
        status: 'generating',
        createdAt: at,
        updatedAt: at
      },
      messages: [
        { ...base, role: 'user', id: 'u', status: 'complete', text: body.question },
        {
          ...base,
          role: 'assistant',
          id: 'a',
          status: 'generating',
          generationId: 'active-attempt',
          text: '部分回复'
        }
      ]
    };
    await route.fulfill({ json: turn });
  });
  await page.route('**' + path, (route) => route.fulfill({ json: turn }));
  await page.route('**' + path + '/stop', async (route) => {
    const { requestId, generationId } = route.request().postDataJSON();
    expect(generationId).toBe('active-attempt');
    expect(requestId).toBe(turn.messages[0]!.requestId);
    turn.thread.status = turn.messages[1]!.status = 'stopped';
    await route.fulfill({ json: turn });
  });
  await page.route('**' + path + '/retry', async (route) => {
    const { requestId, attemptId } = route.request().postDataJSON();
    expect(requestId).toBe(turn.messages[0]!.requestId);
    ids.push(attemptId);
    if (ids.length === 1) return route.abort();
    turn.thread.status = turn.messages[1]!.status = 'complete';
    turn.messages[1]!.text = '已完成补答';
    await route.fulfill({ json: turn });
  });

  const rail = page.getByTestId('sidechat-panel');
  const input = page.getByTestId('sidechat-input');
  await input.fill('独立追问');
  await page.getByTestId('sidechat-send').click();
  await rail.getByRole('button', { name: '停止', exact: true }).click();
  await expect(rail).toContainText('部分回复');
  await input.fill('下一条草稿');
  const retry = rail.getByRole('button', { name: '重试', exact: true });
  await retry.click();
  await expect(rail.getByRole('alert')).toBeVisible();
  await retry.click();
  await expect(rail).toContainText('已完成补答');
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBeTruthy();
  expect(ids[0]).toBe(ids[1]);
  await expect(input).toHaveValue('下一条草稿');
  await expect(page.locator('#playMessages')).not.toContainText('独立追问');
});

test('在另一端删除来源后，返回查找结果会清除旧预览和筛选项 [AC:sidechat#AC-3]', async ({ page, request }) => {
  const snapshot = await openReply(page, request);
  const title = 'Sidechat removed ' + crypto.randomUUID();
  const created = await request.post('/api/sessions', { data: { title, agentId: 'general', mode: 'chat' } });
  const { session } = await created.json();
  await request.post('/api/sessions/' + session.id + '/messages', { data: { message: '一句话解释缓存。' } });
  const record = await (await request.get('/api/sessions/' + session.id)).json();
  const source = record.messages.findLast((m: { role: string }) => m.role === 'assistant');
  const seed = await request.post('/api/sidechats', {
    data: { sessionId: session.id, messageId: source.id, anchor: { kind:'message',quote:'缓存' }, question:title, requestId:crypto.randomUUID() }
  });
  expect(seed.ok()).toBeTruthy();
  await page.getByTestId('sidechat-all').click();
  await page.getByRole('searchbox',{name:'搜索摘录、问题或回答'}).fill(title);
  const rail = page.getByTestId('sidechat-panel');
  await rail.locator('.sc-hit>button').filter({hasText:title}).click();
  await expect(rail.getByText(title,{exact:true}).first()).toBeVisible();
  expect((await request.delete('/api/sessions/' + session.id)).ok()).toBeTruthy();
  await rail.getByRole('button',{name:'返回查找结果'}).click();
  await expect(rail).toContainText('没有找到匹配的批注');
  await rail.getByText('筛选',{exact:true}).click();
  await expect(rail.locator('option').filter({hasText:title})).toHaveCount(0);
  expect((await request.get('/api/sessions/'+snapshot.sid)).ok()).toBeTruthy();
});
