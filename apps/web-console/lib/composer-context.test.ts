import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_TEXT_LIMIT,
  composerHasAttachments,
  contextSubmission,
  composerClassName,
  composerSendDisabled,
  contextLabelsFromMessage,
  contextSourcesBody,
  contextSourcesForSend,
  withContextIds,
  type ContextSource
} from './composer-context.ts';

test('composer submissions preserve attachment-only send and running-send guards', () => {
  const sources: ContextSource[] = [{ kind: 'file', name: 'note.txt', text: 'body' }];
  assert.equal(composerHasAttachments([], [], sources), true);
  assert.equal(composerHasAttachments(['image'], [], []), true);
  assert.equal(composerHasAttachments([], ['upload'], []), true);
  assert.equal(composerHasAttachments([], [], []), false);
  assert.deepEqual(contextSubmission('', []), { hasContent: false, message: '(attachment)' });
  assert.deepEqual(contextSubmission('', sources), { hasContent: true, message: '(attachment)' });
  assert.deepEqual(contextSubmission('hello', []), { hasContent: true, message: 'hello' });
  assert.equal(composerSendDisabled(false, false, true, ' ', []), true);
  assert.equal(composerSendDisabled(false, false, true, '', sources), false);
  assert.equal(composerSendDisabled(false, false, false, '', []), false);
  assert.equal(composerSendDisabled(true, false, false, 'hello', sources), true);
  assert.equal(composerSendDisabled(false, true, false, 'hello', sources), true);
  assert.equal(composerClassName('chat-composer', true), 'chat-composer chat-composer--ack-flash');
  assert.equal(composerClassName('play-group-composer', false), 'play-group-composer');
});

test('removed sources are absent from the send payload', () => {
  const sources: ContextSource[] = [
    { kind: 'file', name: 'keep.txt', text: 'keep' },
    { kind: 'folder', name: 'docs', entries: [{ path: 'a.txt', text: 'a' }] }
  ];
  const pending = withContextIds(sources);
  const kept = pending.filter((item) => item.name !== 'docs');
  assert.deepEqual(contextSourcesForSend(kept), [{ kind: 'file', name: 'keep.txt', text: 'keep' }]);
  assert.deepEqual(contextSourcesBody([]), {});
});

test('message labels render contextSources names and ignore a missing field', () => {
  assert.deepEqual(contextLabelsFromMessage({ role: 'user', parts: [] }), []);
  assert.deepEqual(contextLabelsFromMessage(null), []);
  assert.deepEqual(
    contextLabelsFromMessage({
      contextSources: [
        { kind: 'file', name: 'note.txt', text: 'x' },
        { kind: 'folder', name: 'docs', entries: [] },
        { kind: 'file', name: '   ' },
        { kind: 'other', name: 'nope' },
        null
      ]
    }),
    [
      { kind: 'file', name: 'note.txt' },
      { kind: 'folder', name: 'docs' }
    ]
  );
  assert.deepEqual(
    contextLabelsFromMessage({ metadata: { contextSources: [{ kind: 'folder', name: 'pack' }] } }),
    [{ kind: 'folder', name: 'pack' }]
  );
  assert.deepEqual(
    contextLabelsFromMessage({
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'please read',
          contextSources: [
            { kind: 'file', name: 'note.txt', text: 'file sentence' },
            { kind: 'folder', name: 'docs', entries: [{ path: 'readme.txt', text: 'nested' }] }
          ]
        },
        { type: 'text', text: 'fenced body without names' }
      ]
    }),
    [
      { kind: 'file', name: 'note.txt' },
      { kind: 'folder', name: 'docs' }
    ]
  );
});

test('pending contexts share one send budget and source count', async () => {
  const { limitContextSources } = await import('./composer-context.ts');
  const sources = Array.from({ length: 21 }, (_, index) => ({ kind: 'file' as const, name: `f${index}`, text: 'x'.repeat(11000), id: String(index) }));
  const result = limitContextSources(sources);
  assert.equal(result.truncated, true);
  assert.equal(result.sources.length, 20);
  assert.equal(result.sources.reduce((sum, source) => sum + (source.kind === 'file' ? source.text.length : 0), 0), CONTEXT_TEXT_LIMIT);
});
