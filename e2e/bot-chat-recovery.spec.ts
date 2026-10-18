import { test, expect } from '@playwright/test';

test('accepted group messages survive refresh failure and sending can recover [AC:bot-chat-image-compatibility#AC-3]', async ({ page }) => {
  const room = { id: 'recovery-probe', title: 'Recovery probe', botIds: [], status: 'active' };
  const messages: object[] = [];
  let failRefresh = false;
  let rejectFirst = true;
  let posts = 0;
  await page.route('**/api/bot-rooms', r => r.fulfill({ json: { rooms: [room] } }));
  await page.route('**/api/bot-rooms/recovery-probe', r => r.fulfill({ json: { room } }));
  await page.route('**/api/bot-rooms/recovery-probe/turns', r => r.fulfill({ json: { turns: posts ? [] : [{ id: 'previous-failure', status: 'failed', terminationReason: 'member_execution_failed' }] } }));
  await page.route('**/api/bot-rooms/recovery-probe/messages*', r => {
    if (r.request().method() === 'POST') {
      if (rejectFirst) { rejectFirst = false; return r.fulfill({ status: 503, json: { error: 'temporarily unavailable' } }); }
      posts++;
      const message = { id: `probe-${posts}`, seq: posts, sender: { type: 'user', id: 'probe', name: 'Me' }, text: r.request().postDataJSON().text };
      messages.push(message);
      failRefresh = true;
      return r.fulfill({ status: 202, json: { message } });
    }
    if (failRefresh) return r.fulfill({ status: 503, json: { error: 'refresh failed' } });
    return r.fulfill({ json: { messages, hasMore: false, nextCursor: null } });
  });
  await page.goto('/#/bot');
  await page.getByRole('button', { name: '打开群聊 Recovery probe', exact: true }).click();
  const panel = page.getByTestId('play-group-chat');
  const composer = panel.locator('textarea');
  await expect(composer).toBeEnabled();
  await expect(panel.getByRole('alert')).toContainText('你可以继续发送消息');
  await composer.fill('accepted once');
  await panel.getByTestId('play-group-send').click();
  await expect(panel).toContainText('消息没有发出');
  await expect(composer).toHaveValue('accepted once');
  expect(posts).toBe(0);
  await panel.getByTestId('play-group-send').click();
  await expect(composer).toHaveValue('');
  await expect(panel).not.toContainText('消息没有发出');
  expect(posts).toBe(1);
  failRefresh = false;
  await composer.fill('next message');
  await expect(panel.getByTestId('play-group-send')).toBeEnabled();
  await panel.getByTestId('play-group-send').click();
  await expect(composer).toHaveValue('');
  expect(posts).toBe(2);
});
