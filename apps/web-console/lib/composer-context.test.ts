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
  looksLikeBinary,
  readDroppedContext,
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
  assert.equal(composerClassName('chat-composer', true, true), 'chat-composer chat-composer--ack-flash is-drop-over');
  assert.equal(composerClassName('play-group-composer', false), 'play-group-composer');
});

test('text files keep their text and binary files keep only the name', async () => {
  const note = new File(['unique sentence'], 'note.txt', { type: 'text/plain' });
  const binary = new File([Uint8Array.from([0, 1, 2, 255, 0])], 'pic.bin', { type: 'application/octet-stream' });
  const result = await readDroppedContext({
    items: [
      { kind: 'file', getAsFile: () => note },
      { kind: 'file', getAsFile: () => binary }
    ]
  });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sources, [
    { kind: 'file', name: 'note.txt', text: 'unique sentence' },
    { kind: 'file', name: 'pic.bin', text: '' }
  ]);
});

test('a folder is read recursively and binary entries are not stuffed as text', async () => {
  const readme = fileEntry('readme.txt', 'folder sentence');
  const image = fileEntry('shot.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 10, 26]));
  const nested = directoryEntry('nested', [fileEntry('inner.md', 'inner sentence')]);
  const root = directoryEntry('docs', [readme, image, nested]);
  const result = await readDroppedContext({
    items: [{ kind: 'file', webkitGetAsEntry: () => root }]
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.kind, 'folder');
  if (result.sources[0]?.kind !== 'folder') return;
  assert.equal(result.sources[0].name, 'docs');
  assert.deepEqual(
    result.sources[0].entries.map((entry) => entry.path),
    ['readme.txt', 'shot.png', 'nested/inner.md']
  );
  assert.equal(result.sources[0].entries[0]?.text, 'folder sentence');
  assert.equal(result.sources[0].entries[1]?.text, '');
  assert.equal(result.sources[0].entries[2]?.text, 'inner sentence');
});

test('selected text, links, and empty drops add no context', async () => {
  const text = await readDroppedContext({
    items: [{ kind: 'string', type: 'text/plain' }]
  });
  const link = await readDroppedContext({
    items: [{ kind: 'string', type: 'text/uri-list' }]
  });
  const empty = await readDroppedContext({ items: [], files: [] });
  const blankName = await readDroppedContext({
    items: [{ kind: 'file', getAsFile: () => new File(['x'], '   ') }]
  });
  assert.deepEqual(text.sources, []);
  assert.deepEqual(link.sources, []);
  assert.deepEqual(empty.sources, []);
  assert.deepEqual(blankName.sources, []);
});

test('combined text is truncated around 200000 characters', async () => {
  const big = 'a'.repeat(CONTEXT_TEXT_LIMIT + 50);
  const result = await readDroppedContext({
    items: [{ kind: 'file', getAsFile: () => new File([big], 'big.txt') }]
  });
  assert.equal(result.truncated, true);
  assert.equal(result.sources[0]?.kind, 'file');
  if (result.sources[0]?.kind !== 'file') return;
  assert.equal(result.sources[0].name, 'big.txt');
  assert.equal(result.sources[0].text.length, CONTEXT_TEXT_LIMIT);
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

test('looksLikeBinary rejects null bytes and invalid text', () => {
  assert.equal(looksLikeBinary(new Uint8Array([0x68, 0x69])), false);
  assert.equal(looksLikeBinary(new Uint8Array([0x00, 0x01])), true);
  assert.equal(looksLikeBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 10])), true);
});

function fileEntry(name: string, contents: string | Uint8Array): FileSystemFileEntry {
  const file = typeof contents === 'string' ? new File([contents], name) : new File([contents], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    file: (success) => success(file)
  } as FileSystemFileEntry;
}

function directoryEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    createReader: () => {
      let pending = children;
      return {
        readEntries: (success: (entries: FileSystemEntry[]) => void) => {
          const batch = pending;
          pending = [];
          success(batch);
        }
      };
    }
  } as FileSystemDirectoryEntry;
}

test('multiple drops share one send budget and source count [AC:composer-drag-context#AC-3]', async () => {
  const { limitContextSources } = await import('./composer-context.ts');
  const sources = Array.from({ length: 21 }, (_, index) => ({ kind: 'file' as const, name: `f${index}`, text: 'x'.repeat(11000), id: String(index) }));
  const result = limitContextSources(sources);
  assert.equal(result.truncated, true);
  assert.equal(result.sources.length, 20);
  assert.equal(result.sources.reduce((sum, source) => sum + (source.kind === 'file' ? source.text.length : 0), 0), CONTEXT_TEXT_LIMIT);
});
