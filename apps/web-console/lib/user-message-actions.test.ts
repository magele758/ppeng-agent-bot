import test from 'node:test';
import assert from 'node:assert/strict';
import { retryMessageBody, runMessageRetry } from './user-message-actions.ts';

test('retry preserves selected text images and quote [AC:user-message-actions#AC-3]', () => {
 const message = { role: 'user' as const, parts: [{ type: 'text' as const, text: 'original' }, { type: 'image' as const, assetId: 'img-1', mimeType: 'image/png' }], replyTo: { messageId: 'm0', botId: 'bot', excerpt: 'quote' } };
 assert.deepEqual(retryMessageBody(message), { message: 'original', imageAssetIds: ['img-1'], attachmentIds: [], replyTo: message.replyTo });
});
test('retry lock rejects duplicates and stale sessions and releases after failure [AC:user-message-actions#AC-4]', async () => {
 const lock = { current: false }; let selected = 's1'; let count = 0; let release!: () => void;
 const ports = { lock, selected: () => selected, busy: () => false, run: async () => { count++; await new Promise<void>(r => { release = r; }); throw Error('offline'); } };
 const first = runMessageRetry(ports, 's1', { role: 'user', parts: [] });
 await runMessageRetry(ports, 's1', { role: 'user', parts: [] });
 assert.equal(count, 1); release(); await assert.rejects(first, /offline/); assert.equal(lock.current, false);
 selected = 's2'; await runMessageRetry(ports, 's1', { role: 'user', parts: [] }); assert.equal(count, 1);
 await runMessageRetry({ ...ports, busy: () => true }, 's2', { role: 'user', parts: [] }); assert.equal(count, 1);
});
