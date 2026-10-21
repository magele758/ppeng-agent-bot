import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_FIRST_TASK_DISMISSED_KEY,
  BOT_FIRST_TASK_DISMISSED_PREFIX,
  botFirstTaskPhase,
  botOutreachTargets,
  findBotUserMessage,
  historyHasUserMessage,
  markBotFirstTaskSent,
  readBotFirstTaskDismissed,
  readBotFirstTaskDraft,
  readBotFirstTaskSent,
  writeBotFirstTaskDismissed,
  writeBotFirstTaskDraft,
  type FirstTaskStorage
} from './bot-first-task.ts';

function memoryStorage(initial: Record<string, string> = {}): FirstTaskStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; }
  };
}

test('a legacy per-bot dismissal counts as the guide already being closed', () => {
  const storage = memoryStorage({ [`${BOT_FIRST_TASK_DISMISSED_PREFIX}bot-a`]: '1' });
  assert.equal(readBotFirstTaskDismissed(storage), true);
  const fresh = memoryStorage();
  writeBotFirstTaskDismissed(fresh);
  assert.equal(fresh.getItem(BOT_FIRST_TASK_DISMISSED_KEY), '1');
  assert.equal(readBotFirstTaskDismissed(fresh), true);
});

test('drafts stay attached to the bot that showed the guide', () => {
  const storage = memoryStorage();
  writeBotFirstTaskDraft(storage, 'bot-a', '留下');
  assert.equal(readBotFirstTaskDraft(storage, 'bot-a'), '留下');
  assert.equal(readBotFirstTaskDraft(storage, 'bot-b'), null);
  markBotFirstTaskSent(storage);
  assert.equal(readBotFirstTaskSent(storage), true);
  assert.equal(readBotFirstTaskDraft(storage, 'bot-a'), null);
});

test('outreach checks recent canonical chats before the rest of the roster', () => {
  assert.deepEqual(botOutreachTargets(
    [
      { id: 'new-empty', metadata: { canonicalBotChat: true } },
      { id: 'older', metadata: { canonicalBotChat: true } },
      { id: 'room', metadata: { roomId: 'r1' } }
    ],
    [{ canonicalSessionId: 'older' }, { canonicalSessionId: 'unlisted' }],
    'current'
  ), ['new-empty', 'older', 'unlisted', 'current']);
});

test('a user message is enough to retire the new-user guide', () => {
  assert.equal(historyHasUserMessage([{ role: 'assistant' }]), false);
  assert.equal(historyHasUserMessage([{ role: 'user', parts: [{ type: 'text', text: '你好' }] }]), true);
});

test('the guide waits until the account check finishes, then stays on the first bot', () => {
  const base = {
    botId: 'bot-a',
    conversation: 'empty' as const,
    storageReady: true,
    dismissed: false,
    sent: false,
    accountSent: null,
    anchorBotId: null
  };
  assert.equal(botFirstTaskPhase(base), 'pending');
  assert.equal(botFirstTaskPhase({ ...base, accountSent: false }), 'visible');
  assert.equal(botFirstTaskPhase({ ...base, botId: 'bot-b', accountSent: false, anchorBotId: 'bot-a' }), 'hidden');
  assert.equal(botFirstTaskPhase({ ...base, accountSent: true }), 'hidden');
  assert.equal(botFirstTaskPhase({ ...base, dismissed: true, accountSent: false }), 'hidden');
  assert.equal(botFirstTaskPhase({ ...base, conversation: 'started', accountSent: false }), 'hidden');
  assert.equal(botFirstTaskPhase({ ...base, conversation: 'loading' }), 'pending');
});

test('finding one user message stops the account check', async () => {
  const seen: string[] = [];
  const result = await findBotUserMessage(['a', 'b', 'c'], async (id) => {
    seen.push(id);
    return id === 'b' ? 'yes' : 'no';
  }, () => false);
  assert.equal(result, 'yes');
  assert.equal(seen.includes('b'), true);
});
