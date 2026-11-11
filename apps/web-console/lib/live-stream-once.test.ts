import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoryWindow, omitStreamTextSavedOnTurn, liveAnswerRepeated, unpersistedAssistantText } from './history-window.ts';

const answer = '正在写的这一段助手回复';
const older = '上一答已经写好了';

function user(id: string, text: string) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistant(id: string, text: string, seq?: number) {
  return { id, seq, role: 'assistant', parts: [{ type: 'text', text }] };
}

function textSegment(raw: string) {
  return { kind: 'text' as const, id: 's-live', raw, html: `<p>${raw}</p>` };
}

test('已保存的当前回复不再和流式气泡各画一遍 [AC:stream-text-once#AC-1]', () => {
  const messages = [
    assistant('old', older, 1),
    user('ask', '新问题'),
    assistant('live', answer, 3)
  ];
  const segments = [textSegment(answer), { kind: 'tool' as const, id: 's-tool', toolCallId: 'c1', name: 'read_file', args: '{}' }];
  const before = segments.map((segment) => ({ ...segment }));

  assert.equal(liveAnswerRepeated(messages, segments), false);
  const shown = omitStreamTextSavedOnTurn(messages, segments);
  assert.equal(shown.some((segment) => segment.kind === 'text' && segment.raw === answer), false);
  assert.equal(shown.some((segment) => segment.kind === 'tool'), true);
  assert.deepEqual(segments, before);

  const stillStreaming = [assistant('old', older), user('ask', '新问题')];
  assert.equal(omitStreamTextSavedOnTurn(stillStreaming, [textSegment(answer)])[0]?.raw, answer);
  assert.equal(
    omitStreamTextSavedOnTurn(
      [assistant('old', answer), user('again', '再问一次')],
      [textSegment(answer)]
    )[0]?.raw,
    answer
  );
});

test('快照刷新不会把正在流的内容贴到更早的回复上 [AC:stream-text-once#AC-2]', () => {
  const previous = [assistant('old', older, 11), user('ask', '新问题', 12)];
  const incoming = [...previous, assistant('live', answer, 13)];
  const merged = mergeHistoryWindow(previous, incoming, true);
  const old = merged.messages.find((message) => message.id === 'old');

  assert.equal(old?.parts?.[0]?.text, older);
  assert.equal(JSON.stringify(old).includes(answer), false);
  assert.equal(liveAnswerRepeated(merged.messages, [textSegment(answer)]), false);
  assert.equal(merged.messages.filter((message) => message.id === 'live').length, 1);
});

test('saved identity hides text reasoning and tools while identical next-shot prose remains [AC:night-runtime-reliability#AC-2]',()=>{
  const messages=[user('ask','inspect'),assistant('saved','same')];
  const segments=[{...textSegment('same'),messageId:'saved'},
    {kind:'reasoning',id:'reason',text:'thinking',messageId:'saved'},
    {kind:'tool',id:'tool',toolCallId:'c1',name:'read_file',args:'{}',messageId:'saved'},
    {...textSegment('same'),id:'new',messageId:''}];
  assert.deepEqual(omitStreamTextSavedOnTurn(messages,segments).map(s=>s.id),['new']);
});

test('盖章后历史还没有这行时，相同正文只显示一次 [AC:night-runtime-reliability#AC-6]', () => {
  const pending = [user('ask', 'inspect')];
  const segments = [
    { ...textSegment('same'), messageId: 'saved' },
    { ...textSegment('same'), id: 'new', messageId: '' }
  ];
  assert.equal(omitStreamTextSavedOnTurn(pending, segments).filter((segment) => segment.kind === 'text').length, 1);
  const landed = [user('ask', 'inspect'), assistant('saved', 'same')];
  assert.deepEqual(omitStreamTextSavedOnTurn(landed, segments).map((segment) => segment.id), ['new']);
});

test('没有身份时，正文相同的未保存新内容仍然可见 [AC:night-runtime-reliability#AC-7]', () => {
  const messages = [user('ask', 'inspect'), assistant('saved', 'same')];
  const echo = { kind: 'text' as const, id: 'echo', raw: 'same', html: 'same' };
  const next = { kind: 'text' as const, id: 'next', raw: 'same', html: 'same' };
  assert.deepEqual(omitStreamTextSavedOnTurn(messages, [echo, next]).map((segment) => segment.id), ['next']);
  assert.equal(unpersistedAssistantText(messages, [echo, next]), 'same');
});
