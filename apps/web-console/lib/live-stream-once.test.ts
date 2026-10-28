import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoryWindow, omitStreamTextSavedOnTurn, liveAnswerRepeated } from './history-window.ts';

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
