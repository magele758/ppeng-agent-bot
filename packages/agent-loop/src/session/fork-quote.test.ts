import { expect, it } from 'vitest';
import { createMemorySurfaceStore } from './surface-store.js';

it('nested WAL copies keep quotes bound to the corresponding child original [AC:bot-reply-quote#AC-5]', () => {
  const store = createMemorySurfaceStore();
  const parent = store.createSession({ title: 'parent', mode: 'chat', agentId: 'general' });
  const original = store.appendMessage(parent.id, 'assistant', [{ type: 'text', text: 'original body' }]);
  const quoted = store.appendMessage(parent.id, 'user', [{ type: 'text', text: 'explain' }], {
    replyTo: { messageId: original.id, excerpt: 'short quote' }
  });
  let from = parent.id;
  for (const title of ['child', 'grandchild']) {
    const child = store.createSession({ title, mode: 'chat', agentId: 'general' });
    expect(store.copyWalPrefix(from, child.id, 2)).toBe(2);
    const messages = store.foldMessages(child.id);
    expect(messages[1]!.replyTo).toEqual({ messageId: messages[0]!.id, excerpt: 'short quote' });
    expect(messages[0]!.id).not.toBe(original.id);
    expect(messages[1]!.replyTo).not.toBe(quoted.replyTo);
    from = child.id;
  }
  expect(store.foldMessages(parent.id)[1]!.replyTo?.messageId).toBe(original.id);
});
